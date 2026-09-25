import assert from 'node:assert/strict';
import {test} from 'node:test';

import {RuntimeClientTranscriptConsumer} from '../dist/runtime-consumer.js';

for (const code of ['CANCELLED', 'TIMEOUT']) {
  test(`a fulfilled task.get cannot publish a reply after same-turn ${code}`, async t => {
    const parent = new AbortController();
    let now = Date.now();
    const deadlineMs = now + 2_000;
    t.mock.method(Date, 'now', () => now);
    const calls = [];
    const client = {
      call(operation) {
        calls.push(operation);
        if (operation === 'task.submit') {
          return Promise.resolve({taskId: 'synthetic-task', state: 'created', revision: 0});
        }
        assert.equal(operation, 'task.get');
        const ready = Promise.resolve({
          taskId: 'synthetic-task', state: 'succeeded', resultSummary: 'must not be spoken',
        });
        // Both the ready result and cancellation can be settled before Promise.race
        // attaches handlers. The deadline variant expires before its timer can run.
        if (code === 'CANCELLED') parent.abort();
        else now = deadlineMs;
        return ready;
      },
    };
    const consumer = new RuntimeClientTranscriptConsumer({
      client, conversationId: 'synthetic-conversation', pollIntervalMs: 1,
    });
    const operation = consumer.consume({
      sessionId: 'synthetic-session', transcriptId: 'synthetic-transcript',
      text: 'synthetic lifecycle regression', locale: 'zh-CN',
      deadline: new Date(deadlineMs).toISOString(), signal: parent.signal,
    });
    let replies = 0;
    void operation.result.then(() => { replies++; }, () => {});
    await assert.rejects(operation.result, {code});
    await operation.stop('disposed');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(replies, 0);
    assert.deepEqual(calls, ['task.submit', 'task.get']);
    assert.equal(calls.includes('task.cancel'), false);
  });
}

test('an active fulfilled task.get still returns the successful summary', async () => {
  const calls = [];
  const client = {
    call(operation) {
      calls.push(operation);
      return Promise.resolve(operation === 'task.submit'
        ? {taskId: 'synthetic-task', state: 'created', revision: 0}
        : {taskId: 'synthetic-task', state: 'succeeded', resultSummary: 'synthetic reply'});
    },
  };
  const consumer = new RuntimeClientTranscriptConsumer({client, conversationId: 'synthetic-conversation'});
  const operation = consumer.consume({
    sessionId: 'synthetic-session', transcriptId: 'synthetic-transcript',
    text: 'synthetic lifecycle regression', locale: 'zh-CN',
    deadline: new Date(Date.now() + 2_000).toISOString(), signal: new AbortController().signal,
  });
  assert.deepEqual(await operation.result, {replyText: 'synthetic reply', locale: 'zh-CN'});
  await operation.stop('disposed');
  assert.deepEqual(calls, ['task.submit', 'task.get']);
});
