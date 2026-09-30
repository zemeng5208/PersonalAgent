// Prepared offline permission/receipt fixtures; not native or cloud evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createWorkspaceReferenceExport} from '../dist/index.js';
test('workspace source stays workspace; exact authorization and original confirmation export only a digest',()=>{
  const content='export const publicFixture = true;\n';const sha256=createHash('sha256').update(content).digest('hex');
  const read={path:'public.js',encoding:'utf-8',content,byteLength:Buffer.byteLength(content),sha256};
  const input={taskId:'synthetic-task',proposalId:'synthetic-proposal',arguments:{path:read.path}};
  const query={taskId:input.taskId,proposalId:input.proposalId,path:read.path,configurationRef:'synthetic-config'};
  let allowed=false,configuration='synthetic-config',receipt={runId:'original-workspace-run',result:read};
  let permission={authorizationId:'synthetic-native',contentDigest:sha256,expiresAt:new Date(Date.now()+60000).toISOString()};
  const exporter=createWorkspaceReferenceExport({currentConfigurationRef:()=>configuration,
    readAuthorization:q=>allowed && JSON.stringify(q)===JSON.stringify(query)?permission:undefined,
    readConfirmed:q=>{assert.deepEqual(q,{...query,contentDigest:sha256});return receipt;}});
  const project=()=>exporter.project({...input,result:read,signal:new AbortController().signal});
  assert.equal(createWorkspaceReferenceExport().accepts(input),false);assert.equal(exporter.accepts(input),false);
  allowed=true;assert.equal(exporter.accepts(input),true);
  assert.deepEqual(project(),{source:'approved-workspace-reference',contentDigest:sha256,readConfirmed:true});
  assert.equal(exporter.accepts({...input,arguments:{path:read.path,maxBytes:256}}),false);
  assert.throws(()=>exporter.project({...input,result:{path:read.path,text:content,contentDigest:sha256,source:'mcp',serverVersion:'2026.8.31'},signal:new AbortController().signal}),{code:'UNAUTHORIZED'});
  receipt={runId:'another-run',result:read};assert.throws(project,{code:'UNAUTHORIZED'});receipt={runId:'original-workspace-run',result:read};
  allowed=false;assert.throws(project,{code:'UNAUTHORIZED'});allowed=true;configuration='replacement';assert.throws(project,{code:'UNAUTHORIZED'});
  configuration='synthetic-config';permission={...permission,expiresAt:'2000-01-01T00:00:00Z'};assert.equal(exporter.accepts(input),false);
  const abort=new AbortController();abort.abort();assert.throws(()=>exporter.project({...input,result:read,signal:abort.signal}),{code:'CANCELLED'});
  exporter.dispose();assert.equal(exporter.accepts(input),false);
});
