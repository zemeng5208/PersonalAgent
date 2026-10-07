import test from 'node:test';
import assert from 'node:assert/strict';
import {cognitionReviewFeedback} from '../src/app/proactive-controls.js';

test('goal treatment feedback never upgrades acceptance, analysis or legacy prose into verified update', () => {
  for (const status of ['created', 'submitted', 'pending', 'running', 'verifying', 'waiting_approval', 'waiting_reconciliation', 'succeeded', 'failed', 'cancelled']) {
    const item = cognitionReviewFeedback({status, taskId:'handoff-1', executionVerified:false, graphUpdateVerified:false});
    assert.equal(item.locked, true);
    assert.equal(item.label, '已交给主智能体');
    assert.doesNotMatch(item.message, /更新已核实|方案已执行/);
  }
  assert.equal(cognitionReviewFeedback({state:'applied', executionStatus:'已在本地执行'}).locked, false);
  assert.doesNotMatch(cognitionReviewFeedback({status:'applied', taskId:'legacy'}).message, /更新已核实/);
  assert.equal(cognitionReviewFeedback({status:'applied', executionVerified:true, graphUpdateVerified:true}).message, '执行与目标更新已核实');
  assert.equal(cognitionReviewFeedback({status:'unavailable'}).locked, false);
  assert.equal(cognitionReviewFeedback({state:'succeeded'}).message,'方案已记录，尚未交给主智能体处理');
  assert.equal(cognitionReviewFeedback({status:'submission_unknown'}).locked, true);
});

test('pending Goal handoff without an accepted task ID stays unresolved and locked until authoritative snapshot changes', () => {
  for (const item of [{state:'pending'}, {status:'pending'}, {state:'pending',executionStatus:'arbitrary prose'}]) {
    const feedback=cognitionReviewFeedback(item);
    assert.match(feedback.message,/受理结果待核实/);
    assert.doesNotMatch(feedback.message,/尚未交给|执行与目标更新已核实/);
    assert.equal(feedback.label,'受理结果待核实');
    assert.equal(feedback.locked,true);
  }
  const accepted=cognitionReviewFeedback({state:'running',taskId:'handoff-1'});
  assert.equal(accepted.locked,true);
  assert.equal(accepted.label,'已交给主智能体');
  const verified=cognitionReviewFeedback({status:'applied',taskId:'repair-1',executionVerified:true,graphUpdateVerified:true});
  assert.equal(verified.message,'执行与目标更新已核实');
  assert.equal(verified.locked,true);
  for (const state of ['local','selected','review','unavailable','expired']) {
    assert.equal(cognitionReviewFeedback({state}).locked,false);
  }
  assert.equal(cognitionReviewFeedback({executionStatus:'编排受理结果待核实，尚未确认执行'}).locked,false);
});
