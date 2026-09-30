import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createInboxPageConsumer, measureTriageClassifier} from '../dist/index.js';

const context=()=>({accountRef:'public-synthetic',folder:'INBOX',deadline:new Date(Date.now()+60_000).toISOString(),signal:new AbortController().signal});
// Explicit cursor-only fixture. This tests the wrapper; actual cache/receipt recovery
// is tested by the existing injected p5-small-mail-batch production acceptance.
function fixture() {
  let cursor, busy=false;
  const calls=[];
  const pipeline={readCursor:()=>cursor,snapshot:()=>({cursor}),async processPage(page){
    assert.equal(busy,false);busy=true;
    try {calls.push(page);cursor=page.nextCursor;return {classified:page.items.length,reused:0,
      complete:true,cursorAdvanced:true,nextCursor:cursor,hasMore:page.hasMore,summary:{cursor}};}
    finally {busy=false;}
  }};
  return {pipeline,calls,consumer:createInboxPageConsumer({pipeline})};
}
test('page backpressure persists cursor before pause and new wrapper resumes that exact source cursor',async()=>{
  const f=fixture(),fetched=[];
  const fetchPage=async({cursor})=>{fetched.push(cursor);return cursor===undefined
    ?{items:['one'],nextCursor:'1:4',hasMore:true}:{items:['two'],nextCursor:'1:8',hasMore:false};};
  const first=await f.consumer.processStream({...context(),fetchPage,onPageCompleted:()=>f.consumer.pause()});
  assert.equal(first.stoppedReason,'paused');assert.equal(first.cursor,'1:4');assert.deepEqual(fetched,[undefined]);
  const reopened=createInboxPageConsumer({pipeline:f.pipeline});
  const second=await reopened.processStream({...context(),fetchPage});
  assert.equal(second.stoppedReason,'completed');assert.equal(second.cursor,'1:8');assert.deepEqual(fetched,[undefined,'1:4']);
});
test('unfinished page never fetches the next page or advances the cursor',async()=>{
  let fetched=0;
  const pipeline={readCursor:()=>undefined,snapshot:()=>({}),processPage:async()=>({classified:0,reused:0,
    complete:false,cursorAdvanced:false,nextCursor:undefined,hasMore:true,summary:{}})};
  const result=await createInboxPageConsumer({pipeline}).processStream({...context(),fetchPage:async()=>{
    fetched++;return {items:['one'],nextCursor:'1:4',hasMore:true};}});
  assert.equal(fetched,1);assert.equal(result.pagesProcessed,0);assert.equal(result.cursor,undefined);
  assert.equal(result.stoppedReason,'classification_unavailable');
});
test('cancelled request does not fetch and an uncooperative source is bounded by deadline',async()=>{
  const f=fixture();let fetched=0;
  const cancelled=new AbortController();cancelled.abort();
  const result=await f.consumer.processStream({...context(),signal:cancelled.signal,fetchPage:async()=>{fetched++;throw Error();}});
  assert.equal(result.stoppedReason,'cancelled');assert.equal(fetched,0);
  await assert.rejects(f.consumer.processStream({...context(),deadline:new Date(Date.now()+30).toISOString(),
    fetchPage:async()=>new Promise(()=>{})}),{code:'TIMEOUT'});
  assert.equal(f.calls.length,0);
});
test('metrics count real classify awaits and completed determinations, with no timing floor',async()=>{
  let time=5;
  const measured=measureTriageClassifier({classify:async()=>{time=9;return [{reason:'uncertain'},{reason:'unavailable'}];}},()=>time);
  await measured.classify({messages:[{text:'public sample'},{text:'another sample'}]});
  assert.deepEqual(measured.snapshot(),{classifyCalls:1,submittedCount:2,inferredCount:1,classifyWallMs:4});
});
