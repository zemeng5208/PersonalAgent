import assert from 'node:assert/strict';
import {test} from 'node:test';
import {FakeCoordinationStoreHost} from '@personal-agent/goals/store';
import {InMemoryMeetingDecisionReceiptStore, ReviewedMeetingFactConsumer, buildMeetingRepairOptions,
  analyzeImpact, createCommittedMeetingProjectionReader, selectMeetingRepairScope, selectProjectedRepairScope} from '../dist/index.js';

const at='2026-09-30T08:00:00.000Z';
const ref=(id,revision=1)=>({id,revision});
function fixture(mixed=false) {
  const namespace='synthetic-meeting';
  const store=new FakeCoordinationStoreHost().provision(namespace);
  const append=(id,kind,summary,dependencies=[],sourceRef='calendar:synthetic')=>store.append(store.read().revision,
    {id,kind,summary,dependencies,sourceRef,sensitivity:'public',state:'active',reason:'public fixture',
      validFrom:'2026-01-01T00:00:00.000Z',validUntil:'2099-01-01T00:00:00.000Z'});
  append('meeting','fact','14:00');append('goal','goal','Attend meeting',[ref('meeting')]);
  append('plan','plan','Prepare at 13:00',[ref('goal')]);
  append('other','fact','Other source');append('other-goal','goal','Unrelated goal',[ref('other')]);
  append('other-plan','plan','Unrelated plan',[ref('other-goal')]);
  if(mixed) store.appendBatch(store.read().revision,['meeting','other'].map(id=>({id,kind:'fact',
    summary:id==='meeting'?'16:00':'Other source changed',dependencies:[],sourceRef:'calendar:synthetic',
    sensitivity:'public',state:'active',reason:'public fixture',validFrom:'2026-01-01T00:00:00.000Z',validUntil:'2099-01-01T00:00:00.000Z'})));
  else {append('other','fact','Other source changed');append('meeting','fact','16:00');}
  const input={graphNamespace:namespace,projection:{batchToken:'committed-public-batch',graphRevision:store.read().revision,
    links:[{eventId:'memory-change',fact:ref('memory-meeting',2),node:ref('meeting',2)},
      ...(mixed?[{eventId:'other-change',fact:ref('memory-other',2),node:ref('other',2)}]:[])]}};
  const event={eventId:'calendar-change',source:'calendar:synthetic',meetingFactId:'meeting',originalSummary:'14:00',
    newSummary:'16:00',sourceRevision:'2',detectedAt:at,deadline:new Date(Date.now()+60_000).toISOString(),signal:new AbortController().signal};
  const receipts=new InMemoryMeetingDecisionReceiptStore();
  return {namespace,store,input,event,receipts};
}

test('pending reviewed meeting work retains constructor bindings and live original port hooks', async () => {
  const f=fixture(),before=f.store.read(),clock=Date.now();
  let release,entered;
  const loading=new Promise(resolve=>{release=resolve;});
  const started=new Promise(resolve=>{entered=resolve;});
  let reads=0,saves=0,replacedCalls=0;
  const store={read:revision=>f.store.read(revision)};
  const receiptStore={loadReceipt:async query=>{
    assert.equal(query.namespace,f.namespace);entered();await loading;
    return f.receipts.loadReceipt(query);
  },saveReceipt:record=>f.receipts.saveReceipt(record),listReceipts:filter=>f.receipts.listReceipts(filter)};
  const options={store,receiptStore,namespace:f.namespace,now:()=>clock};
  const consumer=new ReviewedMeetingFactConsumer(options);
  const pending=consumer.processEvent(f.event);
  await started;
  options.namespace='unrelated-namespace';
  options.store={read(){replacedCalls++;throw Error('replaced graph');}};
  options.receiptStore={loadReceipt(){replacedCalls++;},saveReceipt(){replacedCalls++;}};
  options.reviewedRepair={readCommittedProjection(){replacedCalls++;throw Error('replaced host');}};
  options.now=()=>clock+120_000;
  store.read=revision=>{reads++;return f.store.read(revision);};
  receiptStore.saveReceipt=record=>{saves++;f.receipts.saveReceipt(record);};
  release();
  const receipt=await pending;
  assert.equal(receipt.graphRevisionBefore,before.revision);
  assert.equal(receipt.status,'requires_review');
  assert.equal(reads,1);assert.equal(saves,1);assert.equal(replacedCalls,0);
  const record=f.receipts.loadReceipt({namespace:f.namespace,source:f.event.source,eventId:f.event.eventId});
  assert.equal(record.namespace,f.namespace);assert.equal(record.updatedAt,new Date(clock).toISOString());
  assert.deepEqual((await consumer.getReceipt(f.event.eventId,f.event.source)),receipt);
  assert.equal((await consumer.listReceipts()).length,1);
  assert.deepEqual(f.store.read(),before);
});

test('committed meeting reader retains its factory and request bindings while the source awaits', async () => {
  const f=fixture(),submitted={...f.event},before=f.store.read();
  let release,entered,getterCalls=0,reads=0,factReads=0,replacedCalls=0;
  const loading=new Promise(resolve=>{release=resolve;});
  const started=new Promise(resolve=>{entered=resolve;});
  const store={read:revision=>f.store.read(revision)};
  const facts={listImpactReceipts:()=>[]};
  const options={namespace:f.namespace,store,facts,readSourceRevision:async(event,context)=>{
    getterCalls++;assert.equal(event.newSummary,submitted.newSummary);assert.equal(context.deadline,submitted.deadline);
    entered();await loading;
    return {source:submitted.source,sourceRevision:submitted.sourceRevision,meetingFact:ref('meeting',2)};
  }};
  const reader=createCommittedMeetingProjectionReader(options);
  const pending=reader(f.event,f.event);await started;
  options.namespace='other-namespace';
  options.store={read(){replacedCalls++;throw Error('replaced graph');}};
  options.facts={listImpactReceipts(){replacedCalls++;return [];}};
  options.readSourceRevision=async()=>{replacedCalls++;return undefined;};
  f.event.newSummary='replaced summary';f.event.sourceRevision='replaced revision';
  f.event.deadline=new Date(Date.now()-1000).toISOString();
  store.read=revision=>{reads++;return f.store.read(revision);};
  facts.listImpactReceipts=()=>{factReads++;return [{projection:f.input.projection,
    completed:{batchToken:f.input.projection.batchToken,report:analyzeImpact(before,at)}}];};
  release();
  const result=await pending;
  assert.deepEqual(result,{sourceRevision:submitted.sourceRevision,meetingFact:ref('meeting',2),input:f.input});
  assert.equal(reads,1);assert.equal(factReads,1);assert.equal(replacedCalls,0);
  assert.deepEqual(await reader(submitted,submitted),result,'later calls retain the original source getter');
  assert.equal(getterCalls,2);assert.deepEqual(f.store.read(),before);
});

test('mixed completed batch retains both links as proof but meeting selection and restart remain on one chain',async()=>{
  const f=fixture(true),before=f.store.read();let calls=0,applied=0;
  const completed={batchToken:f.input.projection.batchToken,report:analyzeImpact(before,at)};
  const reader=createCommittedMeetingProjectionReader({namespace:f.namespace,store:f.store,
    facts:{listImpactReceipts:()=>[{projection:f.input.projection,completed}]},
    readSourceRevision:async()=>({source:f.event.source,sourceRevision:'2',meetingFact:ref('meeting',2)})});
  const bound=await reader(f.event,f.event);
  assert.deepEqual(bound.input,f.input,'a multi-node batch ends after its first meeting node revision');
  assert.deepEqual(selectProjectedRepairScope(before,at,f.input).items.map(item=>item.node.id),['goal','plan','other-goal','other-plan']);
  const scope=selectMeetingRepairScope(before,at,f.input,ref('meeting',2));
  assert.deepEqual(scope.items.map(item=>item.node.id),['goal','plan']);
  assert.throws(()=>buildMeetingRepairOptions(before,at,f.input),{code:'INVALID_ARGUMENT'});
  const options=buildMeetingRepairOptions(before,at,f.input,ref('meeting',2));
  assert.deepEqual(options.find(option=>option.action==='REVISE').repair.changes.map(item=>item.node.id),['goal','plan']);
  const review={taskId:'mixed-meeting-review',graphNamespace:f.namespace,graphRevision:before.revision,
    bindingVersion:'existing-host',evaluatedAt:at,action:'RECHECK',affected:scope.items,options,
    selection:{state:'review',reason:'uncertain',eligibleForRuntime:false,answerConfidence:0.4}};
  const value={task:{taskId:review.taskId,state:'succeeded'},review};
  const reviewedRepair={readCommittedProjection:reader,reviewCommittedFact:async request=>{
    calls++;assert.deepEqual(request.projection,f.input.projection);assert.deepEqual(request.meetingFact,ref('meeting',2));
    assert.equal(request.sourceRevision,'2');return value;
  },readReview:()=>value,applyDecision:async()=>{applied++;return {status:'waiting_reconciliation',taskId:'same-task'};}};
  const open=()=>new ReviewedMeetingFactConsumer({store:f.store,receiptStore:f.receipts,namespace:f.namespace,reviewedRepair});
  await open().processEvent(f.event);await open().processEvent(f.event);
  assert.equal(calls,1);assert.equal(applied,2);
  review.affected=selectProjectedRepairScope(before,at,f.input).items;
  await open().processEvent(f.event);assert.equal(applied,2,'recovery cannot broaden the persisted meeting scope');
  const tampered=structuredClone(f.input);tampered.projection.links[1].node.revision=99;
  assert.throws(()=>selectMeetingRepairScope(before,at,tampered,ref('meeting',2)),{code:'NOT_APPLICABLE'});
  assert.deepEqual(f.store.read(),before);
});
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
