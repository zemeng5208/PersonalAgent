import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {Client} from '@personal-agent/client';
import {FakeModelProvider} from '@personal-agent/models';
import {createRuntimeApplication} from '../dist/application.js';

async function withApplication(text, run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'personal-agent-runtime-app-'));
  const application = createRuntimeApplication({path: path.join(directory, 'runtime.sqlite'), text});
  try {
    const client = new Client(application, Date.now);
    await client.connect();
    return await run({application, client});
  } finally {
    application.close();
    await rm(directory, {recursive: true, force: true});
  }
}

async function submit(client, goal, idempotencyKey = crypto.randomUUID(), conversationId = 'runtime-application-test') {
  return client.call('task.submit', {goal, conversationId}, {idempotencyKey});
}

async function waitForTerminal(application, taskId) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const task = application.runtime.getTask(taskId);
    if (['succeeded', 'failed', 'cancelled'].includes(task.state)) return task;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Task ${taskId} did not reach a terminal state`);
}

test('task.submit alone dispatches one explicit Fake Model execution', async () => {
  const provider = new FakeModelProvider([
    request => ({kind: 'final', text: `回答：${request.messages.at(-1)?.content ?? ''}`}),
  ], {provider: 'fake', deployment: 'runtime-app-fake', model: 'fake-text', verification: 'mock',
    capabilities: {text: true, streaming: false, toolCalling: false, structuredOutput: false, vision: false}});
  await withApplication({provider}, async ({application, client}) => {
    const submitted = await submit(client, '你好');
    const task = await waitForTerminal(application, submitted.taskId);
    assert.equal(task.state, 'succeeded');
    assert.match(task.resultSummary, /回答：你好/);
    assert.equal(provider.requests.length, 1);
    assert.equal(Object.hasOwn(provider.requests[0], 'maxOutputTokens'), false);
    assert.equal(application.activeTaskCount, 0);
  });
});

test('duplicate concurrent submission is idempotent and does not execute twice', async () => {
  const provider = new FakeModelProvider([
    request => new Promise(resolve => setTimeout(() => resolve({kind: 'final', text: '一次'}), 20)),
  ], {provider: 'fake', deployment: 'runtime-app-duplicate', model: 'fake-text', verification: 'mock',
    capabilities: {text: true, streaming: false, toolCalling: false, structuredOutput: false, vision: false}});
  await withApplication({provider}, async ({application, client}) => {
    const [first, second] = await Promise.all([
      submit(client, '相同任务', 'same-submit'),
      submit(client, '相同任务', 'same-submit'),
    ]);
    assert.equal(first.taskId, second.taskId);
    await waitForTerminal(application, first.taskId);
    assert.equal(provider.requests.length, 1);
  });
});

test('unavailable model produces a truthful failed task', async () => {
  await withApplication({mode: 'unavailable', model: 'not-configured'}, async ({application, client}) => {
    const submitted = await submit(client, '未配置模型');
    const task = await waitForTerminal(application, submitted.taskId);
    assert.equal(task.state, 'failed');
    assert.match(task.error.message, /not configured|does not support text/);
    assert.equal(task.resultSummary, undefined);
  });
});

test('cancellation reaches Runtime and aborts the active text request', async () => {
  let requestSignal;
  const provider = new FakeModelProvider([
    request => new Promise((_resolve, reject) => {
      requestSignal = request.signal;
      request.signal.addEventListener('abort', () => reject(new Error('request aborted')), {once: true});
    }),
  ], {provider: 'fake', deployment: 'runtime-app-cancel', model: 'fake-text', verification: 'mock',
    capabilities: {text: true, streaming: false, toolCalling: false, structuredOutput: false, vision: false}});
  await withApplication({provider}, async ({application, client}) => {
    const submitted = await submit(client, '等待取消');
    for (let attempt = 0; attempt < 100 && !requestSignal; attempt += 1) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(requestSignal, 'model request should have started');
    const cancel = await client.call('task.cancel', {taskId: submitted.taskId, reason: '测试取消'});
    assert.equal(cancel.state, 'cancelling');
    const task = await waitForTerminal(application, submitted.taskId);
    assert.equal(task.state, 'cancelled');
    assert.equal(requestSignal.aborted, true);
  });
});

test('Runtime Application exposes model connection test and preserves event order', async () => {
  const connectionResponse = request => ({kind: 'final', text: 'OK'});
  const provider = new FakeModelProvider([
    connectionResponse,
    connectionResponse,
  ], {provider: 'fake', deployment: 'runtime-app-connection', model: 'fake-text', verification: 'mock',
    capabilities: {text: true, streaming: false, toolCalling: false, structuredOutput: false, vision: false}});
  await withApplication({provider}, async ({application, client}) => {
    const probe = await application.testTextConnection({deadlineMs: 1_000});
    assert.equal(probe.response.text, 'OK');
    assert.equal(provider.requests.length, 1);
    const submitted = await submit(client, '事件顺序');
    await waitForTerminal(application, submitted.taskId);
    const events = application.readEvents().filter(event => event.taskId === submitted.taskId);
    assert.equal(events[0].type, 'task.created');
    assert.equal(events.at(-1).type, 'task.completed');
    assert.deepEqual(events.filter(event => event.type === 'task.state_changed').map(event => event.payload.state),
      ['planning', 'running', 'verifying', 'succeeded']);
  });
});

test('same conversation reuses successful turns and isolates other conversations', async () => {
  const provider = new FakeModelProvider([
    () => ({kind: 'final', text: '第一轮回答'}),
    () => ({kind: 'final', text: '第二轮回答'}),
    () => ({kind: 'final', text: '其他会话回答'}),
  ], {provider: 'fake', deployment: 'runtime-app-context', model: 'fake-text', verification: 'mock',
    capabilities: {text: true, streaming: false, toolCalling: false, structuredOutput: false, vision: false}});
  await withApplication({provider}, async ({application, client}) => {
    const first = await submit(client, '第一轮问题', 'context-first', 'conversation-a');
    assert.equal((await waitForTerminal(application, first.taskId)).state, 'succeeded');
    const second = await submit(client, '第二轮问题', 'context-second', 'conversation-a');
    assert.equal((await waitForTerminal(application, second.taskId)).state, 'succeeded');
    assert.deepEqual(provider.requests[1].messages, [
      {role: 'user', content: '第一轮问题'},
      {role: 'assistant', content: '第一轮回答'},
      {role: 'user', content: '第二轮问题'},
    ]);

    const other = await submit(client, '其他会话问题', 'context-other', 'conversation-b');
    assert.equal((await waitForTerminal(application, other.taskId)).state, 'succeeded');
    assert.deepEqual(provider.requests[2].messages, [{role: 'user', content: '其他会话问题'}]);
  });
});

test('failed and cancelled turns are excluded from later conversation context', async () => {
  let requestSignal;
  const provider = new FakeModelProvider([
    () => { throw new Error('planned fake failure'); },
    request => new Promise((_resolve, reject) => {
      requestSignal = request.signal;
      request.signal.addEventListener('abort', () => reject(new Error('request aborted')), {once: true});
    }),
    () => ({kind: 'final', text: '只保留成功回答'}),
  ], {provider: 'fake', deployment: 'runtime-app-context-filter', model: 'fake-text', verification: 'mock',
    capabilities: {text: true, streaming: false, toolCalling: false, structuredOutput: false, vision: false}});
  await withApplication({provider}, async ({application, client}) => {
    const failed = await submit(client, '失败问题', 'context-failed', 'conversation-filter');
    assert.equal((await waitForTerminal(application, failed.taskId)).state, 'failed');
    const cancelled = await submit(client, '取消问题', 'context-cancelled', 'conversation-filter');
    for (let attempt = 0; attempt < 100 && !requestSignal; attempt += 1) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(requestSignal, 'cancelled model request should have started');
    await client.call('task.cancel', {taskId: cancelled.taskId, reason: '上下文测试取消'});
    assert.equal((await waitForTerminal(application, cancelled.taskId)).state, 'cancelled');
    const successful = await submit(client, '成功问题', 'context-successful', 'conversation-filter');
    assert.equal((await waitForTerminal(application, successful.taskId)).state, 'succeeded');
    assert.deepEqual(provider.requests[2].messages, [{role: 'user', content: '成功问题'}]);
  });
});

test('conversation context is capped at the latest twenty successful turns', async () => {
  const provider = new FakeModelProvider(
    Array.from({length: 22}, (_, index) => () => ({kind: 'final', text: `回答${index + 1}`})),
    {provider: 'fake', deployment: 'runtime-app-context-limit', model: 'fake-text', verification: 'mock',
      capabilities: {text: true, streaming: false, toolCalling: false, structuredOutput: false, vision: false}},
  );
  await withApplication({provider}, async ({application, client}) => {
    for (let index = 0; index < 21; index += 1) {
      const submitted = await submit(client, `问题${index + 1}`, `context-limit-${index}`, 'conversation-limit');
      assert.equal((await waitForTerminal(application, submitted.taskId)).state, 'succeeded');
    }
    const current = await submit(client, '第22个问题', 'context-limit-current', 'conversation-limit');
    assert.equal((await waitForTerminal(application, current.taskId)).state, 'succeeded');
    assert.equal(application.runtime.readConversationHistory('conversation-limit', current.taskId).length, 20);
    assert.equal(provider.requests.at(-1).messages.length, 41);
    assert.equal(provider.requests.at(-1).messages[0].content, '问题2');
    assert.equal(provider.requests.at(-1).messages.at(-1).content, '第22个问题');
  });
});

test('conversation context survives Runtime Application restart', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'personal-agent-runtime-restart-'));
  const databasePath = path.join(directory, 'runtime.sqlite');
  const metadata = {provider: 'fake', deployment: 'runtime-app-restart', model: 'fake-text', verification: 'mock',
    capabilities: {text: true, streaming: false, toolCalling: false, structuredOutput: false, vision: false}};
  const firstProvider = new FakeModelProvider([() => ({kind: 'final', text: '重启前回答'})], metadata);
  const firstApplication = createRuntimeApplication({path: databasePath, text: {provider: firstProvider}});
  try {
    const firstClient = new Client(firstApplication, Date.now);
    await firstClient.connect();
    const first = await submit(firstClient, '重启前问题', 'restart-first', 'conversation-restart');
    assert.equal((await waitForTerminal(firstApplication, first.taskId)).state, 'succeeded');
  } finally {
    firstApplication.close();
  }

  const secondProvider = new FakeModelProvider([() => ({kind: 'final', text: '重启后回答'})], metadata);
  const secondApplication = createRuntimeApplication({path: databasePath, text: {provider: secondProvider}});
  try {
    const secondClient = new Client(secondApplication, Date.now);
    await secondClient.connect();
    const second = await submit(secondClient, '重启后问题', 'restart-second', 'conversation-restart');
    assert.equal((await waitForTerminal(secondApplication, second.taskId)).state, 'succeeded');
    assert.deepEqual(secondProvider.requests[0].messages, [
      {role: 'user', content: '重启前问题'},
      {role: 'assistant', content: '重启前回答'},
      {role: 'user', content: '重启后问题'},
    ]);
  } finally {
    secondApplication.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('close rejects active work instead of silently abandoning it', async () => {
  let requestSignal;
  const provider = new FakeModelProvider([
    request => new Promise((_resolve, reject) => {
      requestSignal = request.signal;
      request.signal.addEventListener('abort', () => reject(new Error('request aborted')), {once: true});
    }),
  ], {provider: 'fake', deployment: 'runtime-app-close', model: 'fake-text', verification: 'mock',
    capabilities: {text: true, streaming: false, toolCalling: false, structuredOutput: false, vision: false}});
  await withApplication({provider}, async ({application, client}) => {
    const submitted = await submit(client, '活动任务');
    for (let attempt = 0; attempt < 100 && !requestSignal; attempt += 1) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(requestSignal);
    assert.throws(() => application.close(), /active/);
    await client.call('task.cancel', {taskId: submitted.taskId, reason: '关闭测试'});
    assert.equal((await waitForTerminal(application, submitted.taskId)).state, 'cancelled');
  });
});
