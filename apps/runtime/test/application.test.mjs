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

async function submit(client, goal, idempotencyKey = crypto.randomUUID()) {
  return client.call('task.submit', {goal, conversationId: 'runtime-application-test'}, {idempotencyKey});
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
