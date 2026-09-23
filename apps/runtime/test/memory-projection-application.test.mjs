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

test('Runtime Application replays a locally committed batch after provider confirmation was interrupted', async t => {
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
    feed,
    memory: query,
    projection,
    confirmation: {confirm: () => { throw new Error('simulated crash before provider confirmation'); }}
  });

  await assert.rejects(() => interrupted.consume(context()), /simulated crash/);
  assert.equal(runtime.bindCoordinationStore('primary').read().revision, 1);
  assert.equal(projection.readPending().length, 1);
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
});
