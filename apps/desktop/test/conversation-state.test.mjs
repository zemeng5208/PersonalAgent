import test from 'node:test';
import assert from 'node:assert/strict';
import {currentTask, orbState} from '../src/features/conversation/state.js';

test('desktop status follows an unfinished task when a newer turn has finished', () => {
  const tasks = [
    {taskId: 'first', state: 'waiting_approval'},
    {taskId: 'second', state: 'succeeded'},
  ];
  assert.equal(currentTask(tasks)?.taskId, 'first');
  assert.equal(orbState(currentTask(tasks)), 'waiting');
  assert.equal(currentTask([{taskId: 'older', state: 'running'}, ...tasks])?.taskId, 'first');
  assert.equal(currentTask([{taskId: 'done', state: 'succeeded'}])?.taskId, 'done');
  assert.equal(currentTask([]), undefined);
});
