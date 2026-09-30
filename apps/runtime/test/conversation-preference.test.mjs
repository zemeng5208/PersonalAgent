import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@personal-agent/client';
import {FakeCoordinationPort} from '@personal-agent/coordination/testing';
import {createRuntimeApplication} from '../dist/application.js';
test('each accepted conversation captures its own model version and step budget without changing active tasks',async t=>{
  const preferences=new Map([
    ['panel',{modelId:'model-a',configurationRef:'config-a',depth:1,fast:false}],
    ['workspace',{modelId:'model-b',configurationRef:'config-b',depth:5,fast:true}],
  ]);
  const app=createRuntimeApplication({path:':memory:',profile:'huawei_ict_agentarts',
    coordination:new FakeCoordinationPort(()=>({kind:'text',text:'synthetic answer',verification:'mock'})),
    readConversationPreference:id=>({...preferences.get(id)})});
  t.after(()=>app.close());const client=new Client(app,Date.now);await client.connect();
  const first=await client.call('task.submit',{goal:'first',conversationId:'panel'},{idempotencyKey:'first'});
  preferences.set('panel',{modelId:'new-model',configurationRef:'new-version',depth:0,fast:true});
  const second=await client.call('task.submit',{goal:'second',conversationId:'workspace'},{idempotencyKey:'second'});
  assert.deepEqual(app.runtime.loadCheckpoint(first.taskId,'task-model-preference'),{modelId:'model-a',configurationRef:'config-a'});
  assert.deepEqual(app.runtime.loadCheckpoint(first.taskId,'task-thinking'),{depth:1,fast:false,maxSteps:4});
  assert.deepEqual(app.runtime.loadCheckpoint(second.taskId,'task-model-preference'),{modelId:'model-b',configurationRef:'config-b'});
  assert.deepEqual(app.runtime.loadCheckpoint(second.taskId,'task-thinking'),{depth:5,fast:true,maxSteps:10});
  for(let i=0;i<100&&app.activeTaskCount;i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(app.activeTaskCount,0);
});
