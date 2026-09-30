import assert from 'node:assert/strict';
import {test} from 'node:test';
import {approvalCards,approvalResponse} from '../src/features/conversation/approval-card.js';
test('current pending action renders a usable decision and submits the current revision',()=>{
  const task={taskId:'task',state:'waiting_approval'};
  const approval={approvalId:'grant',taskId:'task',toolName:'workspace.apply_text_patch',scopes:['workspace:write'],
    state:'pending',revision:3,expiresAt:'2030-01-01T00:00:00.000Z'};
  const now=Date.parse('2026-09-27T00:00:00.000Z');
  assert.match(approvalCards(task,[approval],now),/批准并继续/);
  assert.deepEqual(approvalResponse('grant','allow_once',[task],[approval],now),
    {approvalId:'grant',decision:'allow_once',expectedRevision:3,taskId:'task'});
  assert.equal(approvalCards({...task,state:'succeeded'},[approval],now),'');
  assert.throws(()=>approvalResponse('grant','allow_once',[{...task,state:'cancelled'}],[approval],now));
  assert.throws(()=>approvalResponse('grant','allow_once',[task],[approval],Date.parse('2031-01-01')));
});
