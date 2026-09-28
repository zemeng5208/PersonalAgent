import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
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
  assert.throws(() => app.createCompetitionFactHost({...options, memoryPath: path}),
    {code: 'INVALID_ARGUMENT'});
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

test('trusted host preflights a pending erasure against the rewritten durable delivery after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-agent-erasure-preflight-'));
  const memoryPath = join(directory, 'memory.sqlite');
  const runtimePath = join(directory, 'runtime.sqlite');
  let memory = openSqliteMemoryHost(memoryPath);
  let runtime = new TaskRuntime(runtimePath);
  try {
    memory.provision(namespace);
    const append = (factId, path, sourceRevision) => memory.appendPublicSource(namespace, {
      vaultId: 'public-demo', path, factId, sourceRevision: sourceRevision.repeat(64),
      line: 1, summary: `Synthetic ${factId}`, observedAt: '2026-09-25T00:00:00.000Z',
      validFrom: '2026-09-25T00:00:00.000Z', validUntil: '2027-01-01T00:00:00.000Z',
      expectedFactRevision: null, ...context(),
    });
    append('a-target', 'target.md', 'a');
    append('b-other', 'other.md', 'b');
    let host = createSqliteFactProjectionHost({memory, runtime,
      memoryNamespace: namespace, graphNamespace: graph, consumerKey});
    assert.deepEqual(await host.drain({limit: 10, maxBatches: 2, ...context()}),
      {batches: 1, atWatermark: true});
    memory.beginFactErasure(namespace, {factId: 'a-target', expectedRevision: 1,
      operationId: 'synthetic-delete-1', ...context()});
    memory.close(); runtime.close();
    memory = openSqliteMemoryHost(memoryPath);
    runtime = new TaskRuntime(runtimePath);
    host = createSqliteFactProjectionHost({memory, runtime,
      memoryNamespace: namespace, graphNamespace: graph, consumerKey});
    const before = runtime.bindCoordinationStore(graph).read();
    const result = await host.preflightErasure('a-target', context());
    assert.equal(result.targetVersions, 1);
    assert.equal(result.affectedReceipts.length, 1);
    assert.deepEqual(result.affectedReceipts[0].survivingFacts, [{id: 'b-other', revision: 1}]);
    assert.equal(result.affectedReceipts[0].impact, 'pending');
    assert.deepEqual(runtime.bindCoordinationStore(graph).read(), before);
  } finally {
    memory.close(); runtime.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('Runtime erasure transaction preserves a mixed activated receipt and replays after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-agent-erasure-commit-'));
  const memoryPath = join(directory, 'memory.sqlite');
  const runtimePath = join(directory, 'runtime.sqlite');
  let memory = openSqliteMemoryHost(memoryPath);
  let runtime = new TaskRuntime(runtimePath);
  try {
    memory.provision(namespace);
    const append = (factId, path, sourceRevision) => memory.appendPublicSource(namespace, {
      vaultId: 'public-demo', path, factId, sourceRevision: sourceRevision.repeat(64),
      line: 1, summary: `Synthetic ${factId}`, observedAt: '2026-09-25T00:00:00.000Z',
      validFrom: '2026-09-25T00:00:00.000Z', validUntil: '2027-01-01T00:00:00.000Z',
      expectedFactRevision: null, ...context(),
    });
    append('a-target', 'target.md', 'a');
    append('b-other', 'other.md', 'b');
    let host = createSqliteFactProjectionHost({memory, runtime,
      memoryNamespace: namespace, graphNamespace: graph, consumerKey});
    await host.drain({limit: 10, maxBatches: 2, ...context()});
    const original = host.listImpactReceipts({afterGraphRevision: 0, limit: 10})[0].projection;
    assert.deepEqual(original.links.map(link => link.fact.id), ['a-target', 'b-other']);
    memory.beginFactErasure(namespace, {factId: 'a-target', expectedRevision: 1,
      operationId: 'synthetic-delete-commit', ...context()});
    const erasure = () => runtime.bindFactProjectionStore(graph).commitErasure({
      memoryNamespace: namespace, factId: 'a-target', operationId: 'synthetic-delete-commit',
      expectedGraphRevision: 2, ...context(),
      readDelivery: (consumer, batchToken, scope) =>
        memory.readFeedDelivery(namespace, consumer, {batchToken, ...scope}),
      readVersion: (fact, scope) =>
        memory.bind(namespace, {allowedSensitivities: ['public']}).getVersion({fact, ...scope}),
    });
    const fault = new DatabaseSync(runtimePath);
    try {
      fault.exec("CREATE TRIGGER abort_erasure BEFORE INSERT ON coordination_fact_erasure_receipts BEGIN SELECT RAISE(ABORT, 'synthetic rollback'); END;");
      await assert.rejects(erasure(), {code: 'STORAGE_UNAVAILABLE'});
      assert.equal(runtime.bindCoordinationStore(graph).read().history.length, 2);
      assert.deepEqual(host.listImpactReceipts({afterGraphRevision: 0, limit: 10})[0].projection,
        original);
      assert.deepEqual(runtime.bindFactProjectionStore(graph).readPending()[0].links
        .map(link => link.fact.id), ['a-target', 'b-other']);
      fault.exec('DROP TRIGGER abort_erasure');
    } finally {
      fault.close();
    }
    await erasure();
    const graphAfter = runtime.bindCoordinationStore(graph).read();
    assert.equal(graphAfter.revision, 2);
    assert.deepEqual(graphAfter.erasedGraphRevisions, [1]);
    assert.equal(graphAfter.history.length, 1);
    assert.equal(graphAfter.history[0].graphRevision, 2);
    assert.deepEqual(runtime.bindCoordinationStore(graph).read(1).history, []);
    const kept = host.listImpactReceipts({afterGraphRevision: 0, limit: 10})[0].projection;
    assert.deepEqual(kept.links.map(link => link.fact.id), ['b-other']);
    assert.deepEqual(runtime.bindFactProjectionStore(graph).readPending()[0].links
      .map(link => link.fact.id), ['b-other']);
    const readback = new DatabaseSync(runtimePath);
    try {
      assert.deepEqual(readback.prepare('SELECT fact_id FROM coordination_fact_projections WHERE graph_namespace = ? ORDER BY fact_id').all(graph)
        .map(row => row.fact_id), ['b-other']);
      assert.equal(readback.prepare('SELECT count(*) AS total FROM coordination_fact_erasure_receipts WHERE graph_namespace = ?').get(graph).total, 1);
    } finally {
      readback.close();
    }
    assert.equal(JSON.stringify(graphAfter).includes('Synthetic a-target'), false);
    memory.close(); runtime.close();
    memory = openSqliteMemoryHost(memoryPath);
    runtime = new TaskRuntime(runtimePath);
    host = createSqliteFactProjectionHost({memory, runtime,
      memoryNamespace: namespace, graphNamespace: graph, consumerKey});
    await erasure();
    assert.deepEqual(runtime.bindCoordinationStore(graph).read(), graphAfter);
    assert.deepEqual(host.listImpactReceipts({afterGraphRevision: 0, limit: 10})[0].projection, kept);
    await assert.rejects(runtime.bindFactProjectionStore(graph).commitErasure({
      memoryNamespace: namespace, factId: 'a-target', operationId: 'different-operation',
      expectedGraphRevision: 2, ...context(), readDelivery: () => { throw new Error('unused'); },
      readVersion: () => { throw new Error('unused'); },
    }), {code: 'INTEGRITY_CONFLICT'});
    const complete = () => host.resumeFactErasure({factId: 'a-target', expectedRevision: 1,
      operationId: 'synthetic-delete-commit', expectedGraphRevision: 2, ...context()});
    const memoryFault = new DatabaseSync(memoryPath);
    const checkpoint = memoryFault.prepare('SELECT checkpoint FROM memory_feed_bindings WHERE namespace = ? AND consumer_id = ?')
      .get(namespace, consumerKey).checkpoint;
    try {
      memoryFault.exec("CREATE TRIGGER abort_memory_completion BEFORE UPDATE ON memory_erasure_intents WHEN NEW.phase = 'completed' BEGIN SELECT RAISE(ABORT, 'synthetic memory rollback'); END;");
      await assert.rejects(complete(), {code: 'INVALID_ARGUMENT'});
      assert.equal(memoryFault.prepare('SELECT count(*) AS total FROM memory_facts WHERE namespace = ? AND fact_id = ?')
        .get(namespace, 'a-target').total, 1);
      assert.equal(memoryFault.prepare('SELECT phase FROM memory_erasure_intents WHERE namespace = ? AND fact_id = ?')
        .get(namespace, 'a-target').phase, 'pending');
      memoryFault.exec('DROP TRIGGER abort_memory_completion');
    } finally {
      memoryFault.close();
    }
    memory.close(); runtime.close();
    memory = openSqliteMemoryHost(memoryPath);
    runtime = new TaskRuntime(runtimePath);
    host = createSqliteFactProjectionHost({memory, runtime,
      memoryNamespace: namespace, graphNamespace: graph, consumerKey});
    await complete();
    await complete();
    const memoryReadback = new DatabaseSync(memoryPath);
    try {
      assert.deepEqual(memoryReadback.prepare('SELECT fact_id FROM memory_facts WHERE namespace = ? ORDER BY fact_id')
        .all(namespace).map(row => row.fact_id), ['b-other']);
      assert.equal(memoryReadback.prepare('SELECT count(*) AS total FROM memory_public_sources WHERE namespace = ? AND fact_id = ?')
        .get(namespace, 'a-target').total, 0);
      assert.equal(memoryReadback.prepare('SELECT phase FROM memory_erasure_intents WHERE namespace = ? AND fact_id = ?')
        .get(namespace, 'a-target').phase, 'completed');
      assert.equal(memoryReadback.prepare('SELECT checkpoint FROM memory_feed_bindings WHERE namespace = ? AND consumer_id = ?')
        .get(namespace, consumerKey).checkpoint, checkpoint);
    } finally {
      memoryReadback.close();
    }
    assert.deepEqual(memory.readFeedDelivery(namespace, consumerKey,
      {batchToken: original.batchToken, ...context()}).entries.map(entry => entry.fact.id), ['b-other']);
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
