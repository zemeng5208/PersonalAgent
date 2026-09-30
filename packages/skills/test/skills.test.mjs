import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {createReferenceSummarySkill} from '../dist/index.js';

const hash=text=>createHash('sha256').update(text).digest('hex');
const descriptor={name:'mcp.workspace.read_text',version:'1.0.0',sideEffect:'read'};
function setup(invoke) {
  const checkpoints=new Map();const progress=[];const abort=new AbortController();let connected=true;
  const skill=createReferenceSummarySkill({enabled:true,tools:{list:()=>[descriptor],invoke},isToolAvailable:()=>connected});
  const context={taskId:'synthetic-skill',deadline:new Date(Date.now()+60000).toISOString(),signal:abort.signal,
    loadCheckpoint:key=>structuredClone(checkpoints.get(key)),saveCheckpoint:(key,value)=>checkpoints.set(key,structuredClone(value)),reportProgress:value=>progress.push(value)};
  const manifest=skill.manifest();const input={skillId:manifest.id,version:manifest.version,digest:manifest.digest,path:'reference.md'};
  return {skill,context,input,checkpoints,progress,abort,disconnect:()=>{connected=false;}};
}
const confirmed={state:'confirmed',result:{path:'reference.md',text:'Public reference.\nSecond source line.\nThird ignored line.',contentDigest:hash('Public reference.\nSecond source line.\nThird ignored line.'),source:'mcp',serverVersion:'2026.8.31'},evidenceRefs:['synthetic-evidence']};

test('fixed manifest binds version/digest/input and confirmed steps are not repeated',async()=>{
  let calls=0;const env=setup(async invocation=>{calls++;assert.equal(invocation.authorizationRef,invocation.runId);return confirmed;});
  assert.equal(env.skill.manifest().capabilities[0].sideEffect,'read');
  const result=await env.skill.invoke(env.input,env.context);assert.equal(result.state,'confirmed');assert.match(result.resultSummary,/Public reference. Second source line./);assert.equal(result.sources[0].path,'reference.md');
  assert.deepEqual(await env.skill.invoke(env.input,env.context),result);assert.equal(calls,1);
  await assert.rejects(env.skill.invoke({...env.input,path:'another.md'},env.context),{code:'REVISION_CONFLICT'});
  await assert.rejects(env.skill.invoke({...env.input,digest:'0'.repeat(64)},env.context),{code:'PROTOCOL_MISMATCH'});
  await assert.rejects(env.skill.invoke({...env.input,version:'2.0.0'},env.context),{code:'INVALID_ARGUMENT'});
  env.skill.setEnabled(false);await assert.rejects(env.skill.invoke(env.input,env.context),{code:'UNSUPPORTED_CAPABILITY'});assert.equal(calls,1);
});

test('pending approval resumes same run identifier; unknown execution is never blindly retried',async()=>{
  const runs=[];const env=setup(async invocation=>{runs.push(invocation.runId);return runs.length===1?{state:'pending',evidenceRefs:[]}:confirmed;});
  assert.equal((await env.skill.invoke(env.input,env.context)).state,'pending');
  assert.equal((await env.skill.invoke(env.input,env.context)).state,'confirmed');assert.equal(runs[0],runs[1]);
  let calls=0;const uncertain=setup(async()=>{calls++;return {state:'unknown',evidenceRefs:['synthetic-unknown']};});
  assert.equal((await uncertain.skill.invoke(uncertain.input,uncertain.context)).state,'unknown');
  assert.equal((await uncertain.skill.invoke(uncertain.input,uncertain.context)).state,'unknown');assert.equal(calls,1);
});

test('disable during a tool await aborts it and preserves confirmed step without continuing summary',async()=>{
  let release;let invocationSignal;let calls=0;
  const env=setup(async invocation=>{calls++;invocationSignal=invocation.signal;return new Promise(resolve=>{release=resolve;});});
  const run=env.skill.invoke(env.input,env.context);env.skill.setEnabled(false);assert.equal(invocationSignal.aborted,true);
  release(confirmed);await assert.rejects(run,{code:'CANCELLED'});
  assert.equal([...env.checkpoints.values()][0].phase,'read-confirmed');
  env.skill.setEnabled(true);assert.equal((await env.skill.invoke(env.input,env.context)).state,'confirmed');assert.equal(calls,1);
});

test('cancellation, disconnected dependencies and source mismatch fail closed',async()=>{
  let calls=0;const cancelled=setup(async()=>{calls++;return confirmed;});cancelled.abort.abort();
  await assert.rejects(cancelled.skill.invoke(cancelled.input,cancelled.context),{code:'CANCELLED'});assert.equal(calls,0);
  const disconnected=setup(async()=>confirmed);disconnected.disconnect();
  await assert.rejects(disconnected.skill.invoke(disconnected.input,disconnected.context),{code:'UNSUPPORTED_CAPABILITY'});
  const mismatch=setup(async()=>({...confirmed,result:{...confirmed.result,contentDigest:'0'.repeat(64)}}));
  await assert.rejects(mismatch.skill.invoke(mismatch.input,mismatch.context),{code:'RESULT_UNKNOWN'});
  assert.equal((await mismatch.skill.invoke(mismatch.input,mismatch.context)).state,'unknown');
});
