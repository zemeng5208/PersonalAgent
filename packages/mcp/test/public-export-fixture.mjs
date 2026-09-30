// Prepared offline ports; execute only in P8's unified verification.
import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {createPublicReferenceExport,createWorkspaceReferenceExport} from '../dist/index.js';

export function registerPublicExportCase(workspace) {test(`${workspace?'workspace':'MCP'} first read preflight, exact PUBLIC text, final replay and revoked/changed content`,()=>{
  const factory=workspace?createWorkspaceReferenceExport:createPublicReferenceExport;
  const content='公开合成 reference.\nSecond line.\n',digest=createHash('sha256').update(content).digest('hex');
  const path=workspace?'public.js':'public.md';
  const read=workspace?{path,encoding:'utf-8',content,byteLength:Buffer.byteLength(content),sha256:digest}
    :{path,text:content,contentDigest:digest,source:'mcp',serverVersion:'2026.8.31'};
  const input={taskId:'task-1',proposalId:'proposal-1',arguments:{path,...(workspace?{maxBytes:4096}:{})}};
  const query={taskId:input.taskId,proposalId:input.proposalId,path,configurationRef:'config-1',arguments:input.arguments};
  const permission={authorizationId:'native-1',expiresAt:new Date(Date.now()+60000).toISOString(),
    sensitivity:'PUBLIC',purpose:workspace?'coding-reference':'reference-summary',maxExportBytes:4096};
  let allowed=false,config='config-1',scope=permission,exact,receipt,reads=0,finalChecks=0,receiptChecks=0,onExact=()=>{};
  const ports={currentConfigurationRef:()=>config,readPreflight:q=>allowed && JSON.stringify(q)===JSON.stringify(query)?scope:undefined,
    readAuthorization:q=>{finalChecks++;assert.deepEqual(q,{...query,contentDigest:digest,byteLength:Buffer.byteLength(content)});onExact();return exact;},
    readConfirmed:q=>{receiptChecks++;assert.deepEqual(q,{...query,contentDigest:digest});return receipt;}};
  const exporter=factory(ports),signal=new AbortController().signal;
  assert.equal(factory().accepts(input),false);assert.equal(exporter.accepts(input),false);
  allowed=true;
  assert.equal(exporter.accepts({...input,phase:'preflight'}),true);
  assert.equal(finalChecks,0);assert.equal(receiptChecks,0); // No digest/receipt exists before the actual read.
  assert.equal(exporter.accepts({...input,phase:'final'}),false);
  assert.throws(()=>exporter.project({...input,result:read,signal}),{code:'UNAUTHORIZED'});
  // Original Gateway confirmation is represented by this fixture exactly once.
  reads++;receipt={runId:'original-run',result:read};
  assert.throws(()=>exporter.project({...input,result:read,signal}),{code:'UNAUTHORIZED'});
  assert.equal(reads,1); // Missing exact content consent retains the local receipt.
  exact={...permission,contentDigest:digest};
  const projection=exporter.project({...input,result:read,signal});
  assert.deepEqual(projection,{source:workspace?'approved-workspace-reference':'approved-reference',content,
    byteLength:Buffer.byteLength(content),contentDigest:digest,truncated:false,readConfirmed:true});
  assert.equal(exporter.accepts({...input,phase:'final',projection,signal}),true);
  const restarted=factory(ports);
  assert.equal(restarted.accepts({...input,phase:'final',projection,signal}),true); // Original receipt, no new read.
  assert.equal(reads,1);
  for(const changed of [{taskId:'task-2'},{proposalId:'proposal-2'},
    {arguments:{...input.arguments,path:'private.md'}},{arguments:{path:'../public.md'}},
    {arguments:{...input.arguments,public:true}},...(workspace?[{arguments:{path,maxBytes:2048}}]:[])])
    assert.equal(exporter.accepts({...input,...changed,phase:'preflight'}),false);
  assert.equal(exporter.accepts({...input,phase:'final',projection:{...projection,content:'changed'}}),false);
  assert.equal(exporter.accepts({...input,phase:'final',projection:{...projection,truncated:true}}),false);
  const changedRead=workspace?{...read,content:'changed'}:{...read,text:'changed'};
  assert.throws(()=>exporter.project({...input,result:changedRead,signal}),{code:'UNAUTHORIZED'});
  receipt={runId:'replacement-run',result:read};assert.equal(exporter.accepts({...input,phase:'final',projection}),false);
  receipt={runId:'original-run',result:read};exact={...permission,contentDigest:'0'.repeat(64)};
  assert.equal(exporter.accepts({...input,phase:'final',projection}),false);exact={...permission,contentDigest:digest};
  onExact=()=>{allowed=false;};assert.equal(exporter.accepts({...input,phase:'final',projection}),false);
  onExact=()=>{};allowed=true;config='config-2';assert.equal(exporter.accepts({...input,phase:'final',projection}),false);
  config='config-1';scope={...permission,sensitivity:'PRIVATE'};assert.equal(factory(ports).accepts(input),false);
  scope={...permission,purpose:undefined};assert.equal(factory(ports).accepts(input),false);
  scope={...permission,maxExportBytes:4};exact={...scope,contentDigest:digest};
  const bounded=factory(ports);assert.equal(bounded.accepts(input),true);
  assert.throws(()=>bounded.project({...input,result:read,signal}),{code:'UNAUTHORIZED'}); // No silent truncation.
  scope={...permission,expiresAt:'2000-01-01T00:00:00Z'};assert.equal(factory(ports).accepts(input),false);
  const abort=new AbortController();abort.abort();assert.throws(()=>exporter.project({...input,result:read,signal:abort.signal}),{code:'CANCELLED'});
  exporter.dispose();assert.equal(exporter.accepts(input),false);assert.equal(reads,1);
});}
