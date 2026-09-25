import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
  MAX_SPEECH_CHARACTERS,
  RuntimeClientTranscriptConsumer,
} from '../dist/index.js';

const futureDeadline = (offsetMs = 2_000) => new Date(Date.now() + offsetMs).toISOString();
const request = (overrides = {}) => ({
  sessionId: 'voice-session-1',
  transcriptId: 'transcript-1',
  text: '查询明天的天气',
  locale: 'zh-CN',
  deadline: futureDeadline(),
  signal: new AbortController().signal,
  ...overrides,
});
const snapshot = (taskId, state, extras = {}) => ({taskId, state, ...extras});

class ScriptedClient {
  calls = [];

  constructor(handler) {
    this.handler = handler;
  }

  call(operation, payload, options = {}) {
    const call = {operation, payload, options};
    this.calls.push(call);
    return this.handler(call, this.calls.length);
  }
}

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.fail('condition was not reached');
}

test('the connected Client is untouched until explicit consume and submit uses only the public task fields', async () => {
  const client = new ScriptedClient(({operation}) => operation === 'task.submit'
    ? {taskId: 'task-1', state: 'created', revision: 0}
    : snapshot('task-1', 'succeeded', {resultSummary: '天气晴朗'}));
  const consumer = new RuntimeClientTranscriptConsumer({
    client,
    conversationId: 'conversation-1',
    pollIntervalMs: 1,
  });
  assert.equal(client.calls.length, 0);

  const operation = consumer.consume(request());
  assert.deepEqual(await operation.result, {replyText: '天气晴朗', locale: 'zh-CN'});
  assert.deepEqual(client.calls.map(call => call.operation), ['task.submit', 'task.get']);
  assert.deepEqual(client.calls[0].payload, {
    goal: '查询明天的天气',
    conversationId: 'conversation-1',
  });
  assert.equal(typeof client.calls[0].options.idempotencyKey, 'string');
  assert.equal(client.calls[0].options.idempotencyKey.length <= 64, true);
  assert.equal(client.calls[0].options.timeoutMs > 0, true);
  assert.equal('attachmentRefs' in client.calls[0].payload, false);
});

test('accepted and waiting_approval states never produce a reply before a succeeded snapshot', async () => {
  let getCount = 0;
  let resolveTerminal;
  const terminal = new Promise(resolve => { resolveTerminal = resolve; });
  const client = new ScriptedClient(({operation}) => {
    if (operation === 'task.submit') return {taskId: 'task-2', state: 'waiting_approval', revision: 1};
    getCount++;
    if (getCount === 1) return snapshot('task-2', 'waiting_approval');
    return terminal;
  });
  const consumer = new RuntimeClientTranscriptConsumer({client, conversationId: 'conversation-2', pollIntervalMs: 1});
  const operation = consumer.consume(request({sessionId: 'voice-session-2', transcriptId: 'transcript-2'}));
  let settled = false;
  void operation.result.finally(() => { settled = true; });
  await waitUntil(() => getCount === 2);
  assert.equal(settled, false);

  resolveTerminal(snapshot('task-2', 'succeeded', {resultSummary: '审批后完成'}));
  assert.deepEqual(await operation.result, {replyText: '审批后完成', locale: 'zh-CN'});
});

test('successful Runtime output reads only a bounded resultSummary', async () => {
  const longSummary = '回'.repeat(MAX_SPEECH_CHARACTERS + 100);
  const client = new ScriptedClient(({operation}) => operation === 'task.submit'
    ? {taskId: 'task-3', state: 'running', revision: 0}
    : snapshot('task-3', 'succeeded', {
        resultSummary: longSummary,
        privateModelOutput: 'must not be consumed',
      }));
  const consumer = new RuntimeClientTranscriptConsumer({client, conversationId: 'conversation-3', pollIntervalMs: 1});
  const result = await consumer.consume(request({sessionId: 'voice-session-3', transcriptId: 'transcript-3'})).result;

  assert.equal(result.replyText.length, MAX_SPEECH_CHARACTERS);
  assert.equal(result.replyText, longSummary.slice(0, MAX_SPEECH_CHARACTERS));
  assert.equal(JSON.stringify(result).includes('privateModelOutput'), false);
});

test('failed tasks and Client failures expose one fixed error without external text', async () => {
  const failed = new ScriptedClient(({operation}) => operation === 'task.submit'
    ? {taskId: 'task-4', state: 'running', revision: 0}
    : snapshot('task-4', 'failed', {
        resultSummary: 'private failed result',
        error: {code: 'PRIVATE', message: 'credential body', retryable: false},
      }));
  const first = new RuntimeClientTranscriptConsumer({client: failed, conversationId: 'conversation-4', pollIntervalMs: 1});
  await assert.rejects(
    first.consume(request({sessionId: 'voice-session-4', transcriptId: 'transcript-4'})).result,
    error => error.code === 'EXTERNAL_FAILURE'
      && error.message === 'Runtime transcript consumption failed'
      && !error.message.includes('credential body'),
  );

  const rejected = new ScriptedClient(() => { throw new Error('private transport response'); });
  const second = new RuntimeClientTranscriptConsumer({client: rejected, conversationId: 'conversation-4b'});
  await assert.rejects(
    second.consume(request({sessionId: 'voice-session-4b', transcriptId: 'transcript-4b'})).result,
    error => error.code === 'EXTERNAL_FAILURE'
      && error.message === 'Runtime transcript consumption failed'
      && !error.message.includes('private transport response'),
  );
});

test('stop and deadline bound non-cooperative Client calls without task.cancel or late revival', async () => {
  let resolveSubmit;
  const lateSubmit = new ScriptedClient(() => new Promise(resolve => { resolveSubmit = resolve; }));
  const consumer = new RuntimeClientTranscriptConsumer({client: lateSubmit, conversationId: 'conversation-5'});
  const operation = consumer.consume(request({sessionId: 'voice-session-5', transcriptId: 'transcript-5'}));
  await waitUntil(() => lateSubmit.calls.length === 1);
  await operation.stop('user');
  await assert.rejects(operation.result, error => error.code === 'CANCELLED');
  resolveSubmit({taskId: 'late-task', state: 'created', revision: 0});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(lateSubmit.calls.map(call => call.operation), ['task.submit']);

  const never = new ScriptedClient(() => new Promise(() => {}));
  const expiring = new RuntimeClientTranscriptConsumer({client: never, conversationId: 'conversation-5b'});
  const startedAt = Date.now();
  await assert.rejects(
    expiring.consume(request({
      sessionId: 'voice-session-5b',
      transcriptId: 'transcript-5b',
      deadline: futureDeadline(30),
    })).result,
    error => error.code === 'TIMEOUT' && error.message === 'Runtime transcript deadline expired',
  );
  assert.equal(Date.now() - startedAt < 500, true);
  assert.deepEqual(never.calls.map(call => call.operation), ['task.submit']);
  assert.equal([...lateSubmit.calls, ...never.calls].some(call => call.operation === 'task.cancel'), false);
});

test('identity reuse is stable, changed text is rejected, and synchronous abort performs zero calls', async () => {
  let task = 0;
  const client = new ScriptedClient(({operation, payload}) => {
    if (operation === 'task.submit') return {taskId: `task-${++task}`, state: 'created', revision: 0};
    return snapshot(payload.taskId, 'succeeded', {resultSummary: '已完成'});
  });
  const consumer = new RuntimeClientTranscriptConsumer({client, conversationId: 'conversation-6', pollIntervalMs: 1});
  const stableRequest = request({sessionId: 'voice-session-6', transcriptId: 'transcript-6'});
  await consumer.consume(stableRequest).result;
  await consumer.consume(stableRequest).result;
  const submitCalls = client.calls.filter(call => call.operation === 'task.submit');
  assert.equal(submitCalls.length, 2);
  assert.equal(submitCalls[0].options.idempotencyKey, submitCalls[1].options.idempotencyKey);

  const mutable = request({
    sessionId: 'voice-session-6-captured',
    transcriptId: 'transcript-6-captured',
    text: '入口原始文本',
  });
  const capturedOperation = consumer.consume(mutable);
  mutable.text = '同一 tick 修改后的文本';
  await capturedOperation.result;
  const capturedSubmit = client.calls.filter(call => call.operation === 'task.submit').at(-1);
  assert.equal(capturedSubmit.payload.goal, '入口原始文本');

  const beforeChangedInput = client.calls.length;
  assert.throws(
    () => consumer.consume({...stableRequest, text: '不同的转写文本'}),
    error => error.code === 'INVALID_STATE' && error.message === 'Runtime transcript identity input changed',
  );
  assert.equal(client.calls.length, beforeChangedInput);

  const aborted = new AbortController();
  aborted.abort();
  const beforeAbort = client.calls.length;
  await assert.rejects(
    consumer.consume(request({
      sessionId: 'voice-session-6b',
      transcriptId: 'transcript-6b',
      signal: aborted.signal,
    })).result,
    error => error.code === 'CANCELLED',
  );
  assert.equal(client.calls.length, beforeAbort);
});
