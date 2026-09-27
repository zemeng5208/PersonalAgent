import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {MemoryQueryError} from '../dist/index.js';
import {openSqliteMemoryHost} from '../dist/sqlite.js';

const namespace = 'public-demo';
const key = {vaultId: 'public-demo-v1', path: 'starbridge.md', factId: 'starbridge/deliverable'};

function observation(letter, extra = {}) {
  return {
    ...key, sourceRevision: letter.repeat(64), line: 5,
    summary: `public deliverable ${letter}`,
    observedAt: '2026-09-24T00:00:00.000Z',
    validFrom: '2026-09-24T00:00:00.000Z',
    validUntil: '2027-01-01T00:00:00.000Z',
    expectedFactRevision: null,
    deadline: '2099-01-01T00:00:00.000Z',
    signal: new AbortController().signal,
    ...extra,
  };
}

function fails(code) {
  return error => error instanceof MemoryQueryError && error.code === code;
}

test('public source append is retry-safe across restart and concurrent stale observations', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'personal-agent-source-'));
  const path = join(directory, 'memory.sqlite');
  let host = openSqliteMemoryHost(path);
  let other = openSqliteMemoryHost(path);
  t.after(() => { host.close(); other.close(); rmSync(directory, {recursive: true, force: true}); });
  host.provision(namespace);
  assert.equal(host.readPublicSourceHead(namespace, key), null);

  const first = host.appendPublicSource(namespace, observation('a'));
  assert.equal(first.appended, true);
  assert.deepEqual(first.fact.ref, {id: key.factId, revision: 1});
  assert.throws(() => host.append(namespace, {...first.fact,
    ref: {id: key.factId, revision: 2}, corrects: first.fact.ref}),
  fails('INVALID_ARGUMENT'));
  assert.deepEqual(host.appendPublicSource(namespace, observation('a', {
    observedAt: '2026-09-25T00:00:00.000Z',
  })), {fact: first.fact, appended: false});
  assert.equal(other.readPublicSourceHead(namespace, key), 1);
  assert.throws(() => host.appendPublicSource(namespace, observation('a', {
    summary: 'changed without source revision',
  })), fails('INVALID_ARGUMENT'));

  const second = other.appendPublicSource(namespace, observation('b', {
    expectedFactRevision: 1,
  }));
  assert.deepEqual(second.fact.corrects, first.fact.ref);
  assert.throws(() => host.appendPublicSource(namespace, observation('c', {
    expectedFactRevision: 1,
  })), fails('REVISION_CONFLICT'));
  assert.deepEqual(host.appendPublicSource(namespace, observation('b', {
    expectedFactRevision: 1,
  })), {fact: second.fact, appended: false});

  host.close();
  host = openSqliteMemoryHost(path);
  assert.equal(host.readPublicSourceHead(namespace, key), 2);
  const third = host.appendPublicSource(namespace, observation('a', {
    expectedFactRevision: 2,
  }));
  assert.deepEqual(third.fact.ref, {id: key.factId, revision: 3});
  assert.deepEqual(third.fact.corrects, second.fact.ref);
  const history = await host.bind(namespace, {allowedSensitivities: ['public']}).listHistory({
    factId: key.factId, limit: 10, deadline: '2099-01-01T00:00:00.000Z',
    signal: new AbortController().signal,
  });
  assert.deepEqual(history.facts.map(fact => fact.ref.revision), [1, 2, 3]);
  assert.deepEqual(history.facts.map(fact => fact.sourceRef.slice(-64)),
    ['a'.repeat(64), 'b'.repeat(64), 'a'.repeat(64)]);
});

test('source identity cannot claim an existing fact or store unsafe paths', t => {
  const directory = mkdtempSync(join(tmpdir(), 'personal-agent-source-'));
  const host = openSqliteMemoryHost(join(directory, 'memory.sqlite'));
  t.after(() => { host.close(); rmSync(directory, {recursive: true, force: true}); });
  host.provision(namespace);
  assert.throws(() => host.appendPublicSource(namespace, observation('a', {
    path: '../private.md',
  })), fails('INVALID_ARGUMENT'));
  host.append(namespace, {
    ref: {id: key.factId, revision: 1}, summary: 'existing', sourceRef: 'other',
    observedAt: '2026-09-24T00:00:00.000Z', validFrom: '2026-09-24T00:00:00.000Z',
    validUntil: '2027-01-01T00:00:00.000Z', sensitivity: 'public',
    state: 'active', confirmation: 'external_observation',
  });
  assert.throws(() => host.appendPublicSource(namespace, observation('a')),
    fails('INVALID_ARGUMENT'));
  assert.equal(host.readPublicSourceHead(namespace, key), null);
});

test('failed source mapping write rolls back fact and feed sequence together', t => {
  const directory = mkdtempSync(join(tmpdir(), 'personal-agent-source-'));
  const path = join(directory, 'memory.sqlite');
  const host = openSqliteMemoryHost(path);
  const db = new DatabaseSync(path);
  t.after(() => { db.close(); host.close(); rmSync(directory, {recursive: true, force: true}); });
  host.provision(namespace);
  db.exec(`CREATE TRIGGER fail_source_mapping BEFORE INSERT ON memory_public_sources
    BEGIN SELECT RAISE(ABORT, 'injected mapping failure'); END`);
  assert.throws(() => host.appendPublicSource(namespace, observation('a')),
    fails('INVALID_ARGUMENT'));
  assert.equal(host.readPublicSourceHead(namespace, key), null);
  assert.equal(db.prepare('SELECT sequence FROM memory_namespaces WHERE namespace = ?')
    .get(namespace).sequence, 0);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM memory_facts').get().count, 0);
  db.exec('DROP TRIGGER fail_source_mapping');
  assert.equal(host.appendPublicSource(namespace, observation('a')).fact.ref.revision, 1);
  assert.equal(db.prepare('SELECT sequence FROM memory_namespaces WHERE namespace = ?')
    .get(namespace).sequence, 1);
});
