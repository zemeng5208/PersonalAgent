import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {createPublicReferenceExport} from '../dist/index.js';

test('public export requires exact native consent and original confirmed receipt, and fails closed on changes',()=>{
  const text='Public synthetic reference.',contentDigest=createHash('sha256').update(text).digest('hex');
  const result={path:'public.md',text,contentDigest,source:'mcp',serverVersion:'2026.8.31'};
  const input={taskId:'task-1',proposalId:'proposal-1',arguments:{path:result.path}};
  const projection={taskId:input.taskId,proposalId:input.proposalId,result,signal:new AbortController().signal};
  let configuration='session-1',allowed=false,receipt={runId:'original-run',result},onReceipt=()=>{},onAuthorization=()=>{};
  let authorization={authorizationId:'native-1',contentDigest,expiresAt:new Date(Date.now()+20000).toISOString()};
  const expected={taskId:input.taskId,proposalId:input.proposalId,path:result.path,configurationRef:'session-1'};
  const port={currentConfigurationRef:()=>configuration,
    readAuthorization:query=>{onAuthorization();return allowed && JSON.stringify(query)===JSON.stringify(expected)?authorization:undefined;},
    readConfirmed:query=>{assert.deepEqual(query,{...expected,contentDigest});onReceipt();return receipt;}};
  const exporter=createPublicReferenceExport(port);
  assert.equal(createPublicReferenceExport().accepts(input),false);
  assert.equal(exporter.accepts(input),false); // Existing read permission alone is insufficient.
  assert.throws(()=>exporter.project(projection),{code:'UNAUTHORIZED'});
  allowed=true;assert.equal(exporter.accepts(input),true);
  assert.deepEqual(exporter.project(projection),{source:'approved-reference',contentDigest,readConfirmed:true});
  for(const altered of [{taskId:'task-2'},{proposalId:'proposal-2'},{arguments:{path:'private.md'}},
    {arguments:{path:'../public.md'}},{arguments:{path:result.path,public:true}}]) {
    assert.equal(exporter.accepts({...input,...altered}),false);
  }
  assert.throws(()=>exporter.project({...projection,taskId:'task-2'}),{code:'UNAUTHORIZED'});
  assert.throws(()=>exporter.project({...projection,result:{...result,text:'private replacement'}}),{code:'UNAUTHORIZED'});
  receipt=undefined;assert.throws(()=>exporter.project(projection),{code:'UNAUTHORIZED'});
  receipt={runId:'different-run',result};assert.throws(()=>exporter.project(projection),{code:'UNAUTHORIZED'});
  receipt={runId:'original-run',result:{...result,path:'private.md'}};assert.throws(()=>exporter.project(projection),{code:'UNAUTHORIZED'});
  receipt={runId:'original-run',result};allowed=false;
  assert.equal(exporter.accepts(input),false);assert.throws(()=>exporter.project(projection),{code:'UNAUTHORIZED'});
  allowed=true;authorization={...authorization,authorizationId:'native-2'};
  assert.equal(exporter.accepts(input),false);assert.throws(()=>exporter.project(projection),{code:'UNAUTHORIZED'});
  authorization={...authorization,authorizationId:'native-1',expiresAt:'2020-01-01T00:00:00.000Z'};
  assert.equal(exporter.accepts(input),false);assert.throws(()=>exporter.project(projection),{code:'UNAUTHORIZED'});
  authorization={...authorization,expiresAt:new Date(Date.now()+20000).toISOString()};
  const cancelled=new AbortController();cancelled.abort();
  assert.throws(()=>exporter.project({...projection,signal:cancelled.signal}),{code:'CANCELLED'});
  configuration='session-2';assert.equal(exporter.accepts(input),false);
  configuration='session-1';onAuthorization=()=>{configuration='session-2';};
  assert.equal(exporter.accepts(input),false);onAuthorization=()=>{};configuration='session-1';
  // Use a fresh exporter/consent for independent in-receipt revocation races.
  const fresh=createPublicReferenceExport(port);assert.equal(fresh.accepts(input),true);
  onReceipt=()=>{allowed=false;};assert.throws(()=>fresh.project(projection),{code:'UNAUTHORIZED'});
  allowed=true;onReceipt=()=>{configuration='session-2';};assert.throws(()=>fresh.project(projection),{code:'UNAUTHORIZED'});
  configuration='session-1';const inFlight=new AbortController();onReceipt=()=>inFlight.abort();
  assert.throws(()=>fresh.project({...projection,signal:inFlight.signal}),{code:'CANCELLED'});
  onReceipt=()=>{};
  fresh.dispose();assert.equal(fresh.accepts(input),false);assert.throws(()=>fresh.project(projection),{code:'UNAUTHORIZED'});
  assert.equal(JSON.stringify({source:'approved-reference',contentDigest,readConfirmed:true}).includes('public.md'),false);
});
