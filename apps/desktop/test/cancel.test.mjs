import test from 'node:test';
import assert from 'node:assert/strict';
import {requestTaskCancellation} from '../electron/runtime.js';

test('task cancellation returns the single refreshed state without requiring a terminal task', async t => {
  const cases = [
    {state: 'waiting_reconciliation', cancelAccepted: true},
    {state: 'cancelling', cancelAccepted: true},
    {state: 'cancelled', cancelAccepted: false},
  ];
  for (const item of cases) {
    await t.test(item.state, async () => {
      const calls = [];
      const client = {
        async call(operation, payload) {
          calls.push({operation, payload});
          return {taskId: 'task-1', state: item.state, cancelAccepted: item.cancelAccepted};
        },
      };
      let refreshCount = 0;
      const result = await requestTaskCancellation(client, 'task-1', async taskId => {
        refreshCount++;
        assert.equal(taskId, 'task-1');
        return {taskId, state: item.state};
      });

      assert.deepEqual(calls, [{operation: 'task.cancel', payload: {taskId: 'task-1', reason: '用户取消任务'}}]);
      assert.equal(refreshCount, 1);
      assert.deepEqual(result, {taskId: 'task-1', state: item.state, cancelAccepted: item.cancelAccepted});
    });
  }
});

test('task cancellation preserves a refresh failure', async () => {
  const failure = new Error('refresh failed');
  const client = {
    async call() {
      return {taskId: 'task-1', state: 'cancelling', cancelAccepted: true};
    },
  };

  await assert.rejects(
    requestTaskCancellation(client, 'task-1', async () => { throw failure; }),
    error => error === failure,
  );
});
