// Explicit offline worker/permission fixtures; not production fallback.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReferenceSummarySkill,createCloudSkillSelectionPort,CLOUD_SKILL_TOOL_NAME,CLOUD_SKILL_TOOL_VERSION,CLOUD_SKILL_PUBLIC_ENUM_PATHS} from '../dist/index.js';
const sha=text=>createHash('sha256').update(text).digest('hex');
function setup() {
  const checkpoints=new Map();let calls=0;let grant=true;let configurationRef='synthetic-config';
  let toolState='confirmed';const text='Public fixture.\nSecond line.';
  const worker=createReferenceSummarySkill({enabled:true,isToolAvailable:()=>true,
    reconciliation:{currentConfigurationRef:()=>configurationRef,readConfirmed:async()=>undefined},
    tools:{list:()=>[{name:'mcp.workspace.read_text',version:'1.0.0',sideEffect:'read'}],invoke:async()=>{
      calls++;return {state:toolState,evidenceRefs:['synthetic-evidence'],result:{path:'reference.md',text,contentDigest:sha(text),source:'mcp',serverVersion:'2026.8.31'}};
    }}});
  const source={path:'reference.md',sourceRef:'public-source',contentDigest:sha(text),configurationRef,revision:1,
    authorizationId:'synthetic-native-authorization',expiresAt:new Date(Date.now()+60000).toISOString()};
  const port=createCloudSkillSelectionPort({versionedSkillworker:worker,resolvePublicSource:()=>{
    if(!grant) throw Object.assign(Error('Permission revoked'),{code:'UNAUTHORIZED'});
    return {...source,configurationRef};
  }});
  const abort=new AbortController();
  const context={taskId:'synthetic-task',proposalId:'synthetic-proposal',revision:1,deadline:new Date(Date.now()+60000).toISOString(),signal:abort.signal,
    loadCheckpoint:key=>structuredClone(checkpoints.get(key)),saveCheckpoint:(key,value)=>checkpoints.set(key,structuredClone(value)),reportProgress:()=>{}};
  return {worker,port,context,checkpoints,abort,calls:()=>calls,revoke:()=>{grant=false;},
    config:value=>{configurationRef=value;},state:value=>{toolState=value;}};
}
test('cloud choice runs injected worker outside tool locks; minimal receipt and replay retain original run',async()=>{
  const e=setup();const choice=e.port.catalog('public-source',e.context);
  const descriptor=e.port.describe();assert.equal(descriptor.name,CLOUD_SKILL_TOOL_NAME);
  for(const field of ['skillId','version','digest','sourceRef']) assert.equal(descriptor.inputSchema.properties[field].type,'string');
  assert.deepEqual(CLOUD_SKILL_PUBLIC_ENUM_PATHS,['/skillId','/version','/digest']);
  assert.deepEqual(Object.keys(choice).sort(),['digest','skillId','sourceRef','version']);
  const selection=e.port.select(choice,e.context);assert.deepEqual(e.port.select(choice,e.context),selection);
  const receipt=await e.port.run(selection,e.context);assert.equal(receipt.state,'confirmed');
  assert.deepEqual(Object.keys(receipt).sort(),['contentDigest','selectionRef','sourceRef','state']);
  e.port.assertReceiptAllowed(selection,receipt,e.context);
  assert.throws(()=>e.port.assertReceiptAllowed(selection,{...receipt,extra:'secret'},e.context),{code:'UNAUTHORIZED'});
  assert.deepEqual(await e.port.run(selection,e.context),receipt);assert.equal(e.calls(),1);
  await assert.rejects(e.port.run({...selection,selectionRef:'forged'},e.context),{code:'UNAUTHORIZED'});
  e.revoke();assert.throws(()=>e.port.assertReceiptAllowed(selection,receipt,e.context),{code:'UNAUTHORIZED'});
  await assert.rejects(e.port.run(selection,e.context),{code:'UNAUTHORIZED'});assert.equal(e.calls(),1);
});
test('existing tool_proposal dispatch preserves original task/proposal and never registers Skill as a tool',async()=>{
  const e=setup();const choice=e.port.catalog('public-source',e.context);
  const proposal={kind:'tool_proposal',proposalId:e.context.proposalId,toolName:CLOUD_SKILL_TOOL_NAME,
    toolVersion:CLOUD_SKILL_TOOL_VERSION,arguments:choice,verification:'unverified'};
  const receipt=await e.port.dispatch(proposal,e.context);assert.equal(receipt.state,'confirmed');assert.equal(e.calls(),1);
  assert.equal(e.checkpoints.get('skill:cloud-selection:v1').proposalId,proposal.proposalId);
  await assert.rejects(e.port.run(e.checkpoints.get('skill:cloud-selection:v1').selection,{...e.context,proposalId:'replacement'}),{code:'UNAUTHORIZED'});
  assert.throws(()=>e.port.dispatch({...proposal,verification:'mock'},e.context),{code:'UNSUPPORTED_CAPABILITY'});
  const pending=setup();pending.state('pending');const pendingChoice=pending.port.catalog('public-source',pending.context);
  assert.equal((await pending.port.dispatch({...proposal,arguments:pendingChoice},pending.context)).state,'pending');
  pending.state('confirmed');assert.equal((await pending.port.dispatch({...proposal,arguments:pendingChoice},pending.context)).state,'confirmed');
  assert.equal(pending.calls(),2);
});
test('unknown is reconciled without another call; config/revision and complete-checkpoint body changes are rejected',async()=>{
  const e=setup();e.state('unknown');const choice=e.port.catalog('public-source',e.context);const selection=e.port.select(choice,e.context);
  assert.equal((await e.port.run(selection,e.context)).state,'unknown');assert.equal((await e.port.run(selection,e.context)).state,'unknown');assert.equal(e.calls(),1);
  e.config('replacement');await assert.rejects(e.port.run(selection,e.context),{code:'REVISION_CONFLICT'});
  const done=setup();const selected=done.port.select(done.port.catalog('public-source',done.context),done.context);await done.port.run(selected,done.context);
  const key='skill:workspace-reference-summary:v1';const saved=done.checkpoints.get(key);saved.read.text='changed';done.checkpoints.set(key,saved);
  await assert.rejects(done.port.run(selected,done.context),{code:'RESULT_UNKNOWN'});assert.equal(done.calls(),1);
  await assert.rejects(done.port.run(selected,{...done.context,revision:2}),{code:'UNAUTHORIZED'});
});
test('missing worker, version replacement, stop and cancellation cannot grant a Skill run',async()=>{
  const e=setup();const choice=e.port.catalog('public-source',e.context);
  assert.throws(()=>e.port.select({...choice,digest:'0'.repeat(64)},e.context),{code:'PROTOCOL_MISMATCH'});
  const absent=createCloudSkillSelectionPort({resolvePublicSource:()=>{throw Error('must not run');}});
  assert.throws(()=>absent.catalog('public-source',e.context),{code:'UNSUPPORTED_CAPABILITY'});
  const selected=e.port.select(choice,e.context);e.port.close();await assert.rejects(e.port.run(selected,e.context),{code:'CANCELLED'});assert.equal(e.calls(),0);
  const cancelled=setup();cancelled.abort.abort();assert.throws(()=>cancelled.port.catalog('public-source',cancelled.context),{code:'CANCELLED'});
});
