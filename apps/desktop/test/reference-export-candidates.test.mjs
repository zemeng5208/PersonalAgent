// Prepared native metadata fixtures, not SDK/SQLite/native-UI acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createDesktopReferenceHost} from '../electron/reference-tools-host.js';
import {MCP_READ_RESULT_SCHEMA} from '@personal-agent/mcp';
import {CLOUD_SKILL_TOOL_NAME,CLOUD_SKILL_TOOL_VERSION} from '@personal-agent/skills';

test('native MCP candidates separate preflight from original confirmation and never expose body or borrow Skill run',async()=>{
  const checkpoints=new Map(),key=(taskId,k)=>JSON.stringify([taskId,k]);let active=true,records=[];
  const taskId='synthetic-task',proposalId='synthetic-proposal',deadline=new Date(Date.now()+60000).toISOString();
  const task={taskId,state:'running',cancelRequested:false,evidenceRefs:[]};
  const manifest={id:'workspace-reference-summary',version:'1.0.0',digest:'a'.repeat(64)};
  const runtime={loadCheckpoint:(t,k)=>structuredClone(checkpoints.get(key(t,k))),
    saveCheckpointOnce:(t,k,v)=>{if(checkpoints.has(key(t,k)))return false;checkpoints.set(key(t,k),structuredClone(v));return true;},
    getTask:()=>structuredClone(task),readToolExecutions:()=>structuredClone(records),requestCancel:()=>{},
    matchesToolExecutionInput:(record,input)=>JSON.stringify(record.input)===JSON.stringify(input)};
  const application={runtime,configureReferenceSkill:()=>{},setReferenceSkillEnabled:()=>{},referenceSkillSnapshot:()=>({manifest})};
  const descriptor={name:'mcp.workspace.read_text',version:'1.0.0',inputSchema:{type:'object',properties:{path:{type:'string',minLength:1,maxLength:1024}},required:['path'],additionalProperties:false},outputSchema:MCP_READ_RESULT_SCHEMA};
  const createMcp=()=>{let connected=false;return {tools:[{descriptor}],health:()=>({connected}),start:async()=>{connected=true;},dispose:async()=>{connected=false;}};};
  let publicRefs=['public-reference'],skillAllowed=true,replaceBindingOnAliasRead=false;
  const host=createDesktopReferenceHost({hostUserNamespace:'synthetic-user',workspace:{
    readWorkspaceBinding:()=>({rootPath:'synthetic-root',nodeExecutable:'synthetic-node',bindingId:'synthetic-session'}),
    isWorkspaceBindingCurrent:()=>active},createMcp,resolvePublicSkillPath:()=> 'public.md',
    publicSkillAvailability:async()=>skillAllowed,
    readPublicSkillSourceRefs:input=>{
      assert.equal(input.taskId,taskId);assert.equal(typeof input.configurationRef,'string');
      if(replaceBindingOnAliasRead) active=false;
      return publicRefs;
    }});
  host.bindApplication(application);await host.setMcpEnabled(true);host.bindTask(taskId);
  host.configureCloudSkillWorker({manifest:()=>manifest,health:()=>({connected:true}),invoke:async()=>{throw Error('catalog must not read');}});
  const catalogInput={taskId,deadline,signal:new AbortController().signal};
  const catalog=await host.cloudSkillCatalog(catalogInput);
  assert.deepEqual(catalog.inputSchema.properties.sourceRef.enum,['public-reference']);
  assert.equal(JSON.stringify(catalog).includes('public.md'),false);
  publicRefs=[];assert.equal(await host.cloudSkillCatalog(catalogInput),undefined);
  publicRefs=['../private.md'];assert.equal(await host.cloudSkillCatalog(catalogInput),undefined);
  publicRefs=['public-reference'];skillAllowed=false;assert.equal(await host.cloudSkillCatalog(catalogInput),undefined);skillAllowed=true;
  replaceBindingOnAliasRead=true;assert.equal(await host.cloudSkillCatalog(catalogInput),undefined);replaceBindingOnAliasRead=false;active=true;
  assert.equal(await host.cloudSkillCatalog({...catalogInput,signal:AbortSignal.abort()}),undefined);
  assert.equal(await host.cloudSkillCatalog({...catalogInput,deadline:new Date(0).toISOString()}),undefined);
  const put=(k,v)=>checkpoints.set(key(taskId,k),structuredClone(v));
  put('application-profile','huawei_ict_agentarts');put('application-deadline',deadline);
  const proposal={kind:'tool_proposal',proposalId,toolName:descriptor.name,toolVersion:descriptor.version,arguments:{path:'public.md'},verification:'unverified'};
  put('competition-loop',{step:1,pending:proposal,receipts:[]});
  const query={taskId,proposalId,path:'public.md',configurationRef:runtime.loadCheckpoint(taskId,'desktop-reference-binding-v1')};
  const preflight=host.readPublicReferencePreflightCandidate(query);
  assert.equal(preflight.runId,`competition-tool-${taskId}-1`);assert.equal(preflight.contentDigest,undefined);
  assert.deepEqual(preflight.arguments,{path:query.path});assert.ok(Object.isFrozen(preflight.arguments));
  assert.equal(host.readPublicReferenceCandidate(query),undefined);
  const text='PUBLIC fixture.',contentDigest=createHash('sha256').update(text).digest('hex');
  const result={path:query.path,text,contentDigest,source:'mcp',serverVersion:'2026.8.31'};
  const runId=preflight.runId;
  records=[{evidenceId:runId,state:'confirmed',policyDecision:'allow',executionStarted:true,finishedAt:new Date().toISOString(),
    toolName:descriptor.name,toolVersion:descriptor.version,input:{arguments:proposal.arguments,scopeRef:runId}}];
  task.evidenceRefs=[runId];put('tool-result-'+runId,{result});
  const candidate=host.readPublicReferenceCandidate(query);
  assert.equal(candidate.contentDigest,contentDigest);assert.equal(candidate.byteLength,Buffer.byteLength(text));
  assert.equal(candidate.text,undefined);assert.equal(candidate.result,undefined);
  assert.deepEqual(host.readConfirmedPublicReference({...query,arguments:proposal.arguments,contentDigest}),{runId,result});
  put('competition-loop',{step:2,receipts:[{proposal}]});assert.equal(host.readPublicReferenceCandidate(query).runId,runId);
  for(const change of [{taskId:'foreign-task'},{path:'private.md'},{configurationRef:'replacement'},{public:true}])
    assert.equal(host.readPublicReferenceCandidate({...query,...change}),undefined);
  task.evidenceRefs=[];assert.equal(host.readPublicReferenceCandidate(query),undefined);task.evidenceRefs=[runId];
  records[0].policyDecision='deny';assert.equal(host.readPublicReferenceCandidate(query),undefined);records[0].policyDecision='allow';
  put('tool-result-'+runId,{result:{...result,text:'changed'}});assert.equal(host.readPublicReferenceCandidate(query),undefined);
  put('tool-result-'+runId,{result});
  const skillProposal='synthetic-skill-proposal',choice={skillId:manifest.id,version:manifest.version,digest:manifest.digest,sourceRef:'public-source'};
  put('competition-loop',{step:2,pending:{kind:'tool_proposal',proposalId:skillProposal,toolName:CLOUD_SKILL_TOOL_NAME,
    toolVersion:CLOUD_SKILL_TOOL_VERSION,arguments:choice,verification:'unverified'},receipts:[{proposal}]});
  const skillQuery={...query,proposalId:skillProposal};
  assert.equal(host.readPublicReferencePreflightCandidate(skillQuery).runId,`skill-read-${taskId}-${manifest.digest.slice(0,16)}`);
  assert.equal(host.readPublicReferenceCandidate(skillQuery),undefined); // A confirmed Competition run cannot stand in for Skill.
  task.cancelRequested=true;assert.equal(host.readPublicReferencePreflightCandidate(skillQuery),undefined);task.cancelRequested=false;
  active=false;assert.equal(host.readPublicReferenceCandidate(query),undefined);
  await host.dispose();
});
