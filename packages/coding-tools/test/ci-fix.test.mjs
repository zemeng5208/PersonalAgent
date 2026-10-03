import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {runCiFix, createCiFixWorkflow} from '../dist/dev-workflows/ci-fix.js';

const headSha = 'a'.repeat(40), fixedSha = 'b'.repeat(40), fileSha = 'c'.repeat(64);
function fixture() {
  const checkpoints = new Map(), calls = [];
  const context = {taskId: 'ci-task', deadline: '2099-01-01T00:00:00Z', signal: new AbortController().signal,
    saveCheckpoint(k,v) {checkpoints.set(k,structuredClone(v));}, loadCheckpoint(k) {return structuredClone(checkpoints.get(k));}, reportProgress() {throw Error('unused');}};
  const gitTools = {head: 'workspace.git.head', commit: 'workspace.git.commit', push: 'workspace.git.push', pullRequest: 'github.pr.create', backlink: 'github.pr.comment'};
  const names = [...Object.values(gitTools), 'github.actions.run.list', 'github.actions.job.list', 'github.actions.log.read', 'github.issue.get', 'github.issue.comment', 'workspace.read_text', 'workspace.apply_text_patch', 'workspace.run_allowed_command'];
  const responses = {
    'github.actions.run.list': {items: [{id: '42', conclusion: 'failure', headSha, url: 'https://github.test/runs/42'}]},
    'github.actions.job.list': {items: [{id:7,runId:42,conclusion:'failure'}]},
    'github.actions.log.read': {text: 'test failed',truncated:false},
    'workspace.git.head': {headSha,clean:true,workspaceClean:true},
    'workspace.read_text': {path:'src/a.ts',content:'bad',sha256:fileSha},
    'workspace.apply_text_patch': {path:'src/a.ts',beforeSha256:fileSha,afterSha256:'d'.repeat(64),applied:true,changed:true},
    'workspace.run_allowed_command': {recipeId:'test',exitCode:0,stdout:'passed',stderr:''},
    'workspace.git.commit': {headSha:fixedSha,parentSha:headSha},
    'workspace.git.push': {headSha:fixedSha,pushed:true},
    'github.pr.create': {state:'confirmed',externalId:'19',url:'https://github.test/pull/19'},
    'github.pr.comment': {state:'confirmed'},
    'github.issue.get': {number:4,title:'Bug',body:'fails',state:'open',labels:['bug'],url:'https://github.test/issues/4',updatedAt:'2026-10-03T00:00:00Z'},
    'github.issue.comment': {state:'confirmed'},
  };
  let modelCalls = 0;
  const model = {deployment: {}, async complete(request) {modelCalls++; assert.equal(request.tools.length,0); return {response:{kind:'final',text:JSON.stringify({diagnosis:'Fix failing assertion',patches:[{path:'src/a.ts',expectedSha256:fileSha,edits:[{oldText:'bad',newText:'good'}]}]})},usage:{promptTokens:10,completionTokens:10,totalTokens:20}};}};
  const tools = {list:()=>names.map(name=>({name,version:'1.0.0'})), async invoke(input) {calls.push(input);return {state:'confirmed',result:structuredClone(responses[input.toolName]),evidenceRefs:[input.runId]};}};
  const options = {repository:'owner/repo',runId:'42',model,tools,gitTools,sourcePaths:['src/a.ts'],headBranch:'ci-fix',baseBranch:'main',verifyRecipeId:'test',maxSteps:32,maxTokens:4096,authorizationRefFor:()=> 'runtime-approved'};
  return {context,options,calls,responses,checkpoints,modelCalls:()=>modelCalls};
}

test('actual verify precedes commit, push, approved PR and original run backlink',async()=>{
  const f=fixture(); const r=await createCiFixWorkflow(f.options).run(f.context);
  assert.equal(r.status,'succeeded'); assert.ok(r.verificationRunId);
  const names=f.calls.map(c=>c.toolName);
  assert.ok(names.indexOf('workspace.run_allowed_command')<names.indexOf('workspace.git.commit'));
  assert.ok(names.indexOf('workspace.git.push')<names.indexOf('github.pr.create'));
  assert.match(f.calls.find(c=>c.toolName==='github.pr.create').arguments.body,/runs\/42/);
  assert.equal(f.calls.find(c=>c.toolName==='workspace.git.commit').arguments.verificationRunId,r.verificationRunId);
  const count=f.calls.length; await runCiFix(f.context,f.options); assert.equal(f.modelCalls(),1);
  assert.equal(f.calls.filter(c=>c.toolName==='workspace.git.commit').length,1); assert.equal(f.calls.length,count);
});
test('failed actual verification retries once then never commits',async()=>{
  const f=fixture(); f.responses['workspace.run_allowed_command'].exitCode=1;
  assert.equal((await runCiFix(f.context,f.options)).status,'verification_failed');
  assert.ok(!f.calls.some(c=>c.toolName==='workspace.git.commit'));
  assert.equal(f.modelCalls(),2);
  assert.equal(f.calls.filter(c=>c.toolName==='workspace.run_allowed_command').length,2);
});
test('maxAttempts 1 stops after a single failed verification',async()=>{
  const f=fixture(); f.responses['workspace.run_allowed_command'].exitCode=1; f.options.maxAttempts=1;
  assert.equal((await runCiFix(f.context,f.options)).status,'verification_failed');
  assert.equal(f.modelCalls(),1);
});
test('second bounded attempt can verify and commit the layered repair',async()=>{
  const f=fixture(), original=f.options.tools.invoke; let verifyCalls=0;
  f.options.tools.invoke=async input=>{
    if(input.toolName==='workspace.run_allowed_command'){verifyCalls++;
      return {state:'confirmed',result:{recipeId:'test',exitCode:verifyCalls===1?1:0,stdout:'',stderr:''},evidenceRefs:[input.runId]};}
    return original(input);};
  const r=await runCiFix(f.context,f.options);
  assert.equal(r.status,'succeeded'); assert.equal(f.modelCalls(),2);
  assert.match(r.verificationRunId,/verify-1$/);
  assert.equal(f.calls.find(c=>c.toolName==='workspace.git.commit').arguments.verificationRunId,r.verificationRunId);
});
test('missing capability is unsupported without effects',async()=>{
  const f=fixture(); delete f.options.model;
  assert.equal((await runCiFix(f.context,f.options)).status,'unsupported'); assert.equal(f.calls.length,0);
});
test('model supplied shell command is rejected',async()=>{
  const f=fixture(); f.options.model.complete=async()=>({response:{kind:'final',text:'{"diagnosis":"fix","patches":[],"shell":"rm -rf /"}'}});
  await assert.rejects(runCiFix(f.context,f.options),/Invalid CI/); assert.ok(!f.calls.some(c=>c.toolName==='workspace.apply_text_patch'));
});
test('unknown patch is persisted and never automatically retried',async()=>{
  const f=fixture(), original=f.options.tools.invoke;
  f.options.tools.invoke=async input=>input.toolName==='workspace.apply_text_patch'?(f.calls.push(input),{state:'unknown',evidenceRefs:[]}):original(input);
  assert.equal((await runCiFix(f.context,f.options)).status,'waiting_reconciliation');
  assert.equal((await runCiFix(f.context,f.options)).status,'waiting_reconciliation');
  assert.equal(f.calls.filter(c=>c.toolName==='workspace.apply_text_patch').length,1);
});
test('pending approval resumes stable run id without another model call',async()=>{
  const f=fixture(), original=f.options.tools.invoke; let pending=true;
  f.options.tools.invoke=async input=>input.toolName==='workspace.apply_text_patch'&&pending?(f.calls.push(input),{state:'pending',evidenceRefs:[]}):original(input);
  assert.equal((await runCiFix(f.context,f.options)).status,'waiting_approval'); pending=false;
  assert.equal((await runCiFix(f.context,f.options)).status,'succeeded');
  const patchCalls=f.calls.filter(c=>c.toolName==='workspace.apply_text_patch'); assert.equal(patchCalls[0].runId,patchCalls[1].runId); assert.equal(f.modelCalls(),1);
});
test('head drift after verification blocks commit',async()=>{
  const f=fixture(), original=f.options.tools.invoke; let reads=0;
  f.options.tools.invoke=async input=>{if(input.toolName==='workspace.git.head'&&++reads>1) return {state:'confirmed',result:{headSha:fixedSha,clean:false},evidenceRefs:[]};return original(input);};
  assert.equal((await runCiFix(f.context,f.options)).status,'stale'); assert.ok(!f.calls.some(c=>c.toolName==='workspace.git.commit'));
});
test('changed request cannot reuse persisted journal',async()=>{
  const f=fixture(); await runCiFix(f.context,f.options); f.options.runId='43';
  await assert.rejects(runCiFix(f.context,f.options),/Invalid CI/);
});
test('cancelled context never invokes a tool',async()=>{
  const f=fixture(), controller=new AbortController(); controller.abort(); f.context.signal=controller.signal;
  await assert.rejects(runCiFix(f.context,f.options),/cancelled/); assert.equal(f.calls.length,0);
});
test('step budget persists and blocks effects',async()=>{
  const f=fixture(); f.options.maxSteps=2;
  assert.equal((await runCiFix(f.context,f.options)).status,'unsupported');
  const count=f.calls.length; await runCiFix(f.context,f.options); assert.equal(f.calls.length,count);
});
test('issue-only repair uses re-read fingerprint without inventing a CI run',async()=>{
  const f=fixture(), issue=f.responses['github.issue.get']; delete f.options.runId;
  const fingerprint=createHash('sha256').update(JSON.stringify([issue.number,issue.title,issue.body,issue.state,[...issue.labels].sort(),issue.url,issue.updatedAt])).digest('hex');
  f.options.issue={number:4,url:issue.url,repository:'owner/repo',fingerprint}; f.options.expectedHeadSha=headSha;
  assert.equal((await runCiFix(f.context,f.options)).status,'succeeded');
  assert.ok(!f.calls.some(c=>c.toolName.startsWith('github.actions.')));
  assert.match(f.calls.find(c=>c.toolName==='github.issue.comment').arguments.body,/pull\/19/);
});
test('issue drift refuses any patch',async()=>{
  const f=fixture(); delete f.options.runId; f.options.expectedHeadSha=headSha;
  f.options.issue={number:4,url:'https://github.test/issues/4',repository:'owner/repo',fingerprint:'0'.repeat(64)};
  assert.equal((await runCiFix(f.context,f.options)).status,'stale');
  assert.ok(!f.calls.some(c=>c.toolName==='workspace.apply_text_patch'));
});
