import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {FakeCoordinationStoreHost} from '@personal-agent/goals/store';
import {createCognitionP5Composition} from '../electron/cognition-p5-composition.js';

function fixture(t) {
  const base=fileURLToPath(new URL('../../../.cache/p5-cloud-ports/',import.meta.url));
  mkdirSync(base,{recursive:true});const userData=mkdtempSync(path.join(base,'case-'));
  t.after(()=>rmSync(userData,{recursive:true,force:true}));
  const namespace='explicit-synthetic';const store=new FakeCoordinationStoreHost().provision(namespace);
  const state=new Map();let tasks=0;
  const application={runtime:{bindCoordinationStore:()=>store,submitTaskWithCheckpoint:()=>{tasks++;throw Error('No anchor tasks');}},
    createHostStateStore:domain=>{assert.equal(domain,'proactive-receipts');return {
      get:key=>structuredClone(state.get(key)),set:(key,value)=>state.set(key,structuredClone(value)),delete:key=>state.delete(key)};}};
  return {userData,namespace,store,application,state,tasks:()=>tasks};
}
test('production requires host KV and ignores the obsolete policy/direct-CAS port',async t=>{
  const f=fixture(t);let calls=0;
  const p5=createCognitionP5Composition({...f,policyEvaluator:{evaluateExecution:()=>{calls++;return {allowed:true};}},
    meetingExecutionPort:{executeBatch:()=>{calls++;throw Error('Direct CAS is not Runtime Evidence');}}});
  const before=f.store.read();
  const receipt=await p5.processMeetingEvent({eventId:'public-change',source:'calendar:synthetic',meetingFactId:'public-fact',
    originalSummary:'14:00',newSummary:'16:00',sourceRevision:'2',detectedAt:new Date().toISOString(),
    deadline:new Date(Date.now()+60_000).toISOString(),signal:new AbortController().signal});
  assert.equal(receipt.status,'requires_review');assert.equal(calls,0);assert.equal(f.tasks(),0);
  assert.deepEqual(f.store.read(),before);assert.equal(p5.snapshot().persistence,'runtime_sqlite');
  assert.throws(()=>createCognitionP5Composition({...f,application:{runtime:f.application.runtime}}),/createHostStateStore/);
  p5.dispose();
});
test('stop aborts an in-flight injected inbox page; resume does not reload shared weights',async t=>{
  const f=fixture(t);let enter,signal,starts=0;
  const entered=new Promise(resolve=>{enter=resolve;});
  const inboxPipeline={readCursor:()=>undefined,snapshot:()=>({records:[],total:0}),processPage:async input=>{
    signal=input.signal;enter();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
    throw Error('Private source detail must not be shown');}};
  const p5=createCognitionP5Composition({...f,inboxPipeline,layaHost:{snapshot:()=>({ready:false,state:'stopped'}),start:()=>{starts++;}}});
  const pending=p5.triageInboxPage({accountRef:'synthetic',folder:'INBOX',items:[],nextCursor:'1:4',hasMore:true});
  await entered;await p5.stop();await assert.rejects(pending);
  assert.equal(signal.aborted,true);assert.deepEqual(p5.snapshot().failures,{mail:'cancelled'});
  assert.equal(JSON.stringify(p5.snapshot()).includes('Private source detail'),false);
  await p5.start();assert.equal(starts,0);p5.dispose();
});
