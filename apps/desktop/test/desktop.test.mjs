import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@personal-agent/client';
import {FakeRuntime} from '@personal-agent/testkit';
import {panelBounds,clampOrb,draggedGroupBounds} from '../electron/placement.js';
import {AGENTARTS_TASK_TIMEOUT_MS,taskSubmitOptions} from '../electron/runtime.js';
import {orbState} from '../src/features/conversation/state.js';
test('panel stays within negative-origin and small display work areas',()=>{
  for(const area of [{x:-1920,y:0,width:1920,height:1080},{x:0,y:-800,width:1280,height:800},{x:0,y:0,width:320,height:480}]) {
    const orb=clampOrb({x:area.x+area.width-112,y:area.y+area.height-112,width:112,height:112},area);
    const panel=panelBounds(orb,area);
    assert.ok(panel.x>=area.x&&panel.y>=area.y);
    assert.ok(panel.x+panel.width<=area.x+area.width&&panel.y+panel.height<=area.y+area.height);
    assert.equal(panel.width,Math.min(420,area.width));
  }
});
test('dragged panel and orb reach right corners while panel automatically flips left',()=>{
  const area={x:0,y:0,width:1920,height:1080};
  const orbStart={x:500,y:400,width:112,height:112};
  const pointerStart={x:550,y:450};
  for(const point of [{x:2500,y:-500},{x:2500,y:1800}]) {
    const next=draggedGroupBounds(orbStart,pointerStart,point,area);
    assert.equal(next.orb.x,1808);
    assert.equal(next.panel.x,1380);
    assert.ok(next.panel.x+next.panel.width<=next.orb.x);
    assert.ok(next.orb.y===0||next.orb.y===968);
    assert.ok(next.panel.y>=area.y&&next.panel.y+next.panel.height<=area.height);
  }
});
test('public client cancel remains waiting until runtime confirms terminal state',async()=>{
  const runtime=new FakeRuntime({mode:'test',scenario:'cancel'});
  const client=new Client(runtime,()=>runtime.clock.now()); await client.connect();
  const {taskId}=await client.call('task.submit',{goal:'桌面联调',conversationId:'test'},{idempotencyKey:'desktop-test'});
  const result=await client.call('task.cancel',{taskId});assert.equal(result.state,'cancelling');
  assert.equal(orbState(result),'waiting');runtime.advance(taskId);
  const task=await client.call('task.get',{taskId});assert.equal(task.state,'cancelled');assert.equal(orbState(task),'idle');
});
test('competition task submission extends the real request deadline and preserves cancellation',async()=>{
  const runtime=new FakeRuntime({mode:'test',scenario:'success'});
  let submittedRequest;
  const transport={send(request,signal){
    if(request.operation==='task.submit') submittedRequest=request;
    return runtime.send(request,signal);
  }};
  const now=runtime.clock.now();
  const client=new Client(transport,()=>now);await client.connect();
  await client.call('task.submit',{goal:'Competition deadline',conversationId:'test'},taskSubmitOptions(true,'competition-deadline'));
  assert.equal(Date.parse(submittedRequest.deadline)-now,AGENTARTS_TASK_TIMEOUT_MS);

  const localRuntime=new FakeRuntime({mode:'test',scenario:'success'});
  let localRequest;
  const localClient=new Client({send(request,signal){
    if(request.operation==='task.submit') localRequest=request;
    return localRuntime.send(request,signal);
  }},()=>localRuntime.clock.now());
  await localClient.connect();
  await localClient.call('task.submit',{goal:'Local deadline',conversationId:'test'},taskSubmitOptions(false,'local-deadline'));
  assert.equal(Date.parse(localRequest.deadline)-localRuntime.clock.now(),10_000);

  const cancellationRuntime=new FakeRuntime({mode:'test',scenario:'success'});
  const cancellationClient=new Client({send(request,signal){
    if(request.operation!=='task.submit') return cancellationRuntime.send(request,signal);
    return new Promise((resolve,reject)=>{
      signal.addEventListener('abort',()=>reject(signal.reason??Error('aborted')),{once:true});
    });
  }},Date.now);
  await cancellationClient.connect();
  const controller=new AbortController();
  const pending=cancellationClient.call(
    'task.submit',
    {goal:'Competition cancellation',conversationId:'test'},
    {...taskSubmitOptions(true,'competition-cancellation'),signal:controller.signal},
  );
  controller.abort();
  await assert.rejects(pending,error=>error?.code==='CANCELLED'||error?.name==='AbortError');
});
