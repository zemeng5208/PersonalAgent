import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {openSqliteMemoryHost} from '@personal-agent/memory/sqlite';
import {TaskRuntime} from '@personal-agent/runtime';
import {createMemoryProjectionApplication, createPendingImpactApplication} from '@personal-agent/runtime/application';
import {previewStoredRepair, commitStoredRepair} from '@personal-agent/cognition';
import {currentNodes} from '@personal-agent/goals';

// Offline integration only. Explicit synthetic candidates are not cloud decisions,
// Policy approval, a tool Evidence record, or a scheduled reminder.
const at = '2026-09-24T04:00:00.000Z';
const namespace = 'mvp-synthetic-meeting';
const consumerKey = 'mvp-cognition';
const context = () => ({limit: 10, deadline: new Date(Date.now() + 60_000).toISOString(),
  signal: new AbortController().signal});
const fact = (revision, time) => ({
  ref: {id: 'meeting/time', revision}, summary: `Synthetic meeting starts at ${time}`,
  sourceRef: 'synthetic/mvp/meeting', observedAt: at,
  validFrom: '2026-09-24T00:00:00.000Z', validUntil: '2026-09-25T00:00:00.000Z',
  sensitivity: 'private', state: 'active', confirmation: 'external_observation',
  ...(revision === 1 ? {} : {corrects: {id: 'meeting/time', revision: revision - 1}}),
});
const node = (id, kind, summary, dependencies = []) => ({
  id, kind, summary, dependencies, sourceRef: 'synthetic/mvp/explicit-plan',
  validFrom: '2026-09-24T00:00:00.000Z', validUntil: '2026-09-25T00:00:00.000Z',
  sensitivity: 'private', state: 'active', reason: 'Explicit synthetic fixture',
});

test('synthetic meeting correction projects exact fact refs, repairs only affected plans, and survives restart', async t => {
  const folder = mkdtempSync(join(tmpdir(), 'pa-mvp-meeting-'));
  const memoryPath = join(folder, 'memory.sqlite');
  const runtimePath = join(folder, 'runtime.sqlite');
  let memory = openSqliteMemoryHost(memoryPath);
  let runtime = new TaskRuntime(runtimePath);
  t.after(() => {
    try { memory.close(); } finally {
      try { runtime.close(); } finally { rmSync(folder, {recursive: true, force: true}); }
    }
  });
  memory.provision(namespace);
  const projection = runtime.provisionFactProjectionStore(namespace);
  const graph = runtime.bindCoordinationStore(namespace);
  const app = createMemoryProjectionApplication({
    consumerKey, memoryNamespace: namespace,
    feed: memory.bindFeed(namespace, {consumerId: consumerKey, allowedSensitivities: ['private']}),
    memory: memory.bind(namespace, {allowedSensitivities: ['private']}), projection,
    confirmation: {confirm: request => memory.confirmFeedBatch(namespace, consumerKey, request)},
  });
  const impacts = createPendingImpactApplication({coordination: graph, projection});

  memory.append(namespace, fact(1, '15:00'));
  const baseline = await app.consume(context());
  assert.equal(baseline.projection.links.length, 1);
  const firstLink = baseline.projection.links[0];
  assert.deepEqual(firstLink.fact, {id: 'meeting/time', revision: 1});
  impacts.process({...context(), at});
  const seeded = graph.appendBatch(graph.read().revision, [
    node('attend', 'goal', 'Attend meeting at 15:00', [firstLink.node]),
    node('prepare', 'decision', 'Prepare one hour before meeting', [{id: 'attend', revision: 1}]),
    node('preparation', 'plan', 'Prepare at 14:00', [{id: 'prepare', revision: 1}]),
    node('unrelated', 'plan', 'Unrelated plan remains at 18:00'),
  ]);
  const unrelatedBefore = currentNodes(seeded).find(item => item.id === 'unrelated');

  memory.append(namespace, fact(2, '17:00'));
  const correction = await app.consume(context());
  const changedLink = correction.projection.links.find(item => item.fact.id === 'meeting/time');
  assert.ok(changedLink, 'Correction must be delivered through the existing Memory feed');
  assert.deepEqual(changedLink.fact, {id: 'meeting/time', revision: 2});
  assert.equal(changedLink.node.id, firstLink.node.id);
  assert.notDeepEqual(changedLink.node, firstLink.node);
  assert.equal(correction.providerReceipt.batchToken, correction.batch.batchToken);
  const reports = impacts.process({...context(), at});
  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0].items.filter(item => item.action === 'RECHECK')
    .map(item => item.node.id).sort(), ['attend', 'preparation', 'prepare']);
  assert.deepEqual(projection.readPending(), []);

  const beforeRepair = graph.read();
  const request = {expectedGraphRevision: beforeRepair.revision, changes: [
    {node: {id: 'attend', revision: 1}, summary: 'Attend meeting at 17:00',
      reason: 'Explicit synthetic candidate', dependencies: [changedLink.node]},
    {node: {id: 'prepare', revision: 1}, summary: 'Prepare one hour before 17:00 meeting',
      reason: 'Explicit synthetic candidate', dependencies: [{id: 'attend', revision: 2}]},
    {node: {id: 'preparation', revision: 1}, summary: 'Prepare at 16:00',
      reason: 'Explicit synthetic candidate', dependencies: [{id: 'prepare', revision: 2}]},
  ]};
  previewStoredRepair(graph, at, request);
  assert.deepEqual(graph.read(), beforeRepair, 'Preview must not mutate persistent state');
  const repaired = commitStoredRepair(graph, at, request);
  assert.equal(repaired.kind, 'applied');
  assert.equal(repaired.snapshot.revision, beforeRepair.revision + 3);
  assert.deepEqual(currentNodes(repaired.snapshot).find(item => item.id === 'unrelated'), unrelatedBefore);
  assert.equal(currentNodes(repaired.snapshot).find(item => item.id === 'preparation').summary, 'Prepare at 16:00');
  assert.deepEqual(repaired.report.items.filter(item => item.action === 'RECHECK'), []);

  memory.close();
  runtime.close();
  memory = openSqliteMemoryHost(memoryPath);
  runtime = new TaskRuntime(runtimePath);
  assert.deepEqual(runtime.bindCoordinationStore(namespace).read(), repaired.snapshot);
  assert.deepEqual(runtime.bindCoordinationStore(namespace).read(beforeRepair.revision), beforeRepair);
  assert.deepEqual(runtime.bindFactProjectionStore(namespace).readPending(), []);
  const exactFact = await memory.bind(namespace, {allowedSensitivities: ['private']})
    .getVersion({...context(), fact: changedLink.fact});
  assert.deepEqual(exactFact, fact(2, '17:00'));
});
