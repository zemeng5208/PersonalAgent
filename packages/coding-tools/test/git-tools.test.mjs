import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, mkdirSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGitTools, registerGitTools, readGitWorkspaceFingerprint} from '../dist/dev-workflows/git-tools.js';

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

function repositoryFixture() {
  const f=fixture();
  const git=args=>execFileSync('git',args,{cwd:f.options.rootPath,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git(['init','-b',f.options.sourceBranch]);
  mkdirSync(join(f.options.rootPath,'src'));
  writeFileSync(join(f.options.rootPath,'src/main.ts'),'export const value = 1;\n');
  git(['add','src/main.ts']);
  git(['-c','user.name=Fixture','-c','user.email=fixture@example.com','-c','core.hooksPath=/dev/null','commit','-m','initial fixture']);
  git(['remote','add',f.options.remoteName,f.options.remoteUrl]);
  return {...f,git,headSha:git(['rev-parse','HEAD'])};
}
async function settles(promise) {
  let timer;
  try {return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('host wait did not settle')),300);})]);}
  finally {clearTimeout(timer);}
}
for(const phase of ['verification','credentials']) {
  for(const reason of ['cancel','deadline','long deadline']) {
    test(`Git ${phase} host wait settles on ${reason} before any write`,async t=>{
      const f=repositoryFixture();
      try {
        const controller=new AbortController(); let clock=Date.now();
        const delay=reason==='long deadline'?2_147_483_647+1000:60000;
        const deadline=new Date(clock+delay).toISOString();
        let calls=0,entered,resolvePort,boundedContext;
        const ready=new Promise(resolve=>{entered=resolve;});
        const pending=bounded=>{calls++;boundedContext=bounded;entered();return new Promise(resolve=>{resolvePort=resolve;});};
        const tools=createGitTools({...f.options,now:()=>clock,
          ...(phase==='verification'?{readVerification:pending}:{getCredentials:pending})});
        const context={taskId:'task',runId:phase,authorizationRef:'auth',scopes:[phase==='verification'?'workspace:git:commit':'workspace:git:push'],signal:controller.signal,deadline};
        if(reason!=='cancel') t.mock.timers.enable({apis:['setTimeout']});
        const input=phase==='verification'?{repository:f.options.repository,expectedHeadSha:f.headSha,paths:['src/main.ts'],message:'fix',verificationRunId:'verify'}:{repository:f.options.repository,expectedHeadSha:f.headSha};
        const operation=(phase==='verification'?tools.commit:tools.push).execute(input,context);
        await ready;
        if(reason==='cancel') controller.abort();
        else {
          if(reason==='long deadline') {
            clock+=2_147_483_647;t.mock.timers.tick(2_147_483_647);
            assert.equal(boundedContext.signal.aborted,false);
          }
          clock=Date.parse(deadline);t.mock.timers.tick(reason==='long deadline'?1000:delay);t.mock.timers.reset();
        }
        await assert.rejects(settles(operation),error=>error.code===(reason==='cancel'?'CANCELLED':'TIMEOUT'));
        assert.equal(boundedContext.signal.aborted,true);
        assert.equal(boundedContext.taskId,context.taskId);
        assert.equal(boundedContext.authorizationRef,context.authorizationRef);
        assert.equal(boundedContext.deadline,context.deadline);
        resolvePort(phase==='credentials'?{token:'fake-fixture-token'}:undefined);
        await Promise.resolve();await Promise.resolve();
        assert.equal(calls,1);
        assert.equal(f.git(['rev-parse','HEAD']),f.headSha);
        assert.equal(f.git(['status','--porcelain']),'');
        // The interrupted callback no longer holds the repository's serial slot.
        const read=await tools.head.execute({repository:f.options.repository},{...context,scopes:['workspace:git:read'],signal:new AbortController().signal,deadline:new Date(clock+60000).toISOString()});
        assert.equal(read.headSha,f.headSha);
      } finally {f.dispose();}
    });
  }
  test(`Git ${phase} preserves an ordinary host read error`,async()=>{
    const f=repositoryFixture();
    try {
      const expected=new Error('explicit host failure');
      const reject=async()=>{throw expected;};
      const tools=createGitTools({...f.options,...(phase==='verification'?{readVerification:reject}:{getCredentials:reject})});
      const context={taskId:'task',runId:phase,authorizationRef:'auth',scopes:[phase==='verification'?'workspace:git:commit':'workspace:git:push'],signal:new AbortController().signal,deadline:new Date(Date.now()+60000).toISOString()};
      const input=phase==='verification'?{repository:f.options.repository,expectedHeadSha:f.headSha,paths:['src/main.ts'],message:'fix',verificationRunId:'verify'}:{repository:f.options.repository,expectedHeadSha:f.headSha};
      await assert.rejects((phase==='verification'?tools.commit:tools.push).execute(input,context),error=>error===expected);
      assert.equal(f.git(['rev-parse','HEAD']),f.headSha);
      assert.equal(f.git(['status','--porcelain']),'');
    } finally {f.dispose();}
  });
}
for(const reason of ['cancel','deadline']) {
  test(`Git verification rejects a synchronous result after ${reason}`,async()=>{
    const f=repositoryFixture();
    try {
      const controller=new AbortController();let clock=Date.now();
      const deadline=new Date(clock+60000).toISOString();
      const tools=createGitTools({...f.options,now:()=>clock,readVerification:async()=>{
        if(reason==='cancel') controller.abort();else clock=Date.parse(deadline);
        return undefined;
      }});
      const context={taskId:'task',runId:'commit',authorizationRef:'auth',scopes:['workspace:git:commit'],signal:controller.signal,deadline};
      await assert.rejects(tools.commit.execute({repository:f.options.repository,expectedHeadSha:f.headSha,paths:['src/main.ts'],message:'fix',verificationRunId:'verify'},context),error=>error.code===(reason==='cancel'?'CANCELLED':'TIMEOUT'));
      assert.equal(f.git(['rev-parse','HEAD']),f.headSha);
      assert.equal(f.git(['status','--porcelain']),'');
    } finally {f.dispose();}
  });
}
test('Git bounded host read retains trusted verification and normal local commit',async()=>{
  const f=repositoryFixture();
  try {
    writeFileSync(join(f.options.rootPath,'src/main.ts'),'export const value = 2;\n');
    const {files}=await readGitWorkspaceFingerprint(f.options.rootPath,f.options.allowedPaths);
    const tools=createGitTools({...f.options,readVerification:async(context,runId)=>({taskId:context.taskId,runId,toolName:'workspace.run_allowed_command',status:'confirmed',exitCode:0,headSha:f.headSha,files})});
    const context={taskId:'task',runId:'commit',authorizationRef:'auth',scopes:['workspace:git:commit'],signal:new AbortController().signal,deadline:new Date(Date.now()+60000).toISOString()};
    const result=await tools.commit.execute({repository:f.options.repository,expectedHeadSha:f.headSha,paths:['src/main.ts'],message:'verified fixture change',verificationRunId:'verify'},context);
    assert.equal(result.parentSha,f.headSha);
    assert.equal(f.git(['rev-parse','HEAD']),result.headSha);
    assert.equal(f.git(['show','HEAD:src/main.ts']),'export const value = 2;');
    assert.equal(f.git(['status','--porcelain']),'');
  } finally {f.dispose();}
});
