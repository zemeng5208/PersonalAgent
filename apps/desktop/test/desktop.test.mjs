import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@personal-agent/client';
import {FakeRuntime} from '@personal-agent/testkit';
import {panelBounds,clampOrb} from '../electron/placement.js';
import {orbState} from '../src/features/conversation/state.js';
test('panel stays within negative-origin and small display work areas',()=>{
  for(const area of [{x:-1920,y:0,width:1920,height:1080},{x:0,y:-800,width:1280,height:800},{x:0,y:0,width:320,height:480}]) {
    const orb=clampOrb({x:area.x+area.width-112,y:area.y+area.height-112,width:112,height:112},area);
    const panel=panelBounds(orb,area);
    assert.ok(panel.x>=area.x&&panel.y>=area.y);
    assert.ok(panel.x+panel.width<=area.x+area.width&&panel.y+panel.height<=area.y+area.height);
    assert.equal(panel.width,Math.min(372,area.width));
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
