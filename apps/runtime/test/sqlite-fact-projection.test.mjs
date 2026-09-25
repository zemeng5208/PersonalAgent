import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {openSqliteMemoryHost} from '@personal-agent/memory/sqlite';
import {TaskRuntime} from '../dist/index.js';
import {createSqliteFactProjectionHost} from '../dist/application.js';

const namespace = 'synthetic-public';
const graph = 'synthetic-graph';
const consumerKey = 'synthetic-cognition';
const source = {vaultId: 'public-demo', path: 'meeting.md', factId: 'meeting/update'};
const context = () => ({deadline: new Date(Date.now() + 60_000).toISOString(),
  signal: new AbortController().signal});

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

    memory.close(); runtime.close();
    memory = openSqliteMemoryHost(memoryPath);
    runtime = new TaskRuntime(runtimePath);
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
    assert.deepEqual((await memory.bind(namespace, {allowedSensitivities: ['public']})
      .listCurrent({at: '2026-09-25T03:00:00.000Z', limit: 10, ...context()})).facts, []);
    assert.deepEqual(await bind().drain({limit: 1, maxBatches: 3, ...context()}),
      {batches: 1, atWatermark: true});
    assert.equal(runtime.bindCoordinationStore(graph).read().history.length, 3);
  } finally {
    memory.close(); runtime.close();
    await rm(directory, {recursive: true, force: true});
  }
});
