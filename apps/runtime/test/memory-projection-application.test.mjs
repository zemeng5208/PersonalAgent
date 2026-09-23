import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openSqliteMemoryHost} from '@personal-agent/memory/sqlite';
import {TaskRuntime} from '../dist/index.js';
import {createMemoryProjectionApplication} from '../dist/application.js';

function context() {
  return {
    limit: 10,
    deadline: new Date(Date.now() + 60_000).toISOString(),
    signal: new AbortController().signal
  };
}

function sourceFact() {
  return {
    ref: {id: 'calendar/location', revision: 1},
    summary: 'Meeting is in Shenzhen',
    sourceRef: 'calendar/event-1',
    observedAt: '2026-09-22T00:00:00.000Z',
    validFrom: '2026-09-22T00:00:00.000Z',
    validUntil: '2026-12-31T00:00:00.000Z',
    sensitivity: 'private',
    state: 'active',
    confirmation: 'external_observation'
  };
}

test('Runtime Application replays an inactive staged batch after provider confirmation was interrupted', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-memory-projection-app-'));
  const memoryPath = join(dir, 'memory.sqlite');
  const runtimePath = join(dir, 'runtime.sqlite');
  let memoryHost = openSqliteMemoryHost(memoryPath);
  let runtime = new TaskRuntime(runtimePath);
  t.after(() => {
    memoryHost.close();
    runtime.close();
    rmSync(dir, {recursive: true, force: true});
  });
  memoryHost.provision('personal');
  memoryHost.append('personal', sourceFact());

  let query = memoryHost.bind('personal', {allowedSensitivities: ['private']});
  let feed = memoryHost.bindFeed('personal', {
    consumerId: 'cognition',
    allowedSensitivities: ['private']
  });
  let projection = runtime.provisionFactProjectionStore('primary');
  const interrupted = createMemoryProjectionApplication({
    consumerKey: 'cognition',
    memoryNamespace: 'personal',
    feed: {read: ({limit, deadline, signal}) => feed.read({limit, deadline, signal})},
    memory: query,
    projection,
    confirmation: {confirm: () => { throw new Error('simulated crash before provider confirmation'); }}
  });

  await assert.rejects(() => interrupted.consume({
    ...context(), consumerKey: 'forged-consumer', memoryNamespace: 'forged-namespace'
  }), /simulated crash/);
  assert.equal(runtime.bindCoordinationStore('primary').read().revision, 0);
  assert.deepEqual(projection.readPending(), []);
  assert.ok(projection.readStaged('cognition', 'personal'));
  memoryHost.close();
  runtime.close();

  memoryHost = openSqliteMemoryHost(memoryPath);
  runtime = new TaskRuntime(runtimePath);
  query = memoryHost.bind('personal', {allowedSensitivities: ['private']});
  feed = memoryHost.bindFeed('personal', {
    consumerId: 'cognition',
    allowedSensitivities: ['private']
  });
  projection = runtime.bindFactProjectionStore('primary');
  const recovered = createMemoryProjectionApplication({
    consumerKey: 'cognition',
    memoryNamespace: 'personal',
    feed,
    memory: query,
    projection,
    confirmation: {
      confirm: request => memoryHost.confirmFeedBatch('personal', 'cognition', request)
    }
  });

  const result = await recovered.consume(context());
  assert.equal(result.projection.graphRevision, 1);
  assert.equal(result.providerReceipt.batchToken, result.batch.batchToken);
  assert.equal(runtime.bindCoordinationStore('primary').read().history.length, 1);
  assert.equal(projection.readPending().length, 1);
  assert.equal(projection.readStaged('cognition', 'personal'), undefined);
});

test('confirmed provider batch activates from staging after restart without reading the next batch', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-memory-confirmed-stage-'));
  const memoryPath = join(dir, 'memory.sqlite');
  const runtimePath = join(dir, 'runtime.sqlite');
  let memoryHost = openSqliteMemoryHost(memoryPath);
  let runtime = new TaskRuntime(runtimePath);
  t.after(() => { memoryHost.close(); runtime.close(); rmSync(dir, {recursive: true, force: true}); });
  memoryHost.provision('personal');
  memoryHost.append('personal', sourceFact());
  let projection = runtime.provisionFactProjectionStore('primary');
  const interrupted = createMemoryProjectionApplication({
    consumerKey: 'cognition', memoryNamespace: 'personal',
    feed: memoryHost.bindFeed('personal', {consumerId: 'cognition', allowedSensitivities: ['private']}),
    memory: memoryHost.bind('personal', {allowedSensitivities: ['private']}),
    projection: {...projection, project: () => { throw new Error('simulated crash before activation'); }},
    confirmation: {confirm: request => memoryHost.confirmFeedBatch('personal', 'cognition', request)}
  });

  await assert.rejects(() => interrupted.consume(context()), /simulated crash/);
  assert.equal(runtime.bindCoordinationStore('primary').read().revision, 0);
  assert.deepEqual(projection.readPending(), []);
  assert.ok(projection.readStaged('cognition', 'personal'));
  memoryHost.close();
  runtime.close();

  memoryHost = openSqliteMemoryHost(memoryPath);
  runtime = new TaskRuntime(runtimePath);
  projection = runtime.bindFactProjectionStore('primary');
  const recovered = createMemoryProjectionApplication({
    consumerKey: 'cognition', memoryNamespace: 'personal',
    feed: {read: () => { throw new Error('must recover staging before reading feed'); }},
    memory: memoryHost.bind('personal', {allowedSensitivities: ['private']}),
    projection,
    confirmation: {confirm: request => memoryHost.confirmFeedBatch('personal', 'cognition', request)}
  });
  assert.equal((await recovered.consume(context())).projection.graphRevision, 1);
  assert.equal(runtime.bindCoordinationStore('primary').read().history.length, 1);
  assert.equal(projection.readStaged('cognition', 'personal'), undefined);
});

test('rejected provider confirmation leaves no effective graph or pending impact', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-memory-projection-scope-'));
  const memoryHost = openSqliteMemoryHost(join(dir, 'memory.sqlite'));
  const runtime = new TaskRuntime(join(dir, 'runtime.sqlite'));
  t.after(() => { memoryHost.close(); runtime.close(); rmSync(dir, {recursive: true, force: true}); });
  memoryHost.provision('personal');
  memoryHost.append('personal', sourceFact());
  const query = memoryHost.bind('personal', {allowedSensitivities: ['private']});
  const feed = memoryHost.bindFeed('personal', {
    consumerId: 'cognition', allowedSensitivities: ['private']
  });
  const projection = runtime.provisionFactProjectionStore('primary');
  const application = createMemoryProjectionApplication({
    consumerKey: 'cognition', memoryNamespace: 'personal', feed, memory: query, projection,
    confirmation: {confirm: request => {
      memoryHost.append('personal', {
        ...sourceFact(), ref: {id: 'calendar/location', revision: 2},
        corrects: {id: 'calendar/location', revision: 1}, sensitivity: 'restricted'
      });
      return memoryHost.confirmFeedBatch('personal', 'cognition', request);
    }}
  });

  await assert.rejects(() => application.consume(context()), {code: 'REBUILD_REQUIRED'});
  assert.equal(runtime.bindCoordinationStore('primary').read().revision, 0);
  assert.deepEqual(projection.readPending(), []);
  assert.equal(projection.readStaged('cognition', 'personal'), undefined);
});
