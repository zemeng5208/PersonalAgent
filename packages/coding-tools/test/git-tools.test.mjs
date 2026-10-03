import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGitTools, registerGitTools} from '../dist/dev-workflows/git-tools.js';

function fixture() {
  const rootPath=mkdtempSync(join(tmpdir(),'git-tools-contract-'));
  const options={rootPath,repository:'owner/repo',sourceBranch:'agent/fix',remoteName:'origin',remoteUrl:'https://example.com/owner/repo.git',allowedPaths:['src/main.ts'],authorName:'Agent',authorEmail:'agent@example.com',readVerification:async()=>undefined};
  return {options,dispose:()=>rmSync(rootPath,{recursive:true,force:true})};
}
test('Git writes require presence, distinct scopes and no automatic recovery',()=>{
  const f=fixture(); try {
    const tools=createGitTools(f.options);
    assert.equal(tools.head.descriptor.name,'workspace.git.head');
    assert.equal(tools.head.descriptor.requiresPresence,false);
    for(const tool of [tools.commit,tools.push]) {
      assert.equal(tool.descriptor.requiresPresence,true);
      assert.equal(tool.descriptor.idempotencySupport,false);
      assert.equal(tool.descriptor.recoverySupport,false);
    }
    assert.equal(tools.push.descriptor.sideEffect,'external_write');
    assert.equal(tools.commit.descriptor.inputSchema.additionalProperties,false);
  } finally {f.dispose();}
});
test('Host binding rejects traversal, credentials and branch injection',()=>{
  const f=fixture(); try {
    for(const override of [{allowedPaths:['../secret']},{remoteUrl:'https://user:secret@example.com/repo'},{sourceBranch:'../main'},{remoteName:'--all'}]) {
      assert.throws(()=>createGitTools({...f.options,...override}));
    }
  } finally {f.dispose();}
});
test('Model cannot submit verification evidence or select another repository',async()=>{
  const f=fixture(); try {
    const tools=createGitTools(f.options);
    const c={taskId:'task',runId:'commit',authorizationRef:'auth',scopes:['workspace:git:commit'],signal:new AbortController().signal,deadline:new Date(Date.now()+10000).toISOString()};
    await assert.rejects(tools.commit.execute({repository:'owner/repo',expectedHeadSha:'a'.repeat(40),paths:['src/main.ts'],message:'fix',verificationRunId:'verify',receipt:{exitCode:0}},c));
    await assert.rejects(tools.head.execute({repository:'other/repo'},c));
  } finally {f.dispose();}
});
test('Partial registration rolls back previously acquired registrations',()=>{
  const f=fixture(); try {
    let registered=0; let disposed=0;
    const host={register(){registered++; if(registered===3) throw new Error('registration rejected'); return ()=>{disposed++;};}};
    assert.throws(()=>registerGitTools(host,f.options),/registration rejected/u);
    assert.equal(registered,3);
    assert.equal(disposed,2);
  } finally {f.dispose();}
});
