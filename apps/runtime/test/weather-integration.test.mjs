import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {Client} from '@personal-agent/client';
import {FakeWeatherProvider} from '@personal-agent/weather';
import {createOpenMeteoRuntime, createWeatherRuntime} from '../dist/weather-runtime.js';

const root = fileURLToPath(new URL('../../../.cache/weather-runtime-tests/', import.meta.url));
mkdirSync(root, {recursive: true});
const file = () => join(mkdtempSync(join(root, 'case-')), 'runtime.sqlite');

function fixture() {
  let sequence = 0;
  const bundle = createWeatherRuntime({
    path: file(),
    now: () => new Date('2026-09-06T02:00:00.000Z'),
    idFactory: () => 'weather-' + ++sequence,
    provider: new FakeWeatherProvider(),
  });
  return bundle;
}

async function connected(bundle) {
  const client = new Client(bundle.runtime, () => Date.parse('2026-09-06T02:00:00.000Z'));
  await client.connect();
  return client;
}

test('production composition registers strict Open-Meteo without making a network request', async () => {
  const bundle = createOpenMeteoRuntime({
    path: file(),
    now: () => new Date('2026-09-06T02:00:00.000Z'),
  });
  try {
    const client = await connected(bundle);
    const capabilities = await client.call('capability.list', {kind: 'tool'});
    assert.deepEqual(capabilities.manifests.map(item => item.name), ['weather.forecast']);
    assert.equal(capabilities.manifests[0].requiredScopes[0], 'weather:read');
  } finally {
    bundle.dispose();
  }
});

test('weather forecast crosses Client, Runtime, Policy and ToolGateway using an explicit Fake provider', async () => {
  const bundle = fixture();
  try {
    const client = await connected(bundle);
    const task = await client.call('task.submit', {
      goal: 'read the weather through the guarded tool path',
      conversationId: 'weather-integration',
    }, {idempotencyKey: 'weather-task'});
    bundle.runtime.transitionTask(task.taskId, 'planning');
    bundle.runtime.transitionTask(task.taskId, 'running');
    bundle.policy.grant({
      authorizationRef: 'weather-auth',
      taskId: task.taskId,
      toolName: 'weather.forecast',
      scopes: ['weather:read'],
      expiresAt: '2026-09-06T02:10:00.000Z',
    });

    const result = await client.call('tool.invoke', {
      toolName: 'weather.forecast',
      toolVersion: '0.1.0-alpha.1',
      arguments: {location: 'Beijing', date: '2026-09-06', units: 'metric'},
      scopeRef: 'weather-auth',
    }, {taskId: task.taskId});

    assert.equal(result.state, 'confirmed');
    assert.equal(result.result.forecast.location, 'Beijing');
    assert.equal(result.result.forecast.date, '2026-09-06');
    assert.equal(result.result.cache.state, 'fetched');
    assert.equal(result.result.record.source, 'fixture-weather');
    assert.equal(bundle.runtime.readEvents().at(-1).type, 'tool.completed');
    assert.equal(bundle.runtime.readEvents().at(-1).taskId, task.taskId);

    bundle.policy.revoke('weather-auth');
    await assert.rejects(client.call('tool.invoke', {
      toolName: 'weather.forecast',
      toolVersion: '0.1.0-alpha.1',
      arguments: {location: 'Beijing', date: '2026-09-06'},
      scopeRef: 'weather-auth',
    }, {taskId: task.taskId}), {code: 'UNAUTHORIZED'});
  } finally {
    bundle.dispose();
  }
});

test('Runtime rejects weather invocation for a non-running task before the provider is called', async () => {
  const provider = new FakeWeatherProvider();
  const bundle = createWeatherRuntime({
    path: file(),
    now: () => new Date('2026-09-06T02:00:00.000Z'),
    provider,
  });
  try {
    const client = await connected(bundle);
    const task = await client.call('task.submit', {
      goal: 'reject inactive weather task',
      conversationId: 'weather-integration',
    }, {idempotencyKey: 'inactive-weather-task'});
    bundle.policy.grant({
      authorizationRef: 'inactive-auth',
      taskId: task.taskId,
      toolName: 'weather.forecast',
      scopes: ['weather:read'],
      expiresAt: '2026-09-06T02:10:00.000Z',
    });
    await assert.rejects(client.call('tool.invoke', {
      toolName: 'weather.forecast',
      toolVersion: '0.1.0-alpha.1',
      arguments: {location: 'Beijing', date: '2026-09-06'},
      scopeRef: 'inactive-auth',
    }, {taskId: task.taskId}), {code: 'REVISION_CONFLICT'});
    assert.equal(provider.fetchCalls, 0);
  } finally {
    bundle.dispose();
  }
});
