import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {openSqliteMemoryHost} from '@personal-agent/memory/sqlite';
import {TaskRuntime} from '../dist/index.js';
import {createRuntimeApplication, createSqliteFactProjectionHost} from '../dist/application.js';

const namespace = 'synthetic-public';
const graph = 'synthetic-graph';
const consumerKey = 'synthetic-cognition';
const source = {vaultId: 'public-demo', path: 'meeting.md', factId: 'meeting/update'};
const context = () => ({deadline: new Date(Date.now() + 60_000).toISOString(),
  signal: new AbortController().signal});

test('Competition application owns a public Fact source and resumes its graph projection after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-agent-competition-fact-'));
  const path = join(directory, 'runtime.sqlite');
  const memoryPath = join(directory, 'memory.sqlite');
  const options = {memoryPath, memoryNamespace: namespace, graphNamespace: graph, consumerKey};
  let app = createRuntimeApplication({path, profile: 'huawei_ict_agentarts'});
  let host = app.createCompetitionFactHost(options);
  try {
    const key = {...source};
    const first = {...key, sourceRevision: 'a'.repeat(64), line: 1,
      summary: 'Synthetic meeting at 17:00', observedAt: '2026-09-25T00:00:00.000Z',
      validFrom: '2026-09-25T00:00:00.000Z', validUntil: '2027-01-01T00:00:00.000Z',
      expectedFactRevision: host.readPublicSourceHead(key)};
    assert.equal(host.recordPublicSource(first, context()).fact.ref.revision, 1);
    assert.equal(host.recordPublicSource(first, context()).appended, false);
    await host.drain({limit: 10, maxBatches: 2, ...context()});
    assert.equal(host.listImpactReceipts({afterGraphRevision: 0, limit: 10}).length, 1);
    host.close(); app.close();
    app = createRuntimeApplication({path, profile: 'huawei_ict_agentarts'});
    host = app.createCompetitionFactHost(options);
    assert.equal(host.readPublicSourceHead(key), 1);
    const second = {...first, sourceRevision: 'b'.repeat(64),
      summary: 'Synthetic meeting at 18:00', expectedFactRevision: 1};
    assert.equal(host.recordPublicSource(second, context()).fact.ref.revision, 2);
    assert.throws(() => host.recordPublicSource({...second, sourceRevision: 'c'.repeat(64)}, context()),
      {code: 'REVISION_CONFLICT'});
    await host.drain({limit: 10, maxBatches: 2, ...context()});
    assert.equal(host.listImpactReceipts({afterGraphRevision: 0, limit: 10}).length, 2);
    const reports = host.processImpacts({at: '2026-09-25T03:00:00.000Z', limit: 10, ...context()});
    assert.equal(reports.length, 2);
    assert.equal(host.readCompletedImpact(reports[1].batchToken).batchToken, reports[1].batchToken);
    host.close();
    assert.throws(() => host.readPublicSourceHead(key), {code: 'UNSUPPORTED_CAPABILITY'});
  } finally {
    host.close(); app.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('trusted SQLite feed binding confirms public source corrections across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-agent-fact-host-'));
  const memoryPath = join(directory, 'memory.sqlite');
  const runtimePath = join(directory, 'runtime.sqlite');
  let memory = openSqliteMemoryHost(memoryPath);
  let runtime = new TaskRuntime(runtimePath);
  const bind = () => createSqliteFactProjectionHost({memory, runtime,
    memoryNamespace: namespace, graphNamespace: graph, consumerKey});
  try {
    assert.throws(bind, {code: 'SCOPE_DENIED'});
    memory.provision(namespace);
    const first = memory.appendPublicSource(namespace, {...source,
      sourceRevision: 'a'.repeat(64), line: 2, summary: 'Synthetic public meeting at 17:00',
      observedAt: '2026-09-25T00:00:00.000Z', validFrom: '2026-09-25T00:00:00.000Z',
      validUntil: '2027-01-01T00:00:00.000Z', expectedFactRevision: null, ...context()});
    assert.equal(first.appended, true);
    const app = bind();
    assert.deepEqual(await app.drain({limit: 1, maxBatches: 3, ...context()}),
      {batches: 1, atWatermark: true});
    assert.equal(runtime.bindCoordinationStore(graph).read().history.length, 1);
    assert.equal(runtime.bindFactProjectionStore(graph).readPending().length, 1);
    const firstReceipt = app.listImpactReceipts({afterGraphRevision: 0, limit: 10});
    assert.equal(firstReceipt.length, 1);
    assert.equal(firstReceipt[0].completed, undefined);

    memory.close(); runtime.close();
    memory = openSqliteMemoryHost(memoryPath);
    runtime = new TaskRuntime(runtimePath);
    assert.deepEqual(bind().listImpactReceipts({afterGraphRevision: 0, limit: 10}), firstReceipt);
    const second = memory.appendPublicSource(namespace, {...source,
      sourceRevision: 'b'.repeat(64), line: 3, summary: 'Synthetic public meeting at 18:00',
      observedAt: '2026-09-25T01:00:00.000Z', validFrom: '2026-09-25T00:00:00.000Z',
      validUntil: '2027-01-01T00:00:00.000Z', expectedFactRevision: first.fact.ref.revision,
      ...context()});
    assert.equal(second.fact.ref.revision, 2);
    assert.deepEqual(await bind().drain({limit: 1, maxBatches: 3, ...context()}),
      {batches: 1, atWatermark: true});
    assert.equal(runtime.bindCoordinationStore(graph).read().history.length, 2);
    assert.equal(runtime.bindFactProjectionStore(graph).readPending().length, 2);
    const withdrawn = memory.withdrawPublicSource(namespace, {...source,
      withdrawalId: 'synthetic-withdrawal-1', expectedFactRevision: second.fact.ref.revision,
      observedAt: '2026-09-25T02:00:00.000Z', ...context()});
    assert.equal(withdrawn.appended, true);
    assert.equal(withdrawn.fact.state, 'withdrawn');
    assert.equal(memory.withdrawPublicSource(namespace, {...source,
      withdrawalId: 'synthetic-withdrawal-1', expectedFactRevision: second.fact.ref.revision,
      observedAt: '2026-09-25T02:00:00.000Z', ...context()}).appended, false);
    assert.throws(() => memory.withdrawPublicSource(namespace, {...source,
      withdrawalId: 'synthetic-withdrawal-2', expectedFactRevision: first.fact.ref.revision,
      observedAt: '2026-09-25T02:00:00.000Z', ...context()}), {code: 'REVISION_CONFLICT'});
    assert.deepEqual(await bind().drain({limit: 1, maxBatches: 3, ...context()}),
      {batches: 1, atWatermark: true});
    assert.equal(runtime.bindCoordinationStore(graph).read().history.length, 3);
    assert.equal(runtime.bindFactProjectionStore(graph).readPending().length, 3);
    const recoverable = bind().listImpactReceipts({afterGraphRevision: firstReceipt[0].projection.graphRevision, limit: 10});
    assert.equal(recoverable.length, 2);
    assert.ok(recoverable.every(item => item.completed === undefined));
    assert.deepEqual((await memory.bind(namespace, {allowedSensitivities: ['public']})
      .listCurrent({at: '2026-09-25T03:00:00.000Z', limit: 10, ...context()})).facts, []);
    assert.deepEqual(await bind().drain({limit: 1, maxBatches: 3, ...context()}),
      {batches: 1, atWatermark: true});
    assert.equal(runtime.bindCoordinationStore(graph).read().history.length, 3);
    const completed = bind().processImpacts({at: '2026-09-25T03:00:00.000Z', limit: 3, ...context()});
    assert.equal(completed.length, 3);
    const completedReceipts = bind().listImpactReceipts({afterGraphRevision: 0, limit: 10});
    assert.deepEqual(new Map(completedReceipts.map(item => [item.projection.batchToken, item.completed])),
      new Map(completed.map(item => [item.batchToken, item])));
    assert.deepEqual(bind().listImpactReceipts({afterGraphRevision: completedReceipts.at(-1).projection.graphRevision,
      limit: 10}), []);
  } finally {
    memory.close(); runtime.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('shared graph keeps pending impact receipts within each fixed consumer scope', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-agent-fact-scope-'));
  const memory = openSqliteMemoryHost(join(directory, 'memory.sqlite'));
  const runtime = new TaskRuntime(join(directory, 'runtime.sqlite'));
  try {
    const graphNamespace = 'shared-synthetic-graph';
    const append = (memoryNamespace, factId, revision) => {
      memory.provision(memoryNamespace);
      return memory.appendPublicSource(memoryNamespace, {
        vaultId: 'public-demo', path: `${factId}.md`, factId,
        sourceRevision: revision.repeat(64), line: 1, summary: `Synthetic ${factId}`,
        observedAt: '2026-09-25T00:00:00.000Z', validFrom: '2026-09-25T00:00:00.000Z',
        validUntil: '2027-01-01T00:00:00.000Z', expectedFactRevision: null, ...context(),
      });
    };
    append('memory-b', 'fact-b', 'b');
    const hostB = createSqliteFactProjectionHost({memory, runtime,
      memoryNamespace: 'memory-b', graphNamespace, consumerKey: 'consumer-b'});
    const batchB = await hostB.consume({limit: 10, ...context()});
    append('memory-a', 'fact-a', 'a');
    const hostA = createSqliteFactProjectionHost({memory, runtime,
      memoryNamespace: 'memory-a', graphNamespace, consumerKey: 'consumer-a'});
    const batchA = await hostA.consume({limit: 10, ...context()});
    assert.equal(runtime.bindFactProjectionStore(graphNamespace).readPending().length, 2);
    assert.deepEqual(hostA.listImpactReceipts({afterGraphRevision: 0, limit: 1})
      .map(item => item.projection.batchToken), [batchA.batch.batchToken]);
    assert.deepEqual(hostB.listImpactReceipts({afterGraphRevision: 0, limit: 1})
      .map(item => item.projection.batchToken), [batchB.batch.batchToken]);
    assert.throws(() => hostA.listImpactReceipts({afterGraphRevision: 0, limit: 101}),
      {code: 'INVALID_ARGUMENT'});
    const processedA = hostA.processImpacts({at: '2026-09-25T03:00:00.000Z', limit: 1, ...context()});
    assert.deepEqual(processedA.map(item => item.batchToken), [batchA.batch.batchToken]);
    assert.deepEqual(hostA.readCompletedImpact(batchA.batch.batchToken), processedA[0]);
    assert.deepEqual(hostA.listImpactReceipts({afterGraphRevision: 0, limit: 1})[0].completed, processedA[0]);
    assert.throws(() => hostA.readCompletedImpact(batchB.batch.batchToken), {code: 'NOT_FOUND'});
    assert.equal(hostB.readCompletedImpact(batchB.batch.batchToken), undefined);
    assert.equal(runtime.bindFactProjectionStore(graphNamespace).readPending().length, 1);
    const processedB = hostB.processImpacts({at: '2026-09-25T03:00:00.000Z', limit: 1, ...context()});
    assert.deepEqual(processedB.map(item => item.batchToken), [batchB.batch.batchToken]);
    assert.deepEqual(hostB.readCompletedImpact(batchB.batch.batchToken), processedB[0]);
    assert.deepEqual(runtime.bindFactProjectionStore(graphNamespace).readPending(), []);
  } finally {
    memory.close(); runtime.close();
    await rm(directory, {recursive: true, force: true});
  }
});
