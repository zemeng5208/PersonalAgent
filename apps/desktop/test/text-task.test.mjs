import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@personal-agent/client';
import {TaskRuntime} from '@personal-agent/runtime';
import {FakeModelProvider, UnavailableModelProvider} from '@personal-agent/models';
import {createFakeTextProvider, startTextTask} from '../electron/text-task.js';

async function withRuntime(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'personal-agent-text-'));
  const runtime = new TaskRuntime(path.join(directory, 'runtime.sqlite'));
  try {
    const client = new Client(runtime, Date.now);
    await client.connect();
    return await run({runtime, client});
  } finally {
    runtime.close();
    await rm(directory, {recursive: true, force: true});
  }
}

async function submit(client, goal) {
  return client.call('task.submit', {goal, conversationId: 'desktop-test'}, {idempotencyKey: crypto.randomUUID()});
}

async function waitForTerminal(runtime, taskId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const task = runtime.getTask(taskId);
    if (['succeeded', 'failed', 'cancelled'].includes(task.state)) return task;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Task ${taskId} did not reach a terminal state`);
}

test('text task uses Runtime and explicit Fake Model to persist an answer', async () => {
  await withRuntime(async ({runtime, client}) => {
    const submitted = await submit(client, '你好');
    const provider = createFakeTextProvider();
    await startTextTask(runtime, submitted.taskId, '你好', provider);
    const task = await waitForTerminal(runtime, submitted.taskId);
    assert.equal(task.state, 'succeeded');
    assert.match(task.resultSummary, /Fake Model 回答：你好/);
    assert.match(task.resultSummary, /model=fake\/desktop-fake-text\/fake-text-model/);
    assert.equal(provider.requests.length, 1);
    assert.deepEqual(provider.requests[0].tools, []);
  });
});

test('unavailable Provider fails truthfully without a Fake fallback', async () => {
  await withRuntime(async ({runtime, client}) => {
    const submitted = await submit(client, '未配置模型');
    await startTextTask(runtime, submitted.taskId, '未配置模型', new UnavailableModelProvider('pangu'));
    const task = await waitForTerminal(runtime, submitted.taskId);
    assert.equal(task.state, 'failed');
    assert.match(task.error.message, /not configured|does not support text/);
    assert.equal(task.resultSummary, undefined);
  });
});

test('a continuing turn sends previous user and assistant messages through the model gateway',async()=>{
  await withRuntime(async({runtime,client})=>{
    const provider=new FakeModelProvider([request=>({kind:'final',text:request.messages[0].content})]);
    const submitted=await submit(client,'我刚才说了什么？');
    await startTextTask(runtime,submitted.taskId,'我刚才说了什么？',provider,{history:[{role:'user',content:'记住这次的项目名称'},{role:'assistant',content:'好的'}]});
    assert.deepEqual(provider.requests[0].messages.map(message=>message.role),['user','assistant','user']);
    assert.equal(provider.requests[0].messages[0].content,'记住这次的项目名称');
    assert.equal(provider.requests[0].messages.at(-1).content,'我刚才说了什么？');
    assert.equal((await waitForTerminal(runtime,submitted.taskId)).state,'succeeded');
  });
});

test('cancelling a text task aborts the in-flight model request', async () => {
  await withRuntime(async ({runtime, client}) => {
    let signal;
    const provider = new FakeModelProvider([request => new Promise((resolve, reject) => {
      signal = request.signal;
      request.signal.addEventListener('abort', () => reject(new Error('fake request aborted')), {once: true});
    })]);
    const submitted = await submit(client, '等待取消');
    const execution = startTextTask(runtime, submitted.taskId, '等待取消', provider, {deadlineMs: 5_000});
    for (let attempt = 0; attempt < 100 && !signal; attempt += 1) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(signal, 'model request should have started');
    const cancel = await client.call('task.cancel', {taskId: submitted.taskId, reason: '测试取消'});
    assert.equal(cancel.state, 'cancelling');
    await execution;
    const task = await waitForTerminal(runtime, submitted.taskId);
    assert.equal(task.state, 'cancelled');
    assert.equal(signal.aborted, true);
  });
});
