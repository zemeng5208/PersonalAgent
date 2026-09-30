import assert from 'node:assert/strict';
import test from 'node:test';
import {createRuntimeApplication, createDesktopSubagentDispatchTool} from '../dist/application.js';
import {ModelGateway, FakeModelProvider} from '@personal-agent/models';
import {FakeCoordinationPort} from '@personal-agent/coordination/testing';

const descriptor = {name:'fixture.child-read', version:'1.0.0',
  inputSchema:{type:'object',required:['value'],additionalProperties:false,properties:{value:{type:'string'}}},
  outputSchema:{type:'object',required:['value'],additionalProperties:false,properties:{value:{type:'string'}}},
  sideEffect:'read',requiredScopes:['fixture:read'],idempotencySupport:true,recoverySupport:true,requiresPresence:false};
const context = parent => ({taskId:parent.taskId,runId:'dispatch',authorizationRef:'parent-ref',scopes:['agent:delegate'],
  signal:new AbortController().signal,deadline:new Date(Date.now()+60_000).toISOString()});
function fixture(automatic = true) {
  const calls = [];
  const tool = {descriptor,execute:async (input,ctx) => {calls.push(ctx); return input;}};
  const app = createRuntimeApplication({path:':memory:',profile:'huawei_ict_agentarts',tools:[tool],
    coordination:new FakeCoordinationPort(() => ({kind:'text',text:'unused',verification:'mock'})),
    ...(automatic ? {automaticTools:[{toolName:descriptor.name,toolVersion:descriptor.version}]} : {})});
  const parent = app.runtime.submitTask({goal:'delegate',conversationId:'competition',idempotencyKey:'parent'});
  return {app,parent,calls};
}
test('selected models use persisted child IDs, Policy, ToolGateway and Evidence; replay does not execute twice', async () => {
  const {app,parent,calls} = fixture();
  try {
    const requests = [];
    const gateways = new Map(['research','coder'].map(name => [name,new ModelGateway(new FakeModelProvider([
      req => {requests.push(req); return {kind:'tool_proposal',proposal:{toolName:descriptor.name,toolVersion:descriptor.version,arguments:{value:name}}};},
      req => {requests.push(req); return {kind:'final',text:`result ${name}`};},
    ], {model:name}))]));
    const selected = [];
    const dispatch = createDesktopSubagentDispatchTool({getRuntime:()=>app.runtime,getTools:()=>app.tools,
      getModelGateway:name=>{selected.push(name);return gateways.get(name);}});
    const input = {subtasks:[{subtaskId:'r',role:'researcher',goal:'research',model:'research',thinkingDepth:4},
      {subtaskId:'c',role:'coder',goal:'code',model:'coder',thinkingDepth:2}]};
    const result = await dispatch.execute(input,context(parent));
    assert.equal(result.succeeded,2);
    assert.deepEqual(selected,['research','coder']);
    assert.equal(calls.length,2);
    for (const [index,id] of ['r','c'].entries()) {
      const child = app.runtime.findTaskByIdempotencyKey(`subagent-dispatch-${parent.taskId}-${id}`);
      assert.equal(child.state,'succeeded');
      assert.equal(calls[index].taskId,child.taskId);
      assert.equal(calls[index].runId,`agent-run-${child.taskId}-1`);
      assert.equal(calls[index].authorizationRef,calls[index].runId);
      assert.equal(app.runtime.policy.get(calls[index].runId).usesRemaining,0);
      assert.ok(child.evidenceRefs.length > 0);
      assert.equal(app.runtime.loadCheckpoint(child.taskId,'subtask-parent').parentTaskId,parent.taskId);
    }
    assert.ok(requests.every(req=>req.reasoningEffort===undefined));
    const replay = await dispatch.execute(input,context(parent));
    assert.equal(replay.succeeded,2);
    assert.equal(calls.length,2);
    assert.equal(requests.length,4);
  } finally {app.close();}
});
test('unknown selected model stays failed without falling back to legacy Pangu config', async () => {
  const {app,parent} = fixture();
  try {
    const tool = createDesktopSubagentDispatchTool({getRuntime:()=>app.runtime,getModelGateway:()=>undefined,
      modelConfig:{baseUrl:'https://synthetic.invalid/v1',model:'legacy',apiKey:'synthetic'}});
    const result = await tool.execute({subtasks:[{subtaskId:'unknown',role:'coder',goal:'code',model:'missing'}]},context(parent));
    assert.equal(result.succeeded,0); assert.equal(result.failed,1);
    assert.equal(app.runtime.findTaskByIdempotencyKey(`subagent-dispatch-${parent.taskId}-unknown`).error.code,'UNSUPPORTED_CAPABILITY');
  } finally {app.close();}
});
test('a child waiting for actual approval cannot be aggregated as succeeded', async () => {
  const {app,parent,calls} = fixture(false);
  try {
    const gateway = new ModelGateway(new FakeModelProvider([()=>({kind:'tool_proposal',
      proposal:{toolName:descriptor.name,toolVersion:descriptor.version,arguments:{value:'pending'}}})]));
    const tool = app.createSubagentDispatchTool(()=>gateway);
    const result = await tool.execute({subtasks:[{subtaskId:'approval',role:'coder',goal:'read'}]},context(parent));
    assert.equal(result.succeeded,0); assert.equal(calls.length,0);
    const child = app.runtime.findTaskByIdempotencyKey(`subagent-dispatch-${parent.taskId}-approval`);
    assert.equal(child.state,'waiting_approval');
    assert.match(result.subtasks[0].error,/waiting_approval/);
    assert.equal(child.evidenceRefs.length,0);
  } finally {app.close();}
});
