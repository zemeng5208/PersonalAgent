import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {TaskRuntime} from '../dist/index.js';
import {createPendingImpactApplication} from '../dist/application.js';

function database() {
  const dir = mkdtempSync(join(tmpdir(), 'pa-fact-projection-'));
  return {path: join(dir, 'runtime.sqlite'), cleanup: () => rmSync(dir, {recursive: true, force: true})};
}

function fact(revision = 1, overrides = {}) {
  return {
    ref: {id: 'calendar/location', revision},
    summary: revision === 1 ? 'Meeting is in Shenzhen' : 'Meeting moved to Shanghai',
    sourceRef: 'calendar/event-1',
    observedAt: '2026-09-22T00:00:00.000Z',
    validFrom: '2026-09-22T00:00:00.000Z',
    validUntil: '2026-12-31T00:00:00.000Z',
    sensitivity: 'private',
    state: 'active',
    confirmation: 'external_observation',
    ...(revision > 1 ? {corrects: {id: 'calendar/location', revision: revision - 1}} : {}),
    ...overrides
  };
}

function request(revision = 1, overrides = {}) {
  const value = fact(revision);
  const eventId = 'event-' + revision;
  return {
    consumerKey: 'cognition-primary',
    memoryNamespace: 'personal',
    batch: {
      mode: 'changes',
      batchToken: 'batch-' + revision,
      baseCheckpoint: 'checkpoint-' + (revision - 1),
      watermark: 'watermark-' + revision,
      entries: [{eventId, fact: value.ref}],
      atWatermark: true
    },
    facts: [value],
    deadline: new Date(Date.now() + 60_000).toISOString(),
    signal: new AbortController().signal,
    ...overrides
  };
}

test('SQLite projection persists exact FactRef links and replays one batch without another graph version', t => {
  const location = database();
  let runtime = new TaskRuntime(location.path);
  t.after(() => { runtime.close(); location.cleanup(); });
  let store = runtime.provisionFactProjectionStore('primary');

  const first = store.project(request());
  assert.equal(first.graphRevision, 1);
  assert.deepEqual(first.links[0].fact, {id: 'calendar/location', revision: 1});
  assert.equal(first.links[0].node.revision, 1);
  assert.equal(runtime.bindCoordinationStore('primary').read().history.length, 1);
  assert.deepEqual(store.project(request()), first);
  assert.equal(runtime.bindCoordinationStore('primary').read().history.length, 1);
  assert.equal(store.readPending().length, 1);

  runtime.close();
  runtime = new TaskRuntime(location.path);
  store = runtime.bindFactProjectionStore('primary');
  assert.deepEqual(store.project(request()), first);
  assert.equal(runtime.bindCoordinationStore('primary').read().history.length, 1);
});

test('SQLite projection keeps a stable node id while Memory and Goal revisions remain independent', t => {
  const location = database();
  const runtime = new TaskRuntime(location.path);
  t.after(() => { runtime.close(); location.cleanup(); });
  const store = runtime.provisionFactProjectionStore('primary');
  const first = store.project(request(1));
  const second = store.project(request(2));

  assert.equal(second.graphRevision, 2);
  assert.equal(second.links[0].node.id, first.links[0].node.id);
  assert.equal(second.links[0].node.revision, 2);
  assert.deepEqual(runtime.bindCoordinationStore('primary').read().history.map(node => ({
    summary: node.summary,
    revision: node.revision,
    graphRevision: node.graphRevision
  })), [
    {summary: 'Meeting is in Shenzhen', revision: 1, graphRevision: 1},
    {summary: 'Meeting moved to Shanghai', revision: 2, graphRevision: 2}
  ]);
});

test('fact node ids separate namespace and fact id even when both contain the delimiter text', t => {
  const location = database();
  const runtime = new TaskRuntime(location.path);
  t.after(() => { runtime.close(); location.cleanup(); });
  const store = runtime.provisionFactProjectionStore('primary');
  const left = request(1, {memoryNamespace: 'a\\0b'});
  left.facts = [fact(1, {ref: {id: 'c', revision: 1}})];
  left.batch.entries = [{eventId: 'event-1', fact: left.facts[0].ref}];
  const right = request(1, {memoryNamespace: 'a'});
  right.facts = [fact(1, {ref: {id: 'b\\0c', revision: 1}})];
  right.batch.entries = [{eventId: 'event-1', fact: right.facts[0].ref}];

  assert.notEqual(store.project(left).links[0].node.id, store.project(right).links[0].node.id);
});

test('SQLite projection rejects a reused batch identity with different fact content', t => {
  const location = database();
  const runtime = new TaskRuntime(location.path);
  t.after(() => { runtime.close(); location.cleanup(); });
  const store = runtime.provisionFactProjectionStore('primary');
  store.project(request());
  const changed = request(1);
  changed.facts = [fact(1, {summary: 'tampered'})];

  assert.throws(() => store.project(changed), {code: 'INTEGRITY_CONFLICT'});
  assert.equal(runtime.bindCoordinationStore('primary').read().revision, 1);
  assert.equal(store.readPending().length, 1);
});

test('SQLite projection rolls back graph, mapping, receipt and pending impact together', t => {
  const location = database();
  const runtime = new TaskRuntime(location.path);
  t.after(() => { runtime.close(); location.cleanup(); });
  const store = runtime.provisionFactProjectionStore('primary');
  const admin = new DatabaseSync(location.path);
  admin.exec([
    'CREATE TRIGGER fail_projection_pending',
    'BEFORE INSERT ON coordination_pending_impacts',
    "BEGIN SELECT RAISE(ABORT, 'forced projection failure'); END;"
  ].join(' '));
  admin.close();

  assert.throws(() => store.project(request()), {code: 'STORAGE_UNAVAILABLE'});
  assert.deepEqual(runtime.bindCoordinationStore('primary').read(), {
    namespace: 'primary',
    revision: 0,
    history: []
  });
  assert.deepEqual(store.readPending(), []);

  const inspect = new DatabaseSync(location.path);
  assert.equal(inspect.prepare('SELECT count(*) AS count FROM coordination_fact_projections').get().count, 0);
  assert.equal(inspect.prepare('SELECT count(*) AS count FROM coordination_projection_receipts').get().count, 0);
  inspect.close();
});

test('SQLite projection rejects cancellation and expired deadlines before any write', t => {
  const location = database();
  const runtime = new TaskRuntime(location.path);
  t.after(() => { runtime.close(); location.cleanup(); });
  const store = runtime.provisionFactProjectionStore('primary');

  const cancelled = new AbortController();
  cancelled.abort();
  assert.throws(() => store.project(request(1, {signal: cancelled.signal})), {code: 'CANCELLED'});
  assert.throws(() => store.project(request(1, {
    deadline: new Date(Date.now() - 1_000).toISOString()
  })), {code: 'TIMEOUT'});
  assert.equal(runtime.bindCoordinationStore('primary').read().revision, 0);
  assert.deepEqual(store.readPending(), []);
});

test('pending cognition analysis persists RECHECK without changing the graph or revising the plan', t => {
  const location = database();
  const runtime = new TaskRuntime(location.path);
  t.after(() => { runtime.close(); location.cleanup(); });
  const projection = runtime.provisionFactProjectionStore('primary');
  const coordination = runtime.bindCoordinationStore('primary');
  const application = createPendingImpactApplication({coordination, projection});
  const operation = {
    at: '2026-09-23T00:00:00.000Z',
    limit: 10,
    deadline: new Date(Date.now() + 60_000).toISOString(),
    signal: new AbortController().signal
  };

  const first = projection.project(request(1));
  assert.deepEqual(application.process(operation)[0].items, []);
  assert.deepEqual(projection.readPending(), []);
  coordination.append(1, {
    id: 'plan-1',
    kind: 'plan',
    summary: 'Travel to the meeting',
    sourceRef: 'fixture/plan-1',
    validFrom: '2026-09-22T00:00:00.000Z',
    validUntil: '2026-12-31T00:00:00.000Z',
    sensitivity: 'private',
    state: 'active',
    reason: 'Depends on the meeting location',
    dependencies: [first.links[0].node]
  });
  projection.project(request(2));

  const reports = application.process(operation);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].graphRevision, 3);
  assert.deepEqual(reports[0].items.map(item => ({
    id: item.node.id,
    action: item.action,
    reason: item.reason
  })), [{
    id: 'plan-1',
    action: 'RECHECK',
    reason: 'dependency_or_validity_changed'
  }]);
  assert.equal(coordination.read().revision, 3, 'analysis must not revise the plan');
  assert.deepEqual(projection.readPending(), []);
  assert.deepEqual(application.process(operation), []);
});
