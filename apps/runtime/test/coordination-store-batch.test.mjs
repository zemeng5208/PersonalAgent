import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TaskRuntime} from '../dist/index.js';

const node = (id, kind, dependencies = []) => ({
  id,
  kind,
  summary: `synthetic ${kind}`,
  sourceRef: `fixture/${id}`,
  validFrom: '2026-09-09T00:00:00.000Z',
  validUntil: '2026-09-11T00:00:00.000Z',
  sensitivity: 'private',
  state: 'active',
  reason: 'fixture',
  dependencies
});
const validBatch = () => [
  node('goal-1', 'goal'),
  node('decision-1', 'decision', [{id: 'goal-1', revision: 1}]),
  node('plan-1', 'plan', [{id: 'decision-1', revision: 1}])
];
function database() {
  const dir = mkdtempSync(join(tmpdir(), 'pa-coordination-batch-'));
  return {path: join(dir, 'runtime.sqlite'), cleanup: () => rmSync(dir, {recursive: true, force: true})};
}

test('SQLite: one batch commits Goal -> Decision -> Plan and survives restart', t => {
  const databaseLocation = database();
  let runtime = new TaskRuntime(databaseLocation.path);
  t.after(() => { runtime.close(); databaseLocation.cleanup(); });
  const committed = runtime.provisionCoordinationStore('primary').appendBatch(0, validBatch());
  assert.equal(committed.revision, 3);
  assert.deepEqual(committed.history.map(({id, kind, graphRevision}) => ({id, kind, graphRevision})), [
    {id: 'goal-1', kind: 'goal', graphRevision: 1},
    {id: 'decision-1', kind: 'decision', graphRevision: 2},
    {id: 'plan-1', kind: 'plan', graphRevision: 3}
  ]);
  runtime.close();

  runtime = new TaskRuntime(databaseLocation.path);
  assert.deepEqual(runtime.bindCoordinationStore('primary').read(), committed);
});

test('SQLite: an invalid second or third node leaves the entire batch unwritten', t => {
  const databaseLocation = database();
  const runtime = new TaskRuntime(databaseLocation.path);
  t.after(() => { runtime.close(); databaseLocation.cleanup(); });
  const store = runtime.provisionCoordinationStore('primary');
  const secondInvalid = validBatch();
  secondInvalid[1] = {...secondInvalid[1], summary: ''};
  assert.throws(() => store.appendBatch(0, secondInvalid), {code: 'INVALID_ARGUMENT'});
  assert.deepEqual(store.read(), {namespace: 'primary', revision: 0, history: []});

  const thirdInvalid = validBatch();
  thirdInvalid[2] = {...thirdInvalid[2], dependencies: [{id: 'missing', revision: 1}]};
  assert.throws(() => store.appendBatch(0, thirdInvalid), {code: 'INVALID_ARGUMENT'});
  assert.deepEqual(store.read(), {namespace: 'primary', revision: 0, history: []});
});

test('SQLite: stale batches are atomic, namespaces stay isolated, and results are copies', t => {
  const databaseLocation = database();
  const runtime = new TaskRuntime(databaseLocation.path);
  t.after(() => { runtime.close(); databaseLocation.cleanup(); });
  const primary = runtime.provisionCoordinationStore('primary');
  const other = runtime.provisionCoordinationStore('other');
  const committed = primary.appendBatch(0, validBatch());
  assert.throws(() => primary.appendBatch(0, [node('goal-2', 'goal')]), {code: 'REVISION_CONFLICT'});
  assert.equal(primary.read().revision, 3);
  assert.deepEqual(other.read(), {namespace: 'other', revision: 0, history: []});

  committed.history[0].summary = 'mutated outside';
  assert.equal(primary.read().history[0].summary, 'synthetic goal');
});
