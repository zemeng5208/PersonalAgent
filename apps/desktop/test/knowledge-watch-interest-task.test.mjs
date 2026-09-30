import assert from 'node:assert/strict';
import test from 'node:test';
import {createKnowledgeWatchHost} from '../electron/knowledge-watch-host.js';

const at = Date.parse('2026-09-30T00:00:00Z');
const iso = value => new Date(value).toISOString();
const request = () => ({deadline:iso(at+60000),signal:new AbortController().signal});

// Explicit port doubles; these verify intake/recovery, not native grants or real Laya.
function fixture({choose,saveReceipt=true} = {}) {
  const rows = new Map(); const tasks = new Map(); let choices = 0;
  const checkpoints = {loadCheckpoint(taskId,key) {return structuredClone(rows.get(`${taskId}:${key}`));},
    saveCheckpoint(taskId,key,value) {
      if (saveReceipt || !key.startsWith('knowledge-watch-interest-task:')) rows.set(`${taskId}:${key}`,structuredClone(value));
    }};
  const runtime = {...checkpoints,getTask(taskId) {return structuredClone(tasks.get(taskId));}};
  const grant = {state:'granted',id:'scope-a',revision:1,publicLowRiskTracking:true,expiresAt:iso(at+3600000)};
  let evidence = [{id:'question-task',topicId:'typescript',sourceId:'conversation',sourceRevision:'r1',
    occurredAt:iso(at-1000),interactionId:'question-task',kind:'question',match:'exact'}];
  let sourceRevision = 'source-v1';
  const readInterestSignal = async () => ({namespace:'fixture-user',topicId:'typescript',at:iso(at),
    evidenceMaxAgeMs:120000,watchDurationMs:3600000,evidence:structuredClone(evidence),scope:{...grant},
    source:{id:'feed-a',revision:sourceRevision,visibility:'public',risk:'low',transportVerified:true,
      verificationExpiresAt:iso(at+3600000)},
    sourceContent:{contentSha256:'a'.repeat(64),cacheVersion:sourceRevision,lastSuccessfulCheck:iso(at-1000),validUntil:iso(at+3600000)}});
  const options = {profile:'huawei_ict_agentarts',namespace:'fixture-user',checkpointTaskId:'root-task',
    checkpoints,runtime,now:()=>at,readInterestSignal,readTrackingGrant:async()=>({...grant}),
    interestDecider:{async choose() {choices+=1;if(choose)await choose();
      return {outcome:'selected',requiresHostRevalidation:true,selected:{id:'track_public',revision:1},
        receipt:{modelReceiptId:'fixture-model-receipt'}};}}};
  const host = createKnowledgeWatchHost(options); host.start();
  tasks.set('question-task',{taskId:'question-task',conversationId:'conversation-a',goal:'Ask TypeScript question',state:'succeeded'});
  tasks.set('followup-task',{taskId:'followup-task',conversationId:'conversation-a',goal:'Follow up TypeScript question',state:'created'});
  return {host,options,runtime,tasks,rows,get choices(){return choices;},
    sustained() {evidence.push({id:'followup-task',topicId:'typescript',sourceId:'conversation',sourceRevision:'r2',
      occurredAt:iso(at),interactionId:'followup-task',kind:'followup',match:'exact',relatedEvidenceId:'question-task'});},
    changeSource() {sourceRevision='source-v2';},restoreSource() {sourceRevision='source-v1';}};
}

test('Runtime interest intake keeps one question suggested and never replays completed intake after revoke/restart', async () => {
  const fx = fixture(); let restored;
  try {
    const once = await fx.host.consumeInterestTask('question-task',{...request(),
      userEnable:{id:'caller-forged-enable',topicId:'typescript',occurredAt:iso(at)}});
    assert.equal(once.watch.state,'suggested'); assert.equal(fx.choices,0);
    fx.sustained();
    const tracked = await fx.host.consumeInterestTask('followup-task',request());
    assert.equal(tracked.watch.state,'tracked'); assert.equal(fx.choices,1);
    restored = createKnowledgeWatchHost(fx.options); restored.start();
    const duplicate = await restored.consumeInterestTask('followup-task',request());
    assert.equal(duplicate.duplicate,true); assert.equal(duplicate.watch.state,'tracked'); assert.equal(fx.choices,1);
    await restored.revoke('typescript',{id:'native-revoke',occurredAt:iso(at)});
    const revoked = await restored.consumeInterestTask('followup-task',request());
    assert.equal(revoked.duplicate,true); assert.equal(revoked.watch.state,'revoked'); assert.equal(fx.choices,1);
    assert.equal((await restored.consumeInterestTask('foreign-task',request())).reason,'interest_task_unavailable');
  } finally {fx.host.dispose();restored?.dispose();}
});

test('Runtime interest source changes during judgment leave unknown intake and prevent a blind retry', async () => {
  let started; let release;
  const ready = new Promise(resolve=>{started=resolve;}); const waiting = new Promise(resolve=>{release=resolve;});
  const fx = fixture({choose:async()=>{started();await waiting;}}); let restored;
  try {
    fx.sustained();
    const pending = fx.host.consumeInterestTask('followup-task',request()); await ready;
    assert.equal((await fx.host.consumeInterestTask('followup-task',request())).reason,'interest_task_in_progress');
    fx.changeSource(); release();
    assert.equal((await pending).reason,'interest_context_invalidated');
    assert.equal(fx.host.snapshot().watches.length,0);
    // Return the exact original input; its unconfirmed consumption remains unknown after restart.
    fx.restoreSource();
    restored = createKnowledgeWatchHost(fx.options); restored.start();
    assert.equal((await restored.consumeInterestTask('followup-task',request())).reason,'interest_consumption_unknown');
    assert.equal(fx.choices,1); assert.equal(restored.snapshot().watches.length,0);
  } finally {fx.host.dispose();restored?.dispose();}
});

test('Runtime interest intake requires real reader ports and persisted preparation before choosing', async () => {
  const fx = fixture({saveReceipt:false});
  const missing = createKnowledgeWatchHost({...fx.options,readTrackingGrant:null}); missing.start();
  try {
    fx.sustained();
    assert.equal((await missing.consumeInterestTask('followup-task',request())).reason,'interest_task_provider_missing');
    assert.equal((await fx.host.consumeInterestTask('followup-task',request())).reason,'interest_receipt_unavailable');
    assert.equal(fx.choices,0); assert.equal(fx.host.snapshot().watches.length,0);
  } finally {fx.host.dispose();missing.dispose();}
});
