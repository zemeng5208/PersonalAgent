import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {analyzeImpact} from '@personal-agent/cognition';
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

function confirmedProject(store, input) {
  store.stage(input);
  return store.project(input, {batchToken: input.batch.batchToken, checkpoint: 'confirmed-checkpoint'});
}

test('staging cannot change the effective graph and activation requires that stage', t => {
  const location = database();
  const runtime = new TaskRuntime(location.path);
  t.after(() => { runtime.close(); location.cleanup(); });
  const store = runtime.provisionFactProjectionStore('primary');
  const input = request();
  const providerReceipt = {batchToken: input.batch.batchToken, checkpoint: 'confirmed-checkpoint'};
  assert.throws(() => store.project(input, providerReceipt), {code: 'NOT_FOUND'});
  store.stage(input);
  assert.equal(runtime.bindCoordinationStore('primary').read().revision, 0);
  assert.deepEqual(store.readPending(), []);
  assert.deepEqual(store.readStaged(input.consumerKey, input.memoryNamespace)?.batch, input.batch);
  assert.equal(store.project(input, providerReceipt).graphRevision, 1);
  assert.equal(store.readStaged(input.consumerKey, input.memoryNamespace), undefined);
});

test('SQLite projection persists exact FactRef links and replays one batch without another graph version', t => {
  const location = database();
  let runtime = new TaskRuntime(location.path);
  t.after(() => { runtime.close(); location.cleanup(); });
  let store = runtime.provisionFactProjectionStore('primary');

  const first = confirmedProject(store, request());
  assert.equal(first.graphRevision, 1);
  assert.deepEqual(first.links[0].fact, {id: 'calendar/location', revision: 1});
  assert.equal(first.links[0].node.revision, 1);
  assert.equal(runtime.bindCoordinationStore('primary').read().history.length, 1);
  assert.deepEqual(confirmedProject(store, request()), first);
  assert.equal(runtime.bindCoordinationStore('primary').read().history.length, 1);
  assert.equal(store.readPending().length, 1);

  runtime.close();
  runtime = new TaskRuntime(location.path);
  store = runtime.bindFactProjectionStore('primary');
  assert.deepEqual(confirmedProject(store, request()), first);
  assert.equal(runtime.bindCoordinationStore('primary').read().history.length, 1);
});

test('one projection receipt and pending impact can contain target and unrelated facts', t => {
  const location = database();
  const runtime = new TaskRuntime(location.path);
  t.after(() => { runtime.close(); location.cleanup(); });
  const store = runtime.provisionFactProjectionStore('primary');
  const input = request();
  const other = fact(1, {ref: {id: 'calendar/owner', revision: 1}, summary: 'Owner is Ava'});
  input.facts = [input.facts[0], other];
  input.batch.entries = [input.batch.entries[0], {eventId: 'event-owner', fact: other.ref}];

  const receipt = confirmedProject(store, input);
  assert.deepEqual(receipt.links.map(link => link.fact.id), ['calendar/location', 'calendar/owner']);
  assert.deepEqual(store.readPending().flatMap(impact => impact.links.map(link => link.fact.id)),
    ['calendar/location', 'calendar/owner']);
});

test('erasure preflight reads mixed activated receipt without changing graph or pending impact', async t => {
  const location = database();
  const runtime = new TaskRuntime(location.path);
  t.after(() => { runtime.close(); location.cleanup(); });
  const store = runtime.provisionFactProjectionStore('primary');
  const input = request();
  const other = fact(1, {ref: {id: 'calendar/owner', revision: 1}, summary: 'Owner is Ava'});
  input.facts = [input.facts[0], other];
  input.batch.entries = [input.batch.entries[0], {eventId: 'event-owner', fact: other.ref}];
  const receipt = confirmedProject(store, input);
  store.stage({...input, batch: {...input.batch, batchToken: 'batch-staged'}});
  const coordination = runtime.bindCoordinationStore('primary');
  coordination.append(2, {
    id: 'dependent-plan', kind: 'plan', summary: 'Visit meeting', sourceRef: 'fixture/plan',
    validFrom: '2026-09-22T00:00:00.000Z', validUntil: '2026-12-31T00:00:00.000Z',
    sensitivity: 'private', state: 'active', reason: 'Location matters',
    dependencies: [receipt.links[0].node]
  });
  coordination.append(3, {
    id: 'independent-goal', kind: 'goal', summary: 'Read a book', sourceRef: 'fixture/goal',
    validFrom: '2026-09-22T00:00:00.000Z', validUntil: '2026-12-31T00:00:00.000Z',
    sensitivity: 'private', state: 'active', reason: 'Independent', dependencies: []
  });
  const before = coordination.read();
  const pending = store.readPending();
  const delivery = {...input.batch, entries: [input.batch.entries[1]]};
  const preflight = await store.preflightErasure({
    memoryNamespace: 'personal', factId: 'calendar/location',
    deadline: input.deadline, signal: input.signal,
    readDelivery: (consumer, token) => {
      assert.equal(consumer, 'cognition-primary');
      assert.equal(token, input.batch.batchToken);
      return delivery;
    },
    readVersion: exact => {
      assert.deepEqual(exact, other.ref);
      return other;
    }
  });
  assert.equal(preflight.graphRevision, 4);
  assert.equal(preflight.targetVersions, 1);
  assert.deepEqual(preflight.otherGraphNamespaces, []);
  assert.equal(preflight.graphReceiptCount, 1);
  assert.deepEqual(preflight.stagedTargetBatches,
    [{consumerKey: 'cognition-primary', batchToken: 'batch-staged'}]);
  assert.deepEqual(preflight.dependentNodes, [{id: 'dependent-plan', revision: 1}]);
  assert.deepEqual(preflight.untracedTextNodes, [{id: 'independent-goal', revision: 1}]);
  assert.deepEqual(preflight.affectedReceipts, [{consumerKey: 'cognition-primary',
    batchToken: 'batch-1', survivingFacts: [other.ref], impact: 'pending'}]);
  assert.deepEqual(preflight.impactRecords, [{memoryNamespace: 'personal',
    consumerKey: 'cognition-primary', batchToken: 'batch-1', graphRevision: 2,
    state: 'pending', referencesTarget: true}]);
  assert.deepEqual(coordination.read(), before);
  assert.deepEqual(store.readPending(), pending);
});

test('erasure preflight fails closed on missing delivery or changed survivor content', async t => {
  const location = database();
  const runtime = new TaskRuntime(location.path);
  t.after(() => { runtime.close(); location.cleanup(); });
  const store = runtime.provisionFactProjectionStore('primary');
  const input = request();
  const other = fact(1, {ref: {id: 'calendar/owner', revision: 1}, summary: 'Owner is Ava'});
  input.facts = [input.facts[0], other];
  input.batch.entries = [input.batch.entries[0], {eventId: 'event-owner', fact: other.ref}];
  confirmedProject(store, input);
  const options = {memoryNamespace: 'personal', factId: 'calendar/location',
    deadline: input.deadline, signal: input.signal,
    readVersion: () => other};
  await assert.rejects(store.preflightErasure({...options,
    readDelivery: () => { throw new Error('delivery missing'); }
  }), /delivery missing/);
  await assert.rejects(store.preflightErasure({...options,
    readDelivery: () => ({...input.batch, entries: [input.batch.entries[1]]}),
    readVersion: () => ({...other, summary: 'tampered'})
  }), {code: 'INTEGRITY_CONFLICT'});
  assert.equal(runtime.bindCoordinationStore('primary').read().revision, 2);
  assert.equal(store.readPending().length, 1);
});

test('erasure preflight finds target references in an unrelated completed impact report', async t => {
  const location = database();
  const runtime = new TaskRuntime(location.path);
  t.after(() => { runtime.close(); location.cleanup(); });
  const store = runtime.provisionFactProjectionStore('primary');
  const first = confirmedProject(store, request(1));
  const coordination = runtime.bindCoordinationStore('primary');
  coordination.append(1, {
    id: 'goal-from-target', kind: 'goal', summary: 'Attend meeting', sourceRef: 'fixture/goal',
    validFrom: '2026-09-22T00:00:00.000Z', validUntil: '2026-12-31T00:00:00.000Z',
    sensitivity: 'private', state: 'active', reason: 'Location matters',
    dependencies: [first.links[0].node]
  });
  confirmedProject(store, request(2));
  const other = fact(1, {ref: {id: 'calendar/owner', revision: 1}, summary: 'Owner is Ava'});
  const otherInput = request(1, {facts: [other], batch: {
    mode: 'changes', batchToken: 'batch-other', baseCheckpoint: 'checkpoint-other',
    watermark: 'watermark-other', entries: [{eventId: 'event-other', fact: other.ref}],
    atWatermark: true
  }});
  confirmedProject(store, otherInput);
  const report = analyzeImpact(coordination.read(), '2026-09-23T00:00:00.000Z');
  store.completeImpact({consumerKey: 'cognition-primary', memoryNamespace: 'personal',
    batchToken: 'batch-other', expectedGraphRevision: 4, report,
    deadline: otherInput.deadline, signal: otherInput.signal});
  const result = await store.preflightErasure({memoryNamespace: 'personal',
    factId: 'calendar/location', deadline: otherInput.deadline, signal: otherInput.signal,
    readDelivery: (_consumer, batchToken) => {
      const original = batchToken === 'batch-1' ? request(1).batch : request(2).batch;
      return {...original, entries: []};
    },
    readVersion: () => { throw new Error('no surviving target batch fact'); }
  });
  assert.equal(result.targetVersions, 2);
  assert.equal(result.affectedReceipts.length, 2);
  assert.deepEqual(result.impactRecords.find(item => item.batchToken === 'batch-other'), {
    memoryNamespace: 'personal', consumerKey: 'cognition-primary', batchToken: 'batch-other',
    graphRevision: 4, state: 'completed', referencesTarget: true
  });
});

test('Runtime erasure rewrites a completed dependent impact at its original revision', async t => {
  const location = database();
  const runtime = new TaskRuntime(location.path);
  t.after(() => { runtime.close(); location.cleanup(); });
  const store = runtime.provisionFactProjectionStore('primary');
  const first = confirmedProject(store, request(1));
  const coordination = runtime.bindCoordinationStore('primary');
  coordination.append(1, {
    id: 'goal-from-target', kind: 'goal', summary: 'Attend meeting', sourceRef: 'fixture/goal',
    validFrom: '2026-09-22T00:00:00.000Z', validUntil: '2026-12-31T00:00:00.000Z',
    sensitivity: 'private', state: 'active', reason: 'Location matters',
    dependencies: [first.links[0].node]
  });
  confirmedProject(store, request(2));
  const report = analyzeImpact(coordination.read(), '2026-09-23T00:00:00.000Z');
  assert.deepEqual(report.items.map(item => item.node.id), ['goal-from-target']);
  store.completeImpact({consumerKey: 'cognition-primary', memoryNamespace: 'personal',
    batchToken: 'batch-2', expectedGraphRevision: 3, report,
    deadline: request(2).deadline, signal: request(2).signal});
  await store.commitErasure({memoryNamespace: 'personal', factId: 'calendar/location',
    operationId: 'synthetic-dependent-delete', expectedGraphRevision: 3,
    deadline: request(2).deadline, signal: request(2).signal,
    readDelivery: (_consumer, batchToken) => ({...
      (batchToken === 'batch-1' ? request(1).batch : request(2).batch), entries: []}),
    readVersion: () => { throw new Error('no survivor'); }
  });
  const graphAfter = coordination.read();
  assert.equal(graphAfter.revision, 3);
  assert.deepEqual(graphAfter.history, []);
  assert.deepEqual(graphAfter.erasedGraphRevisions, [1, 2, 3]);
  const completed = store.readCompletedImpact({consumerKey: 'cognition-primary',
    memoryNamespace: 'personal', batchToken: 'batch-2'});
  assert.deepEqual(completed.report.items, []);
  assert.equal(completed.report.graphRevision, 3);
  assert.deepEqual(store.listImpactReceipts({consumerKey: 'cognition-primary',
    memoryNamespace: 'personal', afterGraphRevision: 0, limit: 10})
    .find(item => item.projection.batchToken === 'batch-2').projection.links, []);
});

test('Runtime erasure rejects stale staging, untraced text and other active graphs', async t => {
  for (const obstacle of ['staged', 'untraced', 'other-graph', 'other-staged', 'other-untraced']) {
    await t.test(obstacle, async subtest => {
      const location = database();
      const runtime = new TaskRuntime(location.path);
      subtest.after(() => { runtime.close(); location.cleanup(); });
      const store = runtime.provisionFactProjectionStore('primary');
      const input = request(1);
      const original = confirmedProject(store, input);
      if (obstacle === 'staged') {
        store.stage({...input, batch: {...input.batch, batchToken: 'stale-batch'}});
      } else if (obstacle === 'untraced') {
        runtime.bindCoordinationStore('primary').append(1, {
          id: 'independent-goal', kind: 'goal', summary: 'Read a book',
          sourceRef: 'fixture/goal', validFrom: '2026-09-22T00:00:00.000Z',
          validUntil: '2026-12-31T00:00:00.000Z', sensitivity: 'private',
          state: 'active', reason: 'Independent', dependencies: []
        });
      } else if (obstacle === 'other-staged') {
        runtime.provisionFactProjectionStore('secondary').stage(input);
      } else if (obstacle === 'other-untraced') {
        runtime.provisionCoordinationStore('secondary').append(0, {
          id: 'unrelated-goal', kind: 'goal', summary: 'Untraced text',
          sourceRef: 'fixture/goal', validFrom: '2026-09-22T00:00:00.000Z',
          validUntil: '2026-12-31T00:00:00.000Z', sensitivity: 'private',
          state: 'active', reason: 'Independent', dependencies: []
        });
      } else {
        confirmedProject(runtime.provisionFactProjectionStore('secondary'), input);
      }
      const before = runtime.bindCoordinationStore('primary').read();
      await assert.rejects(store.commitErasure({memoryNamespace: 'personal',
        factId: 'calendar/location', operationId: 'synthetic-guard',
        expectedGraphRevision: before.revision, deadline: input.deadline,
        signal: input.signal,
        readDelivery: () => ({...input.batch, entries: []}),
        readVersion: () => { throw new Error('no survivor'); }
      }), {code: 'INTEGRITY_CONFLICT'});
      assert.deepEqual(runtime.bindCoordinationStore('primary').read(), before);
      assert.deepEqual(store.listImpactReceipts({consumerKey: 'cognition-primary',
        memoryNamespace: 'personal', afterGraphRevision: 0, limit: 10})[0].projection,
        original);
    });
  }
});

test('Runtime erasure rejects expired and cancelled operations before a write', async t => {
  const location = database();
  const runtime = new TaskRuntime(location.path);
  t.after(() => { runtime.close(); location.cleanup(); });
  const store = runtime.provisionFactProjectionStore('primary');
  const input = request(1);
  confirmedProject(store, input);
  const base = {memoryNamespace: 'personal', factId: 'calendar/location',
    operationId: 'synthetic-timeout', expectedGraphRevision: 1,
    readDelivery: () => ({...input.batch, entries: []}),
    readVersion: () => { throw new Error('no survivor'); }};
  await assert.rejects(store.commitErasure({...base,
    deadline: '2000-01-01T00:00:00.000Z', signal: input.signal}), {code: 'TIMEOUT'});
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(store.commitErasure({...base,
    deadline: input.deadline, signal: controller.signal}), {code: 'CANCELLED'});
  assert.equal(runtime.bindCoordinationStore('primary').read().history.length, 1);
});

test('staging rewrite keeps exact survivor content and commits atomically', t => {
  const location = database();
  let runtime = new TaskRuntime(location.path);
  t.after(() => { runtime.close(); location.cleanup(); });
  let store = runtime.provisionFactProjectionStore('primary');
  const input = request();
  const other = fact(1, {ref: {id: 'calendar/owner', revision: 1}, summary: 'Owner is Ava'});
  input.facts = [input.facts[0], other];
  input.batch.entries = [input.batch.entries[0], {eventId: 'event-owner', fact: other.ref}];
  store.stage(input);
  const survivor = {...input, batch: {...input.batch, entries: [input.batch.entries[1]]}, facts: [other]};
  assert.throws(() => store.reviseStaged({...survivor,
    facts: [{...other, summary: 'tampered owner'}]}), {code: 'INTEGRITY_CONFLICT'});
  assert.deepEqual(store.readStaged('cognition-primary', 'personal').facts.map(item => item.ref.id),
    ['calendar/location', 'calendar/owner']);
  store.reviseStaged(survivor);
  assert.deepEqual(store.readStaged('cognition-primary', 'personal').facts, [other]);
  assert.equal(runtime.bindCoordinationStore('primary').read().revision, 0);
  runtime.close();
  runtime = new TaskRuntime(location.path);
  store = runtime.bindFactProjectionStore('primary');
  assert.deepEqual(store.readStaged('cognition-primary', 'personal').facts, [other]);
  assert.deepEqual(store.project(survivor, {
    batchToken: survivor.batch.batchToken, checkpoint: 'confirmed-checkpoint',
  }).links.map(link => link.fact.id), ['calendar/owner']);
});

test('SQLite projection keeps a stable node id while Memory and Goal revisions remain independent', t => {
  const location = database();
  const runtime = new TaskRuntime(location.path);
  t.after(() => { runtime.close(); location.cleanup(); });
  const store = runtime.provisionFactProjectionStore('primary');
  const first = confirmedProject(store, request(1));
  const second = confirmedProject(store, request(2));

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

  assert.notEqual(confirmedProject(store, left).links[0].node.id, confirmedProject(store, right).links[0].node.id);
});

test('SQLite projection rejects a reused batch identity with different fact content', t => {
  const location = database();
  const runtime = new TaskRuntime(location.path);
  t.after(() => { runtime.close(); location.cleanup(); });
  const store = runtime.provisionFactProjectionStore('primary');
  confirmedProject(store, request());
  const changed = request(1);
  changed.facts = [fact(1, {summary: 'tampered'})];

  assert.throws(() => confirmedProject(store, changed), {code: 'INTEGRITY_CONFLICT'});
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

  assert.throws(() => confirmedProject(store, request()), {code: 'STORAGE_UNAVAILABLE'});
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
  assert.throws(() => confirmedProject(store, request(1, {signal: cancelled.signal})), {code: 'CANCELLED'});
  assert.throws(() => confirmedProject(store, request(1, {
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

  const first = confirmedProject(projection, request(1));
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
  confirmedProject(projection, request(2));

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
