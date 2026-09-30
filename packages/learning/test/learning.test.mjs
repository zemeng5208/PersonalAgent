import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {openSqliteLearningHost} from '../dist/index.js';

const context = () => ({deadline: '2099-01-01T00:00:00.000Z',
  signal: new AbortController().signal});

function proposal(revision, operationId, extra = {}) {
  return {...context(), namespace: 'personal', workflowId: 'morning-review',
    expectedRevision: revision === 1 ? null : revision - 1, operationId,
    summary: `Morning review v${revision}`, steps: ['Review calendar', 'Suggest priorities'],
    sourceRef: 'user-confirmed-example', createdAt: '2026-09-28T00:00:00.000Z',
    ...extra};
}

function activation(revision, expectedActiveRevision, operationId, extra = {}) {
  return {...context(), namespace: 'personal', workflowId: 'morning-review',
    revision, expectedActiveRevision, operationId,
    activatedAt: '2026-09-28T01:00:00.000Z', ...extra};
}

function databasePath(t) {
  const directory = mkdtempSync(join(tmpdir(), 'personal-agent-learning-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  return join(directory, 'learning.sqlite');
}

test('only validated candidates activate; prior validated version can be restored after restart', async t => {
  const path = databasePath(t);
  let host = openSqliteLearningHost(path);
  const first = host.propose(proposal(1, 'proposal-1'));
  assert.equal(first.validation, 'candidate');
  assert.equal(host.readActive('personal', 'morning-review'), null);
  assert.throws(() => host.activateVersion(activation(1, null, 'activate-unchecked')),
    {code: 'NOT_VALIDATED'});
  const rejected = await host.validate('personal', 'morning-review', 1,
    {validate: async () => ({passed: false, evidenceRef: 'test:failed-1'})}, context());
  assert.equal(rejected.validation, 'failed');
  assert.throws(() => host.activateVersion(activation(1, null, 'activate-rejected')),
    {code: 'NOT_VALIDATED'});

  host.propose(proposal(2, 'proposal-2'));
  const validated = await host.validate('personal', 'morning-review', 2,
    {validate: async candidate => {
      assert.equal(candidate.revision, 2);
      candidate.steps.push('Untrusted mutation');
      return {passed: true, evidenceRef: 'test:passed-2'};
    }}, context());
  assert.equal(validated.validation, 'passed');
  assert.equal(validated.steps.length, 2);
  assert.equal(host.readVersion('personal', 'morning-review', 2).steps.length, 2);
  const firstActivation = host.activateVersion(activation(2, null, 'activate-2'));
  assert.equal(host.readActive('personal', 'morning-review').revision, 2);
  assert.deepEqual(host.activateVersion(activation(2, null, 'activate-2')), firstActivation);
  assert.throws(() => host.activateVersion(activation(2, null, 'another-activation')),
    {code: 'REVISION_CONFLICT'});

  host.propose(proposal(3, 'proposal-3'));
  await host.validate('personal', 'morning-review', 3,
    {validate: async () => ({passed: true, evidenceRef: 'test:passed-3'})}, context());
  host.activateVersion(activation(3, 2, 'activate-3'));
  assert.equal(host.readActive('personal', 'morning-review').revision, 3);
  const rollback = host.activateVersion(activation(2, 3, 'rollback-to-2'));
  assert.deepEqual([rollback.fromRevision, rollback.toRevision], [3, 2]);
  host.close();

  host = openSqliteLearningHost(path);
  assert.equal(host.readActive('personal', 'morning-review').revision, 2);
  assert.deepEqual(host.activateVersion(activation(2, 3, 'rollback-to-2')), rollback);
  assert.equal(host.propose(proposal(2, 'proposal-2')).validation, 'passed');
  assert.throws(() => host.propose(proposal(2, 'proposal-2', {summary: 'Altered retry'})),
    {code: 'REVISION_CONFLICT'});
  assert.throws(() => host.activateVersion(activation(2, 3, 'rollback-to-2',
    {activatedAt: '2026-09-28T02:00:00.000Z'})), {code: 'REVISION_CONFLICT'});
  host.close();
});

test('validation failure does not mark a candidate as checked or activate it', async t => {
  const path = databasePath(t);
  const host = openSqliteLearningHost(path);
  host.propose(proposal(1, 'proposal-1'));
  await assert.rejects(host.validate('personal', 'morning-review', 1,
    {validate: async () => { throw new Error('validator unavailable'); }}, context()),
  /validator unavailable/);
  assert.equal(host.readVersion('personal', 'morning-review', 1).validation, 'candidate');
  assert.throws(() => host.activateVersion(activation(1, null, 'activate-1')),
    {code: 'NOT_VALIDATED'});
  host.close();
});

test('activation receipt failure rolls back the switch and scoped versions stay isolated', async t => {
  const path = databasePath(t);
  const host = openSqliteLearningHost(path);
  host.propose(proposal(1, 'proposal-1'));
  await host.validate('personal', 'morning-review', 1,
    {validate: async () => ({passed: true, evidenceRef: 'test:passed-1'})}, context());
  const db = new DatabaseSync(path);
  db.exec(`CREATE TRIGGER fail_activation BEFORE INSERT ON learning_activations
    BEGIN SELECT RAISE(ABORT, 'injected activation failure'); END`);
  assert.throws(() => host.activateVersion(activation(1, null, 'activate-1')),
    /injected activation failure/);
  assert.equal(host.readActive('personal', 'morning-review'), null);
  db.exec('DROP TRIGGER fail_activation');
  host.activateVersion(activation(1, null, 'activate-1'));
  assert.equal(host.readActive('other', 'morning-review'), null);
  assert.throws(() => host.readVersion('other', 'morning-review', 1), {code: 'NOT_FOUND'});
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM learning_activations').get().count, 1);
  db.close();
  host.close();
});

test('erasure removes all workflow versions and activation history without touching other workflows', async t => {
  const path = databasePath(t);
  let host = openSqliteLearningHost(path);
  host.propose(proposal(1, 'proposal-1'));
  await host.validate('personal', 'morning-review', 1,
    {validate: async () => ({passed: true, evidenceRef: 'test:passed-1'})}, context());
  host.activateVersion(activation(1, null, 'activate-1'));
  host.propose(proposal(2, 'proposal-2'));
  host.propose(proposal(1, 'unrelated-1', {workflowId: 'evening-review'}));
  assert.throws(() => host.eraseWorkflow({...context(), namespace: 'personal',
    workflowId: 'morning-review', expectedRevision: 1, operationId: 'erase-stale'}),
  {code: 'REVISION_CONFLICT'});
  host.eraseWorkflow({...context(), namespace: 'personal',
    workflowId: 'morning-review', expectedRevision: 2, operationId: 'erase-morning'});
  assert.equal(host.readActive('personal', 'morning-review'), null);
  assert.throws(() => host.readVersion('personal', 'morning-review', 1), {code: 'NOT_FOUND'});
  assert.equal(host.readVersion('personal', 'evening-review', 1).summary, 'Morning review v1');
  assert.throws(() => host.propose(proposal(3, 'proposal-after-erase')), {code: 'NOT_FOUND'});
  host.close();

  const db = new DatabaseSync(path);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM learning_versions
    WHERE workflow_id = 'morning-review'`).get().count, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM learning_activations
    WHERE workflow_id = 'morning-review'`).get().count, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM learning_versions
    WHERE workflow_id = 'evening-review'`).get().count, 1);
  db.close();

  host = openSqliteLearningHost(path);
  assert.doesNotThrow(() => host.eraseWorkflow({...context(), namespace: 'personal',
    workflowId: 'morning-review', expectedRevision: 2, operationId: 'erase-morning'}));
  assert.throws(() => host.eraseWorkflow({...context(), namespace: 'personal',
    workflowId: 'morning-review', expectedRevision: 2, operationId: 'other-operation'}),
  {code: 'REVISION_CONFLICT'});
  host.close();
});

test('busy WAL checkpoint makes workflow erasure retryable', t => {
  const path = databasePath(t);
  const host = openSqliteLearningHost(path);
  host.propose(proposal(1, 'proposal-1'));
  const reader = new DatabaseSync(path);
  reader.exec('PRAGMA busy_timeout = 100; BEGIN');
  reader.prepare('SELECT COUNT(*) AS count FROM learning_versions').get();
  const erase = {...context(), namespace: 'personal', workflowId: 'morning-review',
    expectedRevision: 1, operationId: 'erase-busy'};
  assert.throws(() => host.eraseWorkflow(erase), {code: 'STORAGE_UNAVAILABLE'});
  assert.throws(() => host.readVersion('personal', 'morning-review', 1), {code: 'NOT_FOUND'});
  reader.exec('ROLLBACK');
  reader.close();
  assert.doesNotThrow(() => host.eraseWorkflow(erase));
  host.close();
});
