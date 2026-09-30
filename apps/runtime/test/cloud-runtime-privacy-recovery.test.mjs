import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {TaskRuntime} from '../dist/index.js';
import {createRuntimeApplication} from '../dist/application.js';
import {ProtocolError} from '@personal-agent/contracts';
const deadline=()=>new Date(Date.now()+60000).toISOString();
const scope=()=>({deadline:deadline(),signal:new AbortController().signal});
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const binding=task=>({taskId:task.taskId,conversationId:task.conversationId,destination:'agentarts',
  configurationRef:'synthetic-config',deadline:deadline(),userGoalDigest:'a'.repeat(64),fact:{
    ref:{id:'synthetic-fact',revision:1},configurationRef:'synthetic-vault',summaryDigest:'b'.repeat(64),sourceDigest:'c'.repeat(64)}});

test('preflight retry retains the parsed original proposal and creates no execution or grant',async()=> {
  const runtime=new TaskRuntime(':memory:');
  try {
    const task=runtime.submitTask({goal:'public synthetic reference',conversationId:'preflight',idempotencyKey:'preflight'});
    const proposal={kind:'tool_proposal',proposalId:'original',toolName:'mcp.workspace.read_text',toolVersion:'1.0.0',arguments:{path:'public.txt'},verification:'unverified'};
    await runtime.runTask(task.taskId,async worker=> {
      worker.saveCheckpoint('competition-loop',{step:1,pending:proposal,evidenceRefs:[],receipts:[]});
      worker.saveCheckpoint('competition-preflight-withheld',{step:1,proposal});
      runtime.transitionTask(task.taskId,'waiting_reconciliation');
      return {resultSummary:'native preflight denied'};
    },{deadline:deadline(),sideEffect:'read'});
    assert.equal(runtime.prepareExportPreflightReplay(task.taskId).state,'waiting_approval');
    assert.deepEqual(runtime.loadCheckpoint(task.taskId,'competition-loop').pending,proposal);
    assert.deepEqual(runtime.readToolExecutions(task.taskId),[]);
    assert.equal(runtime.policy.get(`competition-tool-${task.taskId}-1`),undefined);
  } finally {runtime.close();}
});

test('copy erasure redacts original bodies, preserves identity and emits only exact actual purge receipt',async()=> {
  const runtime=new TaskRuntime(':memory:');
  try {
    const task=runtime.submitTask({goal:'synthetic derived body',conversationId:'synthetic',idempotencyKey:'copy'});
    const source=binding(task);
    runtime.saveCheckpoint(task.taskId,'private-memory:consumption:v1',source);
    runtime.saveCheckpoint(task.taskId,'application-goal','synthetic derived body');
    await runtime.runTask(task.taskId,async()=>({resultSummary:'synthetic derived answer'}),{deadline:deadline(),sideEffect:'read'});
    const erase={taskId:task.taskId,factId:source.fact.ref.id,bindingDigest:hash(source),...scope()};
    assert.throws(()=>runtime.eraseTaskCopies({...erase,bindingDigest:'d'.repeat(64)}),{code:'REVISION_CONFLICT'});
    assert.deepEqual(runtime.eraseTaskCopies(erase),{state:'purged'});
    assert.deepEqual(runtime.readCopyErasureReceipt(task.taskId),{taskId:task.taskId,factId:source.fact.ref.id,bindingDigest:hash(source),state:'purged'});
    assert.equal(runtime.getTask(task.taskId).resultSummary,undefined);
    assert.equal(runtime.readConversationHistory('synthetic',task.taskId).length,0);
    assert.equal(JSON.stringify(runtime.readEvents()).includes('synthetic derived'),false);
    assert.equal(JSON.stringify(runtime.loadCheckpoint(task.taskId,'application-goal')).includes('synthetic derived'),false);
    assert.equal(runtime.listBindings().items[0].taskId,task.taskId);
  } finally {runtime.close();}
});

test('active copies are durably withheld and cannot report purged while an external copy lacks acknowledgement',()=> {
  const runtime=new TaskRuntime(':memory:');
  try {
    const task=runtime.submitTask({goal:'synthetic',conversationId:'synthetic',idempotencyKey:'active'});
    const source=binding(task);runtime.saveCheckpoint(task.taskId,'private-memory:consumption:v1',source);
    const erase={taskId:task.taskId,factId:source.fact.ref.id,bindingDigest:hash(source),...scope()};
    assert.deepEqual(runtime.eraseTaskCopies(erase),{state:'withheld'});
    assert.equal(runtime.readCopyErasureReceipt(task.taskId),undefined);
    runtime.requestCancel(task.taskId);runtime.confirmCancellation(task.taskId);
    assert.deepEqual(runtime.eraseTaskCopies({...erase,externalCopiesPurged:false}),{state:'withheld'});
    assert.equal(runtime.readCopyErasureReceipt(task.taskId),undefined);
    assert.deepEqual(runtime.eraseTaskCopies({...erase,externalCopiesPurged:true}),{state:'purged'});
  } finally {runtime.close();}
});

test('a preliminary unknown poll cannot seal the original run against later verified readback',async()=> {
  let calls=0;
  const descriptor={name:'fixture.original-read',version:'1.0.0',inputSchema:{type:'object'},outputSchema:{type:'object'},
    sideEffect:'read',requiredScopes:['fixture:read'],idempotencySupport:true,recoverySupport:true,requiresPresence:false};
  const app=createRuntimeApplication({path:':memory:',profile:'huawei_ict_agentarts',
    tools:[{descriptor,execute:async()=>{calls++;throw new ProtocolError('RESULT_UNKNOWN','Synthetic fixture transport interrupted');}}],
    automaticTools:[{toolName:descriptor.name,toolVersion:descriptor.version}]});
  try {
    const task=app.runtime.submitTask({goal:'public synthetic read',conversationId:'recovery',idempotencyKey:'unknown'});
    const runId='original-synthetic-run';
    await app.runtime.runTask(task.taskId,async worker=> {
      const result=await app.tools.invoke({taskId:task.taskId,runId,authorizationRef:runId,toolName:descriptor.name,
        toolVersion:descriptor.version,arguments:{},deadline:worker.deadline,signal:worker.signal});
      return {resultSummary:'waiting',evidenceRefs:result.evidenceRefs};
    },{deadline:deadline(),sideEffect:'read'});
    assert.equal(app.runtime.getTask(task.taskId).state,'waiting_reconciliation');
    const original=app.runtime.readToolExecutions(task.taskId)[0];
    app.runtime.reconcileToolExecution(task.taskId,runId,'unknown');
    assert.deepEqual(app.runtime.readToolExecutions(task.taskId)[0],original);
    const evidenceId='fixture-readback';
    app.runtime.saveCheckpoint(task.taskId,'trusted-readback-evidence:'+evidenceId,{evidenceId,kind:'observation',
      sourceRef:'fixture:independent-status',capturedAt:new Date().toISOString(),summary:'Offline fixture original readback',verification:'verified',sensitivity:'public'});
    const recovered=app.runtime.reconcileToolExecution(task.taskId,runId,'applied',{value:'synthetic'},[evidenceId]);
    assert.equal(recovered.state,'succeeded');assert.equal(calls,1);
    assert.ok(recovered.evidenceRefs.includes(evidenceId));
    assert.equal(app.runtime.readToolExecutions(task.taskId)[0].inputDigest,original.inputDigest);
    assert.throws(()=>app.runtime.reconcileToolExecution(task.taskId,runId,'applied',{value:'different'},[evidenceId]),{code:'REVISION_CONFLICT'});
  } finally {app.close();}
});

test('history overlay uses the original Live id and cutoff without restoring private derived answers',async()=> {
  const app=createRuntimeApplication({path:':memory:',profile:'huawei_ict_agentarts',coordination:{execute:async()=>({kind:'text',text:'unused',verification:'unverified'})}});
  try {
    const previous=app.runtime.submitTask({goal:'synthetic public goal',conversationId:'history',idempotencyKey:'old'});
    await app.runtime.runTask(previous.taskId,async()=>({resultSummary:'synthetic public answer'}),{deadline:deadline(),sideEffect:'read'});
    const current=app.runtime.submitTask({goal:'next',conversationId:'history',idempotencyKey:'current'});
    const input={taskId:current.taskId,conversationId:'history',...scope(),historyMessages:[
      {id:'live-same-id',role:'user',text:'earlier',createdAt:'2000-01-01T00:00:00.000Z'},
      {id:'live-same-id',role:'user',text:'latest correction',createdAt:'2000-01-01T00:00:00.000Z'},
      {id:'future',role:'assistant',text:'future body',createdAt:'9999-01-01T00:00:00.000Z'}]};
    const context=app.readConversationContext(input);
    assert.equal(context.filter(message=>message.id==='live-same-id').length,1);
    assert.equal(context.find(message=>message.id==='live-same-id').content,'latest correction');
    assert.equal(context.some(message=>message.id==='future'),false);
    app.runtime.saveCheckpoint(previous.taskId,'private-derived-output',{withheld:true});
    assert.equal(app.readConversationContext(input).some(message=>message.taskId===previous.taskId),false);
  } finally {app.close();}
});
