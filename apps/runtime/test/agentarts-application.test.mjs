import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import {test} from 'node:test';
import {Client} from '@personal-agent/client';
import {createAgentArtsRuntimeApplication} from '../dist/application.js';

const event = text => ({event: 'message', data: {text, index: 0}});

async function terminal(app, taskId) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const task = app.runtime.getTask(taskId);
    if (['succeeded', 'failed', 'cancelled'].includes(task.state)) return task;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw Error('Task did not settle');
}

test('trusted factory runs the competition HTTP adapter without local fallback', async () => {
  const base = new URL('../../../.cache/agentarts-application-tests/', import.meta.url);
  await mkdir(base, {recursive: true});
  const directory = await mkdtemp(new URL('case-', base));
  const calls = [];
  let authorizationReads = 0;
  const app = createAgentArtsRuntimeApplication({
    path: directory + '/runtime.sqlite',
    gatewayUrl: 'https://agentarts.example.test',
    runtimeName: 'pa-runtime',
    invokeMode: 'published',
    authorizationProvider: {
      read: async () => {
        authorizationReads += 1;
        return 'Bearer synthetic-token';
      },
    },
    fetchImpl: async (url, init) => {
      calls.push({url, init});
      return new Response(JSON.stringify(event('合成任务已分析')), {
        status: 200,
        headers: {'content-type': 'application/json'},
      });
    },
  });
  try {
    const client = new Client(app, Date.now);
    await client.connect();
    const submitted = await client.call(
      'task.submit',
      {goal: '只分析合成事实，不执行工具', conversationId: 'competition'},
      {idempotencyKey: 'agentarts-runtime-factory'},
    );
    const task = await terminal(app, submitted.taskId);
    assert.equal(task.state, 'succeeded');
    assert.match(task.resultSummary, /合成任务已分析/);
    assert.match(task.resultSummary, /profile=huawei_ict_agentarts; verification=unverified/);
    assert.deepEqual(task.evidenceRefs, []);
    assert.equal(authorizationReads, 1);
    assert.equal(calls.length, 1);
    assert.deepEqual(JSON.parse(calls[0].init.body), {query: '只分析合成事实，不执行工具'});
    assert.equal(calls[0].url, 'https://agentarts.example.test/runtimes/pa-runtime/invocations');
    assert.throws(() => app.configureText({mode: 'fake'}), /unavailable/);
  } finally {
    app.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('HTTP 200 stream error after a partial message fails the task without persisting the partial answer', async () => {
  const base = new URL('../../../.cache/agentarts-application-tests/', import.meta.url);
  await mkdir(base, {recursive: true});
  const directory = await mkdtemp(new URL('stream-error-', base));
  const app = createAgentArtsRuntimeApplication({
    path: directory + '/runtime.sqlite',
    gatewayUrl: 'https://agentarts.example.test',
    runtimeName: 'pa-runtime',
    invokeMode: 'published',
    authorizationProvider: {read: async () => 'Bearer synthetic-token'},
    fetchImpl: async () => new Response([
      `data: ${JSON.stringify(event('部分回答'))}`,
      '',
      `data: ${JSON.stringify({event: 'error', data: {message: 'synthetic provider failure'}})}`,
      '',
    ].join('\n'), {
      status: 200,
      headers: {'content-type': 'text/event-stream'},
    }),
  });
  try {
    const client = new Client(app, Date.now);
    await client.connect();
    const submitted = await client.call(
      'task.submit',
      {goal: '验证流式失败传播', conversationId: 'competition'},
      {idempotencyKey: 'agentarts-stream-error'},
    );
    const task = await terminal(app, submitted.taskId);
    assert.equal(task.state, 'failed');
    assert.equal(task.error.code, 'EXTERNAL_FAILURE');
    assert.equal(task.error.message, 'Coordination adapter failed');
    assert.equal(task.resultSummary, undefined);
    assert.equal(app.readEvents().some(item => item.type === 'task.completed'), false);
    assert.equal(app.readEvents().some(item => item.type === 'task.failed'), true);
  } finally {
    app.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('invalid AgentArts deployment configuration fails before creating Runtime storage', async () => {
  const base = new URL('../../../.cache/agentarts-application-tests/', import.meta.url);
  await mkdir(base, {recursive: true});
  const directory = await mkdtemp(new URL('invalid-', base));
  const path = directory + '/must-not-exist.sqlite';
  try {
    assert.throws(() => createAgentArtsRuntimeApplication({
      path,
      gatewayUrl: 'http://insecure.example.test',
      runtimeName: 'pa-runtime',
      authorizationProvider: {read: async () => 'unused'},
    }), /HTTPS/);
    await assert.rejects(import('node:fs/promises').then(({access}) => access(path)));
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('trusted factory forwards the configured workflow start input', async () => {
  const bodies = [];
  const app = createAgentArtsRuntimeApplication({
    path: ':memory:', gatewayUrl: 'https://agentarts.example.test', runtimeName: 'workflow',
    workflowGoalInput: 'goal', authorizationProvider: {read: async () => 'Bearer synthetic-token'},
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify(event('Synthetic workflow result')), {
        status: 200, headers: {'content-type': 'application/json'},
      });
    },
  });
  try {
    const client = new Client(app);
    await client.connect();
    const {taskId} = await client.call('task.submit', {goal: 'Synthetic meeting', conversationId: 'workflow'}, {idempotencyKey: 'workflow'});
    assert.equal((await terminal(app, taskId)).state, 'succeeded');
    assert.deepEqual(bodies, [{inputs: {goal: 'Synthetic meeting'}}]);
  } finally { app.close(); }
});
