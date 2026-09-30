import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {createReferenceSummarySkill} from '../dist/index.js';

const hash=value=>createHash('sha256').update(value).digest('hex');

test('started Skill restores only the bound trusted confirmed read, with zero reinvocation and no invented Evidence',async()=>{
  const checkpoints=new Map();let calls=0;let reads=0;let configurationRef='synthetic-config-1';let receipt;
  let releaseRead;let hold=false;let latestQuery;
  const tools={list:()=>[{name:'mcp.workspace.read_text',version:'1.0.0',sideEffect:'read'}],invoke:async()=>{calls++;return {state:'unknown',evidenceRefs:[]};}};
  const reconciliation={currentConfigurationRef:()=>configurationRef,readConfirmed:async query=>{
    reads++;latestQuery=query;
    if(hold) return new Promise(resolve=>{releaseRead=resolve;});
    return receipt;
  }};
  const skill=createReferenceSummarySkill({tools,reconciliation,isToolAvailable:()=>true,enabled:true});
  const abort=new AbortController();
  const context={taskId:'synthetic-recovery-task',deadline:new Date(Date.now()+60000).toISOString(),signal:abort.signal,
    loadCheckpoint:key=>structuredClone(checkpoints.get(key)),saveCheckpoint:(key,value)=>checkpoints.set(key,structuredClone(value)),reportProgress:()=>{}};
  const manifest=skill.manifest();const input={skillId:manifest.id,version:manifest.version,digest:manifest.digest,path:'reference.md'};
  const runId=`skill-read-${context.taskId}-${manifest.digest.slice(0,16)}`;
  const text='Trusted public recovery reference.\nResume the pure excerpt step.';
  const result={path:input.path,text,contentDigest:hash(text),source:'mcp',serverVersion:'2026.8.31'};
  // Seed through the owned runner, then model a crash before the Skill received
  // the eventual Runtime confirmation. The adapter/Evidence here is offline.
  assert.equal((await skill.invoke(input,context)).state,'unknown');assert.equal(calls,1);
  const [key,checkpoint]=[...checkpoints.entries()][0];checkpoint.phase='started';checkpoints.set(key,checkpoint);
  assert.equal(checkpoint.configurationRef,configurationRef);
  assert.equal((await skill.invoke(input,context)).state,'unknown');assert.equal(calls,1);
  assert.equal(latestQuery.taskId,context.taskId);assert.equal(latestQuery.runId,runId);
  assert.equal(latestQuery.authorizationRef,runId);assert.equal(latestQuery.toolName,'mcp.workspace.read_text');assert.equal(latestQuery.toolVersion,'1.0.0');
  assert.deepEqual(latestQuery.arguments,{path:input.path});assert.equal(latestQuery.argumentsDigest,hash(JSON.stringify({path:input.path})));
  assert.equal(latestQuery.skillId,input.skillId);assert.equal(latestQuery.skillVersion,input.version);assert.equal(latestQuery.skillDigest,input.digest);
  receipt={state:'confirmed',result,evidenceRefs:['unrelated-offline-evidence']};
  assert.equal((await skill.invoke(input,context)).state,'unknown');assert.equal(checkpoints.get(key).phase,'started');
  receipt={state:'confirmed',result,evidenceRefs:[runId]};
  // Reject configuration changes and disable/cancellation while the read-only
  // confirmation port is awaiting; the checkpoint must not be promoted.
  hold=true;const configRace=skill.invoke(input,context);configurationRef='synthetic-config-2';releaseRead(receipt);
  await assert.rejects(configRace,{code:'REVISION_CONFLICT'});assert.equal(checkpoints.get(key).phase,'started');
  configurationRef='synthetic-config-1';const disableRace=skill.invoke(input,context);skill.setEnabled(false);assert.equal(latestQuery.signal.aborted,true);releaseRead(receipt);
  await assert.rejects(disableRace,{code:'CANCELLED'});assert.equal(checkpoints.get(key).phase,'started');skill.setEnabled(true);
  const cancelRace=skill.invoke(input,context);abort.abort();releaseRead(receipt);await assert.rejects(cancelRace,{code:'CANCELLED'});assert.equal(checkpoints.get(key).phase,'started');
  hold=false;const resumedContext={...context,signal:new AbortController().signal};
  const restored=await skill.invoke(input,resumedContext);assert.equal(restored.state,'confirmed');assert.match(restored.resultSummary,/Trusted public recovery reference/);
  assert.deepEqual(restored.evidenceRefs,[runId]);assert.equal(calls,1);assert.equal(checkpoints.get(key).phase,'complete');
  const readsBeforeReplay=reads;assert.deepEqual(await skill.invoke(input,resumedContext),restored);assert.equal(reads,readsBeforeReplay);assert.equal(calls,1);
  configurationRef='synthetic-config-2';await assert.rejects(skill.invoke(input,resumedContext),{code:'REVISION_CONFLICT'});
  configurationRef=undefined;await assert.rejects(skill.invoke(input,resumedContext),{code:'UNSUPPORTED_CAPABILITY'});
  assert.equal(reads,readsBeforeReplay);assert.equal(calls,1); // No old-summary replay across revoked sessions.
  skill.dispose();
});
