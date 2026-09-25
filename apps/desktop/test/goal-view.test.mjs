import test from 'node:test';
import assert from 'node:assert/strict';
import {appliedGoalRef} from '../src/features/conversation/goal-view.js';

test('Goal UI requires a confirmed applied task before attempting Goal readback', () => {
  const task = {state: 'succeeded', result: {kind: 'applied', currentGoal: {id: 'goal-1', revision: 2}},
    evidenceRefs: ['evidence-1']};
  assert.deepEqual(appliedGoalRef(task), {id: 'goal-1', revision: 2});
  assert.equal(appliedGoalRef({...task, state: 'waiting_approval'}), null);
  assert.equal(appliedGoalRef({...task, state: 'cancelling'}), null);
  assert.equal(appliedGoalRef({...task, state: 'waiting_reconciliation'}), null);
  assert.equal(appliedGoalRef({...task, evidenceRefs: []}), null);
  assert.equal(appliedGoalRef({...task, result: {...task.result, kind: 'conflict'}}), null);
});
