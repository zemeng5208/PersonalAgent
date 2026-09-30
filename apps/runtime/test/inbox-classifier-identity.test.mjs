import test from 'node:test';
import assert from 'node:assert/strict';
import {LayaTriageService} from '@personal-agent/cognition';
import {createInboxTriagePipeline} from '../src/application/inbox-triage.ts';

const context = () => ({deadline:new Date(Date.now()+60_000).toISOString(),signal:new AbortController().signal});
const answer = (choice,probabilities) => ({choice,probabilities,answer_confidence:0.9,confidence:0.42});
const items = Array.from({length:5},(_,index)=>({source:'mail',accountRef:'fixture',externalId:`INBOX:${index+1}`,
  occurredAt:'2026-09-30T00:00:00.000Z',fetchedAt:'2026-09-30T01:00:00.000Z',
  contentRef:`fixture header ${index+1}`,sensitivity:'private',dedupeKey:`fixture:1:INBOX:${index+1}:fixture-${index+1}`}));
function fixture(beforeResponse=()=>{}) {
  const values=new Map();let identity='model-A',calls=0;
  const storage={get:key=>structuredClone(values.get(key)),set:(key,value)=>values.set(key,structuredClone(value))};
  const triage=new LayaTriageService({async infer(payload) {
    calls++;await beforeResponse(calls);
    return {answers:Object.fromEntries(payload.state.events.flatMap((_,index)=>[
      [`category_${index}`,answer('meeting',{meeting:0.9,other:0.1})],
      [`impact_${index}`,answer('high_impact',{routine:0.1,high_impact:0.9})],
    ]))};
  }});
  const open=()=>createInboxTriagePipeline({storage,namespace:'fixture-user',triage,
    labels:{meeting:'Meeting-related fixture',other:'Other'},meetingLabels:['meeting'],
    getClassifierFingerprint:()=>typeof identity==='function'?identity():identity,authorizeRead:()=>true});
  const page=(count=2)=>({...context(),accountRef:'fixture',folder:'INBOX',nextCursor:`1:${count}`,hasMore:false,items:items.slice(0,count)});
  return {open,page,setIdentity:value=>{identity=value;},calls:()=>calls,values};
}

test('live classifier identity invalidates reuse while retaining accepted work and page cursor',async()=>{
  const f=fixture();let pipeline=f.open();await pipeline.processPage(f.page());
  const [pending]=pipeline.pendingAnalyses(context());
  pipeline.confirmAnalysisAccepted({...pending,receiptId:pending.receipt.id,taskId:'already-handed-off'},context());
  await pipeline.processPage(f.page());assert.equal(f.calls(),1);
  f.setIdentity('model-B');
  assert.equal(pipeline.snapshot().needsReview,2);assert.equal(pipeline.snapshot().meetingCandidates,0);
  assert.deepEqual(pipeline.pendingAnalyses(context()),[]);
  assert.equal(pipeline.readAnalysis(pending.workKey,context()),undefined);
  assert.equal(pipeline.cursor('fixture','INBOX'),'1:2');
  const changed=await pipeline.processPage({...f.page(),cursor:'1:2'});
  assert.equal(changed.classified,2);assert.equal(f.calls(),2);
  assert.equal(pipeline.pendingAnalyses(context()).length,1);
  pipeline=f.open();assert.equal(pipeline.cursor('fixture','INBOX'),'1:2');
  f.setIdentity('model-A');
  assert.equal(pipeline.readAnalysis(pending.workKey,context()).taskId,'already-handed-off');
});

test('unknown or failed live identity cannot fabricate stable cache identity or export old analysis',async()=>{
  const f=fixture(),pipeline=f.open();f.setIdentity(undefined);
  await assert.rejects(pipeline.processPage(f.page()),{code:'UNSUPPORTED_CAPABILITY'});
  assert.equal(f.calls(),0);assert.equal(pipeline.cursor('fixture','INBOX'),undefined);
  f.setIdentity('model-A');await pipeline.processPage(f.page());
  const [pending]=pipeline.pendingAnalyses(context());f.setIdentity(undefined);
  assert.deepEqual(pipeline.pendingAnalyses(context()),[]);
  assert.equal(pipeline.readAnalysis(pending.workKey,context()),undefined);
  assert.throws(()=>pipeline.confirmAnalysisAccepted({...pending,receiptId:pending.receipt.id,taskId:'new'},context()),{code:'REVISION_CONFLICT'});
  assert.equal(pipeline.snapshot().needsReview,2);
  f.setIdentity(()=>{throw Error('private diagnostic must not escape');});
  await assert.rejects(pipeline.processPage({...f.page(),cursor:'1:2'}),error=>error.code==='UNSUPPORTED_CAPABILITY'
    && !error.message.includes('private diagnostic'));
  assert.equal(f.calls(),1);assert.equal(pipeline.cursor('fixture','INBOX'),'1:2');
});

test('one page binds identity across asynchronous chunks and never advances on model change',async()=>{
  let change=true;
  const f=fixture(async call=>{if(call===2 && change) f.setIdentity('model-B');});
  const pipeline=f.open();
  await assert.rejects(pipeline.processPage(f.page(5)),{code:'REVISION_CONFLICT'});
  assert.equal(f.calls(),2);assert.equal(pipeline.cursor('fixture','INBOX'),undefined);
  assert.equal(pipeline.snapshot().total,4);assert.equal(pipeline.snapshot().needsReview,4);
  assert.deepEqual(pipeline.pendingAnalyses(context()),[]);
  change=false;
  const retry=await pipeline.processPage(f.page(5));
  assert.equal(retry.complete,true);assert.equal(retry.classified,5);
  assert.equal(pipeline.cursor('fixture','INBOX'),'1:5');
  assert.equal(pipeline.pendingAnalyses(context()).length,5);
});
