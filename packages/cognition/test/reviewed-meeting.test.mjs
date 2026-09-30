import assert from 'node:assert/strict';
import {test} from 'node:test';
import {FakeCoordinationStoreHost} from '@personal-agent/goals/store';
import {InMemoryMeetingDecisionReceiptStore, ReviewedMeetingFactConsumer, buildMeetingRepairOptions,
  selectProjectedRepairScope} from '../dist/index.js';

const at='2026-09-30T08:00:00.000Z';
const ref=(id,revision=1)=>({id,revision});
function fixture() {
  const namespace='synthetic-meeting';
  const store=new FakeCoordinationStoreHost().provision(namespace);
  const append=(id,kind,summary,dependencies=[],sourceRef='calendar:synthetic')=>store.append(store.read().revision,
    {id,kind,summary,dependencies,sourceRef,sensitivity:'public',state:'active',reason:'public fixture',
      validFrom:'2026-01-01T00:00:00.000Z',validUntil:'2099-01-01T00:00:00.000Z'});
  append('meeting','fact','14:00');append('goal','goal','Attend meeting',[ref('meeting')]);
  append('plan','plan','Prepare at 13:00',[ref('goal')]);
  append('other','fact','Other source');append('other-plan','plan','Unrelated plan',[ref('other')]);
  append('other','fact','Other source changed');append('meeting','fact','16:00');
  const input={graphNamespace:namespace,projection:{batchToken:'committed-public-batch',graphRevision:store.read().revision,
    links:[{eventId:'memory-change',fact:ref('memory-meeting',2),node:ref('meeting',2)}]}};
  const event={eventId:'calendar-change',source:'calendar:synthetic',meetingFactId:'meeting',originalSummary:'14:00',
    newSummary:'16:00',sourceRevision:'2',detectedAt:at,deadline:new Date(Date.now()+60_000).toISOString(),signal:new AbortController().signal};
  const receipts=new InMemoryMeetingDecisionReceiptStore();
  return {namespace,store,input,event,receipts};
}
test('meeting candidates cover only its committed Fact dependency chain and never rewrite summaries',()=>{
  const f=fixture(),before=f.store.read();
  const options=buildMeetingRepairOptions(before,at,f.input);
  const repair=options.find(option=>option.action==='REVISE').repair;
  assert.deepEqual(repair.changes.map(change=>change.node.id),['goal','plan']);
  for(const change of repair.changes) assert.equal(change.summary,before.history.findLast(node=>node.id===change.node.id).summary);
  assert.deepEqual(f.store.read(),before);
});
test('missing reviewed Runtime port retains RECHECK without Laya/graph/tool writes',async()=>{
  const f=fixture(),before=f.store.read();
  const consumer=new ReviewedMeetingFactConsumer({store:f.store,receiptStore:f.receipts,namespace:f.namespace});
  const receipt=await consumer.processEvent(f.event);
  assert.equal(receipt.status,'requires_review');assert.equal(receipt.decisionAction,'RECHECK');
  assert.equal(receipt.executionVerified,false);assert.deepEqual(f.store.read(),before);
});
test('uncertain choice persists the exact selection and reopens the same Runtime review without rerunning choose',async()=>{
  const f=fixture(),before=f.store.read();let reviewed=0,applied=0;
  const scope=selectProjectedRepairScope(before,at,f.input);
  const review={taskId:'existing-review',graphNamespace:f.namespace,graphRevision:before.revision,bindingVersion:'existing-host',
    evaluatedAt:at,action:'RECHECK',affected:scope.items,options:buildMeetingRepairOptions(before,at,f.input),
    selection:{state:'review',reason:'uncertain',eligibleForRuntime:false,selected:ref('revise'),answerConfidence:0.45}};
  const result={task:{taskId:review.taskId,state:'succeeded'},review};
  const reviewedRepair={readCommittedProjection:async()=>({sourceRevision:'2',meetingFact:ref('meeting',2),input:f.input}),
    reviewCommittedFact:async()=>{reviewed++;return result;},readReview:()=>result,
    applyDecision:async()=>{applied++;return {status:'submitted',taskId:'existing-cloud-task',executionVerified:false,graphUpdateVerified:false};}};
  const open=()=>new ReviewedMeetingFactConsumer({store:f.store,receiptStore:f.receipts,namespace:f.namespace,reviewedRepair});
  const first=await open().processEvent(f.event);
  assert.equal(first.status,'submitted');assert.deepEqual(first.selection,review.selection);
  assert.equal(first.confidence,0.45);assert.equal(first.executionVerified,false);
  await open().processEvent(f.event);assert.equal(reviewed,1);assert.equal(applied,2);
  assert.deepEqual(f.store.read(),before);
});
test('same event with changed contents conflicts; mismatched committed source cannot start a review',async()=>{
  const f=fixture();let calls=0;
  const reviewedRepair={readCommittedProjection:async()=>({sourceRevision:'wrong',meetingFact:ref('meeting',2),input:f.input}),
    reviewCommittedFact:async()=>{calls++;throw Error();},readReview:()=>{throw Error();},applyDecision:async()=>{throw Error();}};
  const consumer=new ReviewedMeetingFactConsumer({store:f.store,receiptStore:f.receipts,namespace:f.namespace,reviewedRepair});
  await consumer.processEvent(f.event);
  const conflict=await consumer.processEvent({...f.event,newSummary:'Different untrusted contents'});
  assert.equal(conflict.status,'conflict');assert.equal(calls,0);
});
test('pending review recovery preserves its actual choice and rejects a replaced impact scope',async()=>{
  const f=fixture(),before=f.store.read();let finished=false,applied=0;
  const scope=selectProjectedRepairScope(before,at,f.input);
  const review={taskId:'pending-review',graphNamespace:f.namespace,graphRevision:before.revision,bindingVersion:'existing-host',
    evaluatedAt:at,action:'RECHECK',affected:scope.items,options:buildMeetingRepairOptions(before,at,f.input),
    selection:{state:'review',reason:'uncertain',eligibleForRuntime:false,answerConfidence:0.35}};
  const read=()=>({task:{taskId:review.taskId,state:finished?'succeeded':'running'},...(finished?{review}:{})});
  const reviewedRepair={readCommittedProjection:async()=>({sourceRevision:'2',meetingFact:ref('meeting',2),input:f.input}),
    reviewCommittedFact:async()=>read(),readReview:read,
    applyDecision:async()=>{applied++;return {status:'waiting_reconciliation',taskId:'original-task'};}};
  const open=()=>new ReviewedMeetingFactConsumer({store:f.store,receiptStore:f.receipts,namespace:f.namespace,reviewedRepair});
  const pending=await open().processEvent(f.event);assert.equal(pending.reviewTaskId,'pending-review');assert.equal(applied,0);
  finished=true;
  const recovered=await open().processEvent(f.event);
  assert.deepEqual(recovered.selection,review.selection);assert.equal(recovered.confidence,0.35);assert.equal(applied,1);
  review.affected=[];
  await open().processEvent(f.event);assert.equal(applied,1);assert.deepEqual(f.store.read(),before);
});
