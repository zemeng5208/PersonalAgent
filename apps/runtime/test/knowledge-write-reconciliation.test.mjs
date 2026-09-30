import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRuntimeApplication} from '../dist/application.js';
const descriptor={name:'knowledge.apply_note_patch',version:'1.0.0',inputSchema:{type:'object'},outputSchema:{type:'object'},
  sideEffect:'local_write',requiredScopes:['knowledge:write'],requiresPresence:false,idempotencySupport:true,recoverySupport:true};
const args={sourceId:'original-source',configRevision:1,path:'public-note.md',expectedSha256:'a'.repeat(64),
  edits:[{oldText:'old',newText:'new'}]};
async function idle(app){for(let n=0;n<100;n++){if(app.activeTaskCount===0)return;await new Promise(r=>setTimeout(r,5));}throw Error('not idle');}
test('knowledge recovery keeps one original run unknown until retained metadata finalizes',async t=>{
  let calls=0,readState='unknown',finalState='still_unknown',finalCalls=0,accepted;
  const app=createRuntimeApplication({path:':memory:',profile:'huawei_ict_agentarts',hostUserNamespace:'knowledge-user',
    tools:[{descriptor,execute:async()=>{calls++;throw Error('unknown fixture');}}],
    automaticTools:[{toolName:descriptor.name,toolVersion:descriptor.version}],
    knowledgeWriteReconciliation:{reconcile:async input=>({state:readState,
      operationId:createHash('sha256').update(input.taskId+'\n'+input.runId).digest('hex'),
      backupId:'public-backup',lockRetained:true,currentSha256:'b'.repeat(64)}),
      finalize:async input=>{finalCalls++;accepted=input;return {state:finalState,operationId:input.operationId,
        outcome:input.outcome,currentSha256:input.currentSha256};}}});t.after(()=>app.close());
  const submitted=app.submitHostToolTask({commandId:'knowledge-original',toolName:descriptor.name,toolVersion:descriptor.version,
    arguments:args,deadline:new Date(Date.now()+60000).toISOString()});await idle(app);
  const taskId=submitted.task.taskId,runId=`host-tool-${taskId}`;
  const context={deadline:new Date(Date.now()+60000).toISOString(),signal:new AbortController().signal};
  assert.equal(app.runtime.getTask(taskId).state,'waiting_reconciliation');
  await app.reconcileKnowledgeWriteTask(taskId,context);assert.equal(finalCalls,0);
  assert.equal(app.runtime.readToolExecutions(taskId)[0].reconciliationOutcome,undefined);
  readState='applied';await app.reconcileKnowledgeWriteTask(taskId,context);
  assert.equal(app.runtime.getTask(taskId).state,'waiting_reconciliation');
  assert.equal(accepted.executionRecordId,runId);assert.deepEqual(accepted.originalInput,args);
  assert.notEqual(accepted.readbackEvidenceRefs[0],runId);
  assert.ok(app.runtime.readEvidence(taskId).some(e=>e.evidenceId===accepted.readbackEvidenceRefs[0]&&e.kind==='observation'));
  finalState='finalized';await app.reconcileKnowledgeWriteTask(taskId,context);
  assert.equal(app.runtime.getTask(taskId).state,'succeeded');assert.equal(calls,1);
  assert.equal(app.runtime.readToolExecutions(taskId).length,1);
  await app.reconcileKnowledgeWriteTask(taskId,context);assert.equal(finalCalls,2);assert.equal(calls,1);
});
test('changed original knowledge intent cannot finalize or complete recovery',async t=>{
  let calls=0;
  const app=createRuntimeApplication({path:':memory:',profile:'huawei_ict_agentarts',hostUserNamespace:'knowledge-user',
    tools:[{descriptor,execute:async()=>{throw Error('unknown fixture');}}],
    automaticTools:[{toolName:descriptor.name,toolVersion:descriptor.version}],
    knowledgeWriteReconciliation:{reconcile:async()=>{calls++;throw Error('must not read');},finalize:async()=>{throw Error('must not finalize');}}});t.after(()=>app.close());
  const submitted=app.submitHostToolTask({commandId:'knowledge-changed',toolName:descriptor.name,toolVersion:descriptor.version,
    arguments:args,deadline:new Date(Date.now()+60000).toISOString()});await idle(app);
  const taskId=submitted.task.taskId,intent=app.runtime.loadCheckpoint(taskId,'host-tool-intent');
  app.runtime.saveCheckpoint(taskId,'host-tool-intent',{...intent,arguments:{...args,path:'other.md'}});
  await assert.rejects(()=>app.reconcileKnowledgeWriteTask(taskId,{deadline:new Date(Date.now()+60000).toISOString(),signal:new AbortController().signal}),{code:'UNAUTHORIZED'});
  assert.equal(calls,0);assert.equal(app.runtime.getTask(taskId).state,'waiting_reconciliation');
});
