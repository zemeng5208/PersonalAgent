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

async function fixture(t, {targetReady = true} = {}) {
  const directory=await mkdtemp(path.join(tmpdir(),'pa-notepad-desktop-'));
  const sent=[], conversation=[];let confirm,app,client;
  let observedExpiresAt;
  const host=createDesktopNotepadHost({createAdapter:createWindowsHostNotepadAdapter,
    createAttempts:createRuntimeWindowsHostAttemptStore,
    transport:{async openVerifiedConnection(){return {
      async send(frame){sent.push(frame);},async close(){},
      async exchange(frame){sent.push(frame);
        const base={protocolVersion:frame.protocolVersion,requestId:frame.requestId,sessionId:frame.sessionId};
        if(frame.kind==='hello') return {...base,kind:'hello_ack',clientNonce:frame.clientNonce,
          hostNonce:'b'.repeat(32),sessionId:'fixture-session'};
        if(frame.kind==='observe') {
          observedExpiresAt=new Date(Date.now()+30_000).toISOString();
          return {...base,kind:'observed',targetRef:'notepad_fixture_target_123',
            expiresAt:observedExpiresAt,source:'windows-uia'};
        }
        if(frame.kind==='target_ready') return targetReady
          ? {...base,kind:'target_ready_result',targetRef:frame.targetRef,ready:true,expiresAt:observedExpiresAt}
          : {...base,kind:'target_ready_result',targetRef:frame.targetRef,ready:false,errorCode:'TARGET_STALE'};
        if(frame.kind==='execute') return {...base,kind:'result',taskId:frame.taskId,runId:frame.runId,
          toolName:frame.toolName,toolVersion:frame.toolVersion,argumentsDigest:frame.argumentsDigest,
          targetRef:frame.targetRef,state:'verified',evidenceRef:'fixture-host-evidence',
          startedAt:new Date().toISOString(),finishedAt:new Date().toISOString()};
        throw Error('Unexpected fixture frame');
      }};}},
    registerConfirmation:callback=>{confirm=callback;return ()=>{confirm=undefined;};},
    openNotepad:async()=>{},respond:payload=>client.call('authorization.respond',payload),
    cancelTask:taskId=>client.call('task.cancel',{taskId,reason:'fixture user cancellation'}),
    onTask:task=>conversation.push(task),
  });
  app=createRuntimeApplication({path:path.join(directory,'runtime.sqlite'),
    profile:'huawei_ict_agentarts',hostUserNamespace:'fixture-user',tools:host.tools});
  host.bind(app);client=new Client(app,Date.now);await client.connect();
  t.after(async()=>{await host.close();await until(()=>app.activeTaskCount===0);app.close();await rm(directory,{recursive:true,force:true});});
  return {host,app,sent,conversation,confirm:()=>confirm?.()};
}

test('Desktop confirmation freezes user text and obtains one Runtime grant before native write',async t=>{
  const {host,app,sent,conversation,confirm}=await fixture(t);
  const first=host.start({text:'User authored text'});
  await until(()=>host.snapshot().state==='waiting_confirmation');
  assert.equal(sent.some(frame=>frame.kind==='observe'||frame.kind==='execute'),false);
  assert.equal(app.runtime.getTask(first.taskId).state,'created');
  assert.deepEqual(conversation,[{taskId:first.taskId,goal:'向新空白记事本写入本次文本'}]);
  confirm();
  await until(async()=>{await host.refresh();return !host.snapshot().busy;});
  assert.equal(host.snapshot().state,'succeeded');
  const writes=sent.filter(frame=>frame.kind==='execute');assert.equal(writes.length,1);
  assert.deepEqual(sent.filter(frame=>frame.kind==='target_ready').map(frame=>frame.targetRef),
    ['notepad_fixture_target_123']);
  assert.ok(sent.findIndex(frame=>frame.kind==='target_ready')<sent.findIndex(frame=>frame.kind==='execute'));
  assert.equal(writes[0].expectedText,'');assert.equal(writes[0].replacementText,'User authored text');
  assert.equal(typeof writes[0].authorizationRef,'string');
  assert.ok(host.snapshot().evidenceRefs.length>0);
  const projection=host.projectTask(app.runtime.getTask(first.taskId));
  assert.match(projection.resultSummary,/读回匹配/);
  assert.equal(JSON.stringify(projection).includes('notepad_fixture_target'),false);
  assert.equal(JSON.stringify(projection).includes('User authored text'),false);
  assert.equal(JSON.stringify(host.snapshot()).includes('User authored text'),false);
  assert.equal(app.runtime.policy.get(writes[0].authorizationRef).usesRemaining,0);
});

test('Desktop denies once when the Host target is stale at the approval boundary',async t=>{
  const {host,app,sent,confirm}=await fixture(t,{targetReady:false});
  host.start({text:'Must not write'});
  await until(()=>host.snapshot().state==='waiting_confirmation');
  confirm();
  await until(async()=>{await host.refresh();return !host.snapshot().busy;});
  assert.notEqual(host.snapshot().state,'succeeded');
  assert.equal(sent.filter(frame=>frame.kind==='target_ready').length,1);
  assert.equal(sent.filter(frame=>frame.kind==='execute').length,0);
  const projection=host.projectTask(app.runtime.getTask(host.snapshot().taskId));
  assert.match(projection.resultSummary,/取消.*未获确认/);
  assert.doesNotMatch(projection.resultSummary,/已完成|读回匹配/);
});

test('cancel before local gesture leaves no frozen write or native execution',async t=>{
  const {host,app,sent,confirm}=await fixture(t);
  const first=host.start({text:'Never write this'});
  await until(()=>host.snapshot().state==='waiting_confirmation');
  await host.cancel();confirm();
  assert.equal(app.runtime.getTask(first.taskId).state,'cancelled');
  assert.match(host.projectTask(app.runtime.getTask(first.taskId)).resultSummary,/取消.*未确认写入/);
  assert.equal(host.snapshot().busy,false);
  assert.equal(sent.some(frame=>frame.kind==='observe'||frame.kind==='execute'),false);
  assert.equal(app.runtime.readToolExecutions(first.taskId).length,0);
});

test('Desktop original Notepad recovery reports terminal readback separately from unresolved results',async t=>{
  const cases=[
    {name:'confirmed',state:'succeeded',recovery:'confirmed',confirmed:{result:{state:'verified'},evidenceRefs:['synthetic-evidence']},
      expected:/原始执行已核实，原生读回/},
    {name:'not applied failed',state:'failed',recovery:'not_applied',expected:/已核实.*未写入.*失败/},
    {name:'not applied cancelled',state:'cancelled',recovery:'not_applied',expected:/已核实.*未写入.*取消/},
    {name:'failed without verified outcome',state:'failed',recovery:'waiting',expected:/任务已失败.*写入结果未获确认/},
    {name:'cancelled without verified outcome',state:'cancelled',recovery:'waiting',expected:/任务已取消.*写入结果未获确认/},
    {name:'already failed without native readback',state:'failed',recovery:'not_applied',reason:'already_terminal',
      expected:/任务已失败.*写入结果未获确认/},
    {name:'already cancelled without native readback',state:'cancelled',recovery:'not_applied',reason:'already_terminal',
      expected:/任务已取消.*写入结果未获确认/},
    {name:'terminal without matching evidence',state:'succeeded',recovery:'confirmed',expected:/任务已结束.*写入结果未获确认/},
    {name:'still unknown',state:'waiting_reconciliation',recovery:'waiting',expected:/仍未获确认.*保留待核实/},
    {name:'not applied claim without terminal readback',state:'waiting_reconciliation',recovery:'not_applied',
      expected:/仍未获确认.*保留待核实/},
    {name:'confirmed claim without terminal readback',state:'waiting_reconciliation',recovery:'confirmed',
      confirmed:{result:{state:'verified'},evidenceRefs:['synthetic-evidence']},expected:/仍未获确认.*保留待核实/},
  ];
  for(const scenario of cases) {
    await t.test(scenario.name,async t=>{
      const taskId='synthetic-original-task';let state='waiting_reconciliation',recoveries=0,writes=0,approvals=0;
      const host=createDesktopNotepadHost({
        createAdapter:()=>({tool:{execute:async()=>{writes++;}},close:async()=>{}}),createAttempts:()=>({}),
        respond:async()=>{approvals++;},reconcileTask:async id=>{
          assert.equal(id,taskId);recoveries++;state=scenario.state;
          return {state:scenario.recovery,reason:scenario.reason??'host_result'};
        },
      });
      t.after(()=>host.close());
      host.bind({runtime:{listTasks:()=>({items:state==='waiting_reconciliation'?[{taskId,state}]:[]})},
        readHostToolTask:id=>{
          assert.equal(id,taskId);
          return {toolName:'computer.notepad.replace_text',toolVersion:'1.0.0',task:{taskId,state},
            ...(state===scenario.state && scenario.confirmed?{confirmed:scenario.confirmed}:{})};
        }});
      assert.equal(host.snapshot().pendingTasks.length,1);
      const readback=await host.recover({taskId});
      assert.equal(readback.state,scenario.state);
      assert.match(readback.reason,scenario.expected);
      const waiting=scenario.state==='waiting_reconciliation';
      assert.equal(readback.pendingTasks.length,waiting?1:0);
      if(!waiting) assert.doesNotMatch(readback.reason,/保留待核实/);
      if(scenario.name!=='confirmed') {
        assert.doesNotMatch(readback.reason,/写入已完成|原生读回及执行证据已保存/);
        assert.deepEqual(readback.evidenceRefs,[]);
      }
      assert.equal(recoveries,1);assert.equal(writes,0);assert.equal(approvals,0);
      assert.equal(readback.busy,false);assert.equal(readback.recovering,false);
    });
  }
});
