import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@personal-agent/client';
import {FakeCoordinationPort} from '@personal-agent/coordination/testing';
import {createRuntimeApplication,createDesktopSubagentDispatchTool,SUBAGENT_DISPATCH_TOOL_NAME,SUBAGENT_DISPATCH_TOOL_VERSION} from '../dist/application.js';
const read={name:'fixture.default-child-read',version:'1.0.0',sideEffect:'read',requiredScopes:['fixture:read'],
  requiresPresence:false,recoverySupport:true,idempotencySupport:true,inputSchema:{type:'object',required:['value'],properties:{value:{type:'string'}},additionalProperties:false},outputSchema:{type:'object'}};
async function until(predicate){for(let n=0;n<200;n++){if(predicate())return;await new Promise(r=>setTimeout(r,5));}throw Error('state did not arrive');}
test('default children reuse Competition worker and original approvals without an independent model API',async t=>{
  let app,reads=0,independentCalls=0;
  const dispatch=createDesktopSubagentDispatchTool({getRuntime:()=>app.runtime,getTools:()=>app.tools,
    runDefaultWorker:(subtask,worker,tools)=>app.runDefaultSubagentWorker(subtask,worker,tools),
    getModelGateway:()=>{independentCalls++;return undefined;}});
  const port=new FakeCoordinationPort(request=>{
    const task=app.runtime.getTask(request.taskId);
    if(task.conversationId.startsWith('desktop-subtask:')) {
      assert.equal(app.runtime.loadCheckpoint(task.taskId,'subtask-coordination-binding').profile,'huawei_ict_agentarts');
      assert.ok(app.runtime.loadCheckpoint(task.taskId,'subtask-tools-binding').every(tool=>tool.name!==SUBAGENT_DISPATCH_TOOL_NAME));
      if(task.goal.includes('approved child')&&!request.continuation)return {kind:'tool_proposal',proposalId:'original-child-read',
        toolName:read.name,toolVersion:read.version,arguments:{value:'public fixture'},verification:'mock'};
      return {kind:'text',text:'Child result '+task.goal,verification:'mock'};
    }
    if(!request.continuation)return {kind:'tool_proposal',proposalId:'default-dispatch',
      toolName:SUBAGENT_DISPATCH_TOOL_NAME,toolVersion:SUBAGENT_DISPATCH_TOOL_VERSION,
      arguments:{subtasks:[{subtaskId:'one',role:'researcher',goal:'approved child'},
        {subtaskId:'two',role:'planner',goal:'independent planning child',thinkingDepth:2}]},verification:'mock'};
    assert.equal(request.continuation.result.succeeded,2);assert.equal(request.continuation.result.failed,0);
    return {kind:'text',text:'Both default cloud roles completed',verification:'mock'};
  });
  app=createRuntimeApplication({path:':memory:',profile:'huawei_ict_agentarts',coordination:port,
    coordinationBinding:'fixed-original-cloud-source',tools:[dispatch,{descriptor:read,execute:async input=>{reads++;return input;}}],
    automaticTools:[{toolName:SUBAGENT_DISPATCH_TOOL_NAME,toolVersion:SUBAGENT_DISPATCH_TOOL_VERSION}]});t.after(()=>app.close());
  const client=new Client(app,Date.now);await client.connect();
  const parent=await client.call('task.submit',{goal:'Delegate two default roles',conversationId:'desktop-panel'},{idempotencyKey:'default-cloud'});
  await until(()=>app.runtime.getTask(parent.taskId).state==='waiting_approval'&&app.activeTaskCount===0);
  const child=app.runtime.findTaskByIdempotencyKey(`subagent-dispatch-${parent.taskId}-one`);
  assert.equal(reads,0);assert.equal(independentCalls,0);
  const approval=app.runtime.getApproval(`competition-tool-${child.taskId}-1`);
  await client.call('authorization.respond',{approvalId:approval.approvalId,expectedRevision:approval.revision,decision:'allow_once'});
  await until(()=>app.runtime.getTask(parent.taskId).state==='succeeded'&&app.activeTaskCount===0);
  assert.equal(reads,1);assert.equal(independentCalls,0);assert.equal(port.requests.length,5);
  assert.equal(app.runtime.readToolExecutions(parent.taskId).length,1);
  assert.equal(app.runtime.readToolExecutions(child.taskId)[0].state,'confirmed');
  assert.ok(app.runtime.getTask(parent.taskId).evidenceRefs.includes(approval.approvalId));
  assert.throws(()=>app.resumeTask(child.taskId),{code:'REVISION_CONFLICT'});assert.equal(reads,1);
});
