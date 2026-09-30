import assert from 'node:assert/strict';
import test from 'node:test';
import {createKnowledgeWatchHost} from '../electron/knowledge-watch-host.js';

const at = Date.parse('2026-09-30T00:00:00Z');
const iso = value => new Date(value).toISOString();
const request = () => ({deadline:iso(at+60000),signal:new AbortController().signal});

// Explicit port doubles; these verify intake/recovery, not native grants or real Laya.
function fixture({choose,saveReceipt=true} = {}) {
  const rows = new Map(); const tasks = new Map(); let choices = 0; let feedReads = 0;
  const grantReads = []; const grants = new Map();
  const checkpoints = {loadCheckpoint(taskId,key) {return structuredClone(rows.get(`${taskId}:${key}`));},
    saveCheckpoint(taskId,key,value) {
      if (saveReceipt || !key.startsWith('knowledge-watch-interest-task:')) rows.set(`${taskId}:${key}`,structuredClone(value));
    }};
  const runtime = {...checkpoints,getTask(taskId) {return structuredClone(tasks.get(taskId));}};
  const grant = {state:'granted',id:'scope-a',revision:1,publicLowRiskTracking:true,expiresAt:iso(at+3600000)};
  for (const taskId of ['question-task','followup-task']) grants.set(taskId,{...grant});
  const readGrant = input => {
    grantReads.push(structuredClone(input));
    assert.deepEqual(Object.keys(input).sort(), ['namespace','sourceId','taskId']);
    if (input.namespace !== 'fixture-user' || input.sourceId !== 'feed-a' || !tasks.has(input.taskId)) return null;
    return structuredClone(grants.get(input.taskId) ?? null);
  };
  let evidence = [{id:'question-task',topicId:'typescript',sourceId:'conversation',sourceRevision:'r1',
    occurredAt:iso(at-1000),interactionId:'question-task',kind:'question',match:'exact'}];
  let sourceRevision = 'source-v1';
  const readInterestSignal = async () => ({namespace:'fixture-user',topicId:'typescript',at:iso(at),
    evidenceMaxAgeMs:120000,watchDurationMs:3600000,evidence:structuredClone(evidence),scope:{...grant},
    source:{id:'feed-a',revision:sourceRevision,visibility:'public',risk:'low',transportVerified:true,
      verificationExpiresAt:iso(at+3600000)},
    sourceContent:{contentSha256:'a'.repeat(64),cacheVersion:sourceRevision,lastSuccessfulCheck:iso(at-1000),validUntil:iso(at+3600000)}});
  const options = {profile:'huawei_ict_agentarts',namespace:'fixture-user',checkpointTaskId:'root-task',
    checkpoints,runtime,now:()=>at,readInterestSignal,readTrackingGrant:async input=>readGrant(input),
    readTrackingGrantSnapshot:readGrant,feedCollect:async()=>{feedReads+=1;return {};},
    interestDecider:{async choose() {choices+=1;if(choose)await choose();
      return {outcome:'selected',requiresHostRevalidation:true,selected:{id:'track_public',revision:1},
        receipt:{modelReceiptId:'fixture-model-receipt'}};}}};
  const host = createKnowledgeWatchHost(options); host.start();
  tasks.set('question-task',{taskId:'question-task',conversationId:'conversation-a',goal:'Ask TypeScript question',state:'succeeded'});
  tasks.set('followup-task',{taskId:'followup-task',conversationId:'conversation-a',goal:'Follow up TypeScript question',state:'created'});
  return {host,options,runtime,tasks,rows,grants,grantReads,get choices(){return choices;},get feedReads(){return feedReads;},
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
    assert.equal(tracked.watch.consumer.intakeTaskId,'followup-task');
    restored = createKnowledgeWatchHost(fx.options); restored.start();
    const duplicate = await restored.consumeInterestTask('followup-task',request());
    assert.equal(duplicate.duplicate,true); assert.equal(duplicate.watch.state,'tracked'); assert.equal(fx.choices,1);
    assert.equal(duplicate.watch.consumer.intakeTaskId,'followup-task');
    await restored.revoke('typescript',{id:'native-revoke',occurredAt:iso(at)});
    const revoked = await restored.consumeInterestTask('followup-task',request());
    assert.equal(revoked.duplicate,true); assert.equal(revoked.watch.state,'revoked'); assert.equal(fx.choices,1);
    assert.equal((await restored.consumeInterestTask('foreign-task',request())).reason,'interest_task_unavailable');
  } finally {fx.host.dispose();restored?.dispose();}
});

test('source reads and restart retain the exact original intake tuple and refuse borrowed, revoked or changed leases', async () => {
  const fx = fixture(); let restored;
  try {
    fx.sustained();
    await fx.host.consumeInterestTask('followup-task',request());
    fx.host.dispose();
    restored = createKnowledgeWatchHost(fx.options); restored.start();
    fx.grantReads.length = 0;
    assert.equal((await restored.refreshSubscribedFeed({subscriptionId:'feed-a',...request()})).reason,'invalid_feed_result');
    assert.equal(fx.feedReads,1);
    assert.ok(fx.grantReads.length > 0);
    assert.ok(fx.grantReads.every(input => input.taskId === 'followup-task' && input.sourceId === 'feed-a'));
    assert.equal((await restored.refreshSubscribedFeed({subscriptionId:'foreign-source',...request(),taskId:'followup-task'})).accepted,false);
    assert.equal(fx.feedReads,1);
    for (const change of [{state:'revoked'}, {revision:2}, {expiresAt:iso(at)}, {id:'another-scope'}]) {
      const previous = {...fx.grants.get('followup-task')};
      fx.grants.set('followup-task',{...previous,...change});
      const refused = await restored.refreshSubscribedFeed({subscriptionId:'feed-a',...request(),taskId:'question-task'});
      assert.equal(refused.accepted,false);
      assert.equal(fx.feedReads,1);
      fx.grants.set('followup-task',previous);
    }
    // Removing the persisted binding cannot be repaired by a caller-supplied task ID.
    restored.dispose();
    for (const value of fx.rows.values()) if (value.watches?.typescript) delete value.watches.typescript.consumer.intakeTaskId;
    restored = createKnowledgeWatchHost(fx.options); restored.start();
    assert.equal((await restored.refreshSubscribedFeed({subscriptionId:'feed-a',...request(),taskId:'followup-task'})).accepted,false);
    assert.equal(fx.feedReads,1);
    const raw = await fx.options.readInterestSignal();
    assert.equal((await restored.consumeInterestSignal({...raw,intakeTaskId:'followup-task'},
      {...request(),intakeTaskId:'followup-task'})).reason,'grant_unreadable');
    assert.equal(fx.choices,1);
  } finally {fx.host.dispose();restored?.dispose();}
});

test('a native lease revoked during the queued final grant read leaves the intake unknown across restart', async () => {
  const fx = fixture(); fx.sustained(); fx.host.dispose();
  let calls = 0; let entered; let release;
  const ready = new Promise(resolve=>{entered=resolve;}); const waiting = new Promise(resolve=>{release=resolve;});
  const options = {...fx.options,readTrackingGrant:async input=>{
    const grant = await fx.options.readTrackingGrant(input);
    calls+=1;
    if (calls === 3) {entered();await waiting;}
    return grant;
  }};
  const host = createKnowledgeWatchHost(options); host.start(); let restored;
  try {
    const pending = host.consumeInterestTask('followup-task',request()); await ready;
    fx.grants.get('followup-task').state='revoked'; release();
    assert.equal((await pending).reason,'grant_changed');
    assert.deepEqual(host.snapshot().watches,[]);
    fx.grants.get('followup-task').state='granted';
    host.dispose(); restored=createKnowledgeWatchHost(options); restored.start();
    assert.equal((await restored.consumeInterestTask('followup-task',request())).reason,'interest_consumption_unknown');
    assert.equal(fx.choices,1);
  } finally {host.dispose();restored?.dispose();}
});

test('due tasks read the persisted intake grant after restart and never substitute the fired task', async () => {
  const fx = fixture(); fx.sustained(); fx.host.dispose();
  const schedules = new Map();
  const scheduler = {
    createSchedule(input){schedules.set(input.scheduleId,{...structuredClone(input),status:'pending'});
      return structuredClone(schedules.get(input.scheduleId));},
    listSchedules(){return structuredClone([...schedules.values()]);},
    reconcileSchedules(){return this.listSchedules();},
  };
  const runtime = {...fx.runtime,findTaskByIdempotencyKey:key=>structuredClone(
    [...fx.tasks.values()].find(task=>task.idempotencyKey === key))};
  const options = {...fx.options,runtime,scheduler};
  const host = createKnowledgeWatchHost(options); host.start(); let restored;
  try {
    await host.consumeInterestTask('followup-task',request());
    const registered = host.registerFeedCheck({checkId:'native-check',runAt:iso(at),subscriptionId:'feed-a',topicIds:['typescript']});
    assert.equal(registered.accepted,true);
    const schedule = schedules.get(registered.schedule.scheduleId);
    schedule.status='fired'; schedule.taskId='due-task';
    fx.tasks.set('due-task',{taskId:'due-task',goal:schedule.goal,conversationId:schedule.conversationId,
      idempotencyKey:schedule.taskIdempotencyKey,state:'running'});
    host.dispose();restored=createKnowledgeWatchHost(options);restored.start();
    assert.equal(restored.getFeedCheckContext('due-task').consumers[0].consumer.intakeTaskId,'followup-task');
    fx.grantReads.length=0;
    assert.equal((await restored.consumeFeedCheck('due-task',{signal:new AbortController().signal})).reason,'invalid_feed_result');
    assert.equal(fx.feedReads,1);
    assert.ok(fx.grantReads.length > 0);
    assert.ok(fx.grantReads.every(input=>input.taskId === 'followup-task'));
    fx.grants.get('followup-task').state='revoked';
    assert.equal(restored.getFeedCheckContext('due-task'),null);
    assert.equal((await restored.consumeFeedCheck('due-task',{signal:new AbortController().signal})).reason,'feed_check_binding_invalid');
    assert.equal(fx.feedReads,1);
    await restored.pause('typescript');
    assert.equal((await restored.resume('typescript')).state,'paused');
  } finally {host.dispose();restored?.dispose();}
});

test('replacing the original intake increments consumer revision and invalidates prior due bindings', async () => {
  const fx = fixture(); fx.sustained(); fx.host.dispose();
  const schedules = new Map();
  const scheduler={createSchedule(input){schedules.set(input.scheduleId,{...structuredClone(input),status:'pending'});
    return structuredClone(schedules.get(input.scheduleId));},listSchedules(){return structuredClone([...schedules.values()]);},
    reconcileSchedules(){return this.listSchedules();}};
  const runtime={...fx.runtime,findTaskByIdempotencyKey:key=>structuredClone(
    [...fx.tasks.values()].find(task=>task.idempotencyKey === key))};
  const host=createKnowledgeWatchHost({...fx.options,runtime,scheduler});host.start();
  try {
    const first=await host.consumeInterestTask('followup-task',request());
    const saved=host.registerFeedCheck({checkId:'old-intake',runAt:iso(at),subscriptionId:'feed-a',topicIds:['typescript']});
    const schedule=schedules.get(saved.schedule.scheduleId);schedule.status='fired';schedule.taskId='old-due';
    fx.tasks.set('old-due',{taskId:'old-due',goal:schedule.goal,conversationId:schedule.conversationId,
      idempotencyKey:schedule.taskIdempotencyKey,state:'running'});
    assert.ok(host.getFeedCheckContext('old-due'));
    const replacement=await host.consumeInterestTask('question-task',request());
    assert.equal(replacement.watch.state,'tracked');
    assert.equal(replacement.watch.consumer.intakeTaskId,'question-task');
    assert.equal(replacement.watch.consumer.revision,first.watch.consumer.revision+1);
    assert.equal(host.getFeedCheckContext('old-due'),null);
    assert.equal((await host.consumeFeedCheck('old-due',{signal:new AbortController().signal})).reason,'feed_check_binding_invalid');
    assert.equal(fx.feedReads,0);
  } finally {host.dispose();}
});

test('persisted intake identity stays host-only while source changes use the strict public consumer contract', async () => {
  const fx=fixture();fx.sustained();fx.host.dispose();
  const submitted=[];
  const host=createKnowledgeWatchHost({...fx.options,workPort:{
    async read(){return {state:'absent'};},
    async submit(input){submitted.push(structuredClone(input.work));return {accepted:true,taskId:'recheck-work-task'};},
  }});host.start();
  try {
    await host.consumeInterestTask('followup-task',request());
    const update=await host.consumeSourceUpdate({namespace:'fixture-user',sourceId:'feed-a',availability:'available',
      revision:'source-v2',contentSha256:'b'.repeat(64),fetchedAt:iso(at),citation:{locator:'https://example.test/update'}},request());
    assert.equal(update.accepted,true);
    assert.equal(submitted.length,1);
    assert.deepEqual(submitted[0].consumer,{id:'typescript',revision:1});
    assert.equal(host.snapshot().watches[0].consumer.intakeTaskId,'followup-task');
    assert.ok(fx.grantReads.every(input=>input.taskId === 'followup-task'));
  } finally {host.dispose();}
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

test('cancellation, failure or deadline during the final reader await never commits an interest watch', async () => {
  for (const change of ['cancelRequested', 'failed', 'deadline']) {
    const fx = fixture();
    fx.sustained(); fx.host.dispose();
    let time = at; let reads = 0; let release; let entered;
    const waiting = new Promise(resolve => {release = resolve;});
    const ready = new Promise(resolve => {entered = resolve;});
    const options = {...fx.options, now: () => time, readInterestSignal: async input => {
      const signal = await fx.options.readInterestSignal(input);
      reads += 1;
      if (reads === 4) {entered(); await waiting;}
      return signal;
    }};
    const host = createKnowledgeWatchHost(options); host.start();
    try {
      const pending = host.consumeInterestTask('followup-task', request());
      await ready;
      if (change === 'deadline') time = at + 60_000;
      else if (change === 'failed') fx.tasks.get('followup-task').state = 'failed';
      else fx.tasks.get('followup-task').cancelRequested = true;
      release();
      assert.equal((await pending).reason, 'interest_context_invalidated', change);
      assert.deepEqual(host.snapshot().watches, [], change);
      const receipts = [...fx.rows.entries()].filter(([key]) => key.includes('knowledge-watch-interest-task:'));
      assert.equal(receipts.length, 1); assert.equal(receipts[0][1].state, 'unknown');
      const task = fx.tasks.get('followup-task'); delete task.cancelRequested; task.state = 'created';
      assert.equal((await host.consumeInterestTask('followup-task', {...request(), deadline: iso(at + 120_000)})).reason,
        'interest_consumption_unknown');
      assert.equal(fx.choices, 1);
    } finally {host.dispose();}
  }
});
