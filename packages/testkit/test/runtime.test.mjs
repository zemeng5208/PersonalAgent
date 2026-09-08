import assert from 'node:assert/strict';
import {test} from 'node:test';
import {FakeRuntime} from '../dist/index.js';
import {Client,EventCursor} from '@personal-agent/client';
async function setup(scenario,extra={}) {
  const runtime=new FakeRuntime({mode:'test',scenario,...extra});
  const client=new Client(runtime,runtime.clock.now);
  await client.connect();
  const task=await client.call('task.submit',{goal:'fixture',conversationId:'c'},{idempotencyKey:'key'});
  return {runtime,client,id:task.taskId};
}
test('success and failure produce truthful terminal events',async()=>{
  for(const [scenario,expected] of [['success','succeeded'],['failure','failed']]) {
    const {runtime,client,id}=await setup(scenario);
    assert.equal((await client.call('task.get',{taskId:id})).state,'created');
    for(let i=0;i<4;i++)runtime.advance(id);
    assert.equal((await client.call('task.get',{taskId:id})).state,expected);
    assert.equal(runtime.readEvents('tasks').at(-1).type,expected==='succeeded'?'task.completed':'task.failed');
    assert.equal((await client.call('task.cancel',{taskId:id})).cancelAccepted,false);
  }
});
test('approval allow/deny and stale decisions follow revision rules',async()=>{
  for(const decision of ['allow_once','deny']) {
    const {runtime,client,id}=await setup('approval');
    runtime.advance(id);runtime.advance(id);
    const event=runtime.readEvents('tasks').find(e=>e.type==='approval.requested');
    const request={approvalId:event.payload.approvalId,decision,expectedRevision:event.payload.revision};
    await assert.rejects(client.call('authorization.respond',{...request,expectedRevision:0}),{code:'REVISION_CONFLICT'});
    await client.call('authorization.respond',request);
    await assert.rejects(client.call('authorization.respond',request),{code:'REVISION_CONFLICT'});
    runtime.advance(id);runtime.advance(id);
    assert.equal((await client.call('task.get',{taskId:id})).state,decision==='deny'?'cancelled':'succeeded');
  }
});
test('cancel accepted is not cancelled until executor acknowledgement',async()=>{
  const {runtime,client,id}=await setup('cancel');
  runtime.advance(id);
  assert.equal((await client.call('task.cancel',{taskId:id})).state,'cancelling');
  assert.equal((await client.call('task.get',{taskId:id})).state,'cancelling');
  runtime.advance(id);
  assert.equal((await client.call('task.get',{taskId:id})).state,'cancelled');
});
test('unknown write waits for reconciliation and never invokes a second write',async()=>{
  const {runtime,client,id}=await setup('unknown_write');
  runtime.advance(id);runtime.advance(id);runtime.advance(id);
  assert.equal((await client.call('task.get',{taskId:id})).state,'waiting_reconciliation');
  await client.call('task.cancel',{taskId:id});
  for(let i=0;i<3;i++)runtime.advance(id);
  assert.equal(runtime.readEvents('tasks').filter(e=>e.type==='tool.completed').length,1);
  assert.equal((await client.call('task.get',{taskId:id})).cancelRequested,true);
  runtime.reconcile(id,true);
  assert.equal((await client.call('task.get',{taskId:id})).state,'succeeded');
});
test('reconnect replays ordered events; expired cursor requires snapshot and reset',async()=>{
  const {runtime,client,id}=await setup('reconnect');
  const cursor=new EventCursor('tasks');
  cursor.accept(runtime.readEvents('tasks'));
  runtime.advance(id);runtime.advance(id);
  await client.call('event.subscribe',{streamId:'tasks',afterSequence:cursor.afterSequence});
  assert.equal(cursor.accept(runtime.readEvents('tasks',cursor.afterSequence)).length,2);
  const limited=await setup('reconnect',{replayLimit:2});
  for(let i=0;i<4;i++)limited.runtime.advance(limited.id);
  await assert.rejects(limited.client.call('event.subscribe',{streamId:'tasks',afterSequence:0}),{code:'CURSOR_EXPIRED'});
  const snapshot=await limited.client.call('task.get',{taskId:limited.id});
  assert.equal(snapshot.state,'succeeded');
});
test('idempotency, revisions, expired deadlines and unsupported providers',async()=>{
  const {runtime,client,id}=await setup('success');
  const again=await client.call('task.submit',{conversationId:'c',goal:'fixture'},{idempotencyKey:'key'});
  assert.equal(again.taskId,id);
  await assert.rejects(client.call('task.submit',{goal:'changed',conversationId:'c'},{idempotencyKey:'key'}),{code:'REVISION_CONFLICT'});
  await client.call('settings.update',{namespace:'ui',expectedRevision:0,patch:{theme:'dark'}});
  await assert.rejects(client.call('settings.update',{namespace:'ui',expectedRevision:0,patch:{theme:'light'}}),{code:'REVISION_CONFLICT'});
  await assert.rejects(client.call('settings.update',{namespace:'ui',expectedRevision:1,patch:{apiKey:'fixture'}}),{code:'SCOPE_DENIED'});
  await assert.rejects(client.call('voice.start',{mode:'push_to_talk',deviceRef:'d'}),{code:'UNSUPPORTED_CAPABILITY'});
  const expired=await runtime.send({kind:'request',protocolVersion:'1.0.0',requestId:'r',operation:'task.get',payload:{taskId:id},deadline:'2020-01-01T00:00:00Z'},new AbortController().signal);
  assert.equal(expired.error.code,'TIMEOUT');
});
test('fake requires explicit test mode and never silently enables in production',()=>{
  assert.throws(()=>new FakeRuntime({scenario:'success'}));
  const old=process.env.NODE_ENV;
  try{process.env.NODE_ENV='production';assert.throws(()=>new FakeRuntime({mode:'test',scenario:'success'}));}
  finally{if(old===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=old;}
});

test('public fake queries support snapshot recovery and redacted approval lookup',async()=>{
  const {runtime,client,id}=await setup('approval');
  await client.call('task.submit',{goal:'second',conversationId:'c'},{idempotencyKey:'key-2'});
  const tasks=await client.call('task.list',{conversationId:'c',limit:1});
  assert.equal(tasks.items.length,1);
  assert.equal(typeof tasks.nextBeforeSequence,'number');
  const conversations=await client.call('conversation.list',{conversationId:'c',snapshotSequence:tasks.snapshotSequence});
  assert.equal(conversations.items[0].taskCount,2);
  runtime.advance(id);runtime.advance(id);
  const approvals=await client.call('approval.list',{taskId:id,state:'pending'});
  assert.equal(approvals.items[0].argumentSummary,'redacted');
  assert.equal('arguments' in approvals.items[0],false);
});
