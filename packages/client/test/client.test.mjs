import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Client,EventCursor} from '../dist/index.js';
const response=(r,data)=>({kind:'response',protocolVersion:'1.0.0',requestId:r.requestId,outcome:'ok',data,evidenceRefs:[]});
test('client negotiates capabilities before sending operations', async () => {
  let calls=0;
  const client=new Client({send:async r=>{calls++;return response(r,{protocolVersion:'1.0.0',capabilities:[],sessionRef:'s'});}});
  await assert.rejects(client.call('task.get',{taskId:'t'}),{code:'UNSUPPORTED_CAPABILITY'});
  assert.equal(calls,0);
  await client.connect();
  await assert.rejects(client.call('task.get',{taskId:'t'}),{code:'UNSUPPORTED_CAPABILITY'});
  assert.equal(calls,1);
});
test('timeout and abort reach transport without retrying; abort before call sends nothing',async()=>{
  let calls=0,observed;
  const client=new Client({send:async(r,signal)=>{
    if(r.operation==='system.handshake') return response(r,{protocolVersion:'1.0.0',capabilities:['task.get'],sessionRef:'s'});
    calls++;observed=signal;return new Promise(()=>{});
  }});
  await client.connect();
  await assert.rejects(client.call('task.get',{taskId:'t'},{timeoutMs:10}),{code:'TIMEOUT'});
  assert.equal(observed.aborted,true);assert.equal(calls,1);
  const controller=new AbortController();
  const pending=client.call('task.get',{taskId:'t'},{signal:controller.signal});
  controller.abort();
  await assert.rejects(pending,{code:'CANCELLED'});
  assert.equal(observed.aborted,true);assert.equal(calls,2);
  await assert.rejects(client.call('task.get',{taskId:'t'},{signal:controller.signal}),{code:'CANCELLED'});
  assert.equal(calls,2);
});
test('client rejects wrong response correlation and handshake version',async()=>{
  const client=new Client({send:async r=>({...response(r,{protocolVersion:'1.0.0',capabilities:[],sessionRef:'s'}),requestId:'wrong'})});
  await assert.rejects(client.connect());
  const incompatible=new Client({send:async r=>response(r,{protocolVersion:'2.0.0',capabilities:[],sessionRef:'s'})});
  await assert.rejects(incompatible.connect(),{code:'PROTOCOL_MISMATCH'});
});
test('event cursor sorts, deduplicates, rejects gaps atomically and supports explicit resync',()=>{
  const event=(sequence)=>({kind:'event',protocolVersion:'1.0.0',eventId:'e'+sequence,streamId:'tasks',sequence,type:'task.progress',occurredAt:'2026-09-05T12:00:00Z',payload:{stepId:'s',label:'working'}});
  const cursor=new EventCursor('tasks');
  assert.equal(cursor.accept([event(2),event(1),event(1)]).length,2);
  assert.equal(cursor.accept([event(2)]).length,0);
  assert.throws(()=>cursor.accept([event(3),event(5)]),{code:'CURSOR_EXPIRED'});
  assert.equal(cursor.afterSequence,2);
  assert.throws(()=>cursor.accept([{...event(2),eventId:'forged'}]));
  cursor.reset(4);assert.equal(cursor.accept([event(5)]).length,1);
});
