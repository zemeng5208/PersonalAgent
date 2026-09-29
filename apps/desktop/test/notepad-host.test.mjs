import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Client} from '@personal-agent/client';
import {createRuntimeApplication, createWindowsHostNotepadAdapter, createRuntimeWindowsHostAttemptStore} from '@personal-agent/runtime/application';
import {createDesktopNotepadHost} from '../electron/notepad-host.js';

async function until(predicate) {
  for(let n=0;n<200;n++) {if(await predicate()) return; await new Promise(resolve=>setTimeout(resolve,5));}
  throw Error('Expected local state did not arrive');
}

async function fixture(t) {
  const directory=await mkdtemp(path.join(tmpdir(),'pa-notepad-desktop-'));
  const sent=[];let confirm,app,client;
  const host=createDesktopNotepadHost({createAdapter:createWindowsHostNotepadAdapter,
    createAttempts:createRuntimeWindowsHostAttemptStore,
    transport:{async openVerifiedConnection(){return {
      async send(frame){sent.push(frame);},async close(){},
      async exchange(frame){sent.push(frame);
        const base={protocolVersion:frame.protocolVersion,requestId:frame.requestId,sessionId:frame.sessionId};
        if(frame.kind==='hello') return {...base,kind:'hello_ack',clientNonce:frame.clientNonce,
          hostNonce:'b'.repeat(32),sessionId:'fixture-session'};
        if(frame.kind==='observe') return {...base,kind:'observed',targetRef:'notepad_fixture_target_123',
          expiresAt:new Date(Date.now()+30_000).toISOString(),source:'windows-uia'};
        if(frame.kind==='execute') return {...base,kind:'result',taskId:frame.taskId,runId:frame.runId,
          toolName:frame.toolName,toolVersion:frame.toolVersion,argumentsDigest:frame.argumentsDigest,
          targetRef:frame.targetRef,state:'verified',evidenceRef:'fixture-host-evidence',
          startedAt:new Date().toISOString(),finishedAt:new Date().toISOString()};
        throw Error('Unexpected fixture frame');
      }};}},
    registerConfirmation:callback=>{confirm=callback;return ()=>{confirm=undefined;};},
    openNotepad:async()=>{},respond:payload=>client.call('authorization.respond',payload),
    cancelTask:taskId=>client.call('task.cancel',{taskId,reason:'fixture user cancellation'}),
  });
  app=createRuntimeApplication({path:path.join(directory,'runtime.sqlite'),
    profile:'huawei_ict_agentarts',hostUserNamespace:'fixture-user',tools:host.tools});
  host.bind(app);client=new Client(app,Date.now);await client.connect();
  t.after(async()=>{await host.close();await until(()=>app.activeTaskCount===0);app.close();await rm(directory,{recursive:true,force:true});});
  return {host,app,sent,confirm:()=>confirm?.()};
}

test('Desktop confirmation freezes user text and obtains one Runtime grant before native write',async t=>{
  const {host,app,sent,confirm}=await fixture(t);
  const first=host.start({text:'User authored text'});
  await until(()=>host.snapshot().state==='waiting_confirmation');
  assert.equal(sent.some(frame=>frame.kind==='observe'||frame.kind==='execute'),false);
  assert.equal(app.runtime.getTask(first.taskId).state,'created');
  confirm();
  await until(async()=>{await host.refresh();return !host.snapshot().busy;});
  assert.equal(host.snapshot().state,'succeeded');
  const writes=sent.filter(frame=>frame.kind==='execute');assert.equal(writes.length,1);
  assert.equal(writes[0].expectedText,'');assert.equal(writes[0].replacementText,'User authored text');
  assert.equal(typeof writes[0].authorizationRef,'string');
  assert.ok(host.snapshot().evidenceRefs.length>0);
  assert.equal(JSON.stringify(host.snapshot()).includes('User authored text'),false);
  assert.equal(app.runtime.policy.get(writes[0].authorizationRef).usesRemaining,0);
});

test('cancel before local gesture leaves no frozen write or native execution',async t=>{
  const {host,app,sent,confirm}=await fixture(t);
  const first=host.start({text:'Never write this'});
  await until(()=>host.snapshot().state==='waiting_confirmation');
  await host.cancel();confirm();
  assert.equal(app.runtime.getTask(first.taskId).state,'cancelled');
  assert.equal(host.snapshot().busy,false);
  assert.equal(sent.some(frame=>frame.kind==='observe'||frame.kind==='execute'),false);
  assert.equal(app.runtime.readToolExecutions(first.taskId).length,0);
});
