import test from 'node:test';
import assert from 'node:assert/strict';
import {FakeCoordinationPort} from '@personal-agent/coordination/testing';
import {createRuntimeApplication} from '../dist/application.js';

test('current public input enums update while registered permissions remain fixed',async()=>{
  let binding='source-1',calls=0,sideEffect='read';
  const tool={get descriptor(){return {name:'synthetic.read',version:'1.0.0',sideEffect,requiredScopes:['synthetic:read'],
    inputSchema:{type:'object',properties:{binding:{type:'string',enum:[binding]}},required:['binding'],additionalProperties:false},
    outputSchema:{type:'object',properties:{read:{type:'boolean'}},required:['read'],additionalProperties:false},
    requiresPresence:false,recoverySupport:false,idempotencySupport:true};},execute:async()=>{calls++;return {read:true};}};
  const app=createRuntimeApplication({path:':memory:',profile:'huawei_ict_agentarts',hostUserNamespace:'synthetic-current-schema',tools:[tool],
    automaticTools:[{toolName:'synthetic.read',toolVersion:'1.0.0'}],coordination:new FakeCoordinationPort(()=>({kind:'text',text:'unused',verification:'mock'}))});
  try {
    assert.deepEqual(app.tools.list()[0].inputSchema.properties.binding.enum,['source-1']);binding='source-2';
    assert.deepEqual(app.tools.list()[0].inputSchema.properties.binding.enum,['source-2']);
    const submitted=app.submitHostToolTask({commandId:'current',toolName:'synthetic.read',toolVersion:'1.0.0',arguments:{binding},deadline:new Date(Date.now()+30000).toISOString()});
    for(let i=0;i<100&&app.activeTaskCount;i++)await new Promise(r=>setTimeout(r,5));
    assert.equal(app.runtime.getTask(submitted.task.taskId).state,'succeeded');assert.equal(calls,1);
    sideEffect='local_write';assert.throws(()=>app.tools.list(),{code:'UNAUTHORIZED'});assert.equal(calls,1);
  }finally {app.close();}
});
