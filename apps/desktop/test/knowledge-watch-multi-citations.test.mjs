import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {createKnowledgeWatchHost} from '../electron/knowledge-watch-host.js';
import {knowledgeFeedCitationHtml} from '../src/app/knowledge-controls.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const base = Date.parse('2026-09-30T00:00:00Z');
const iso = value => new Date(value).toISOString();

// Isolated dependency-injection fixture; P8 separately verifies the public application exports.
test('multi-article pages bind exact consumers and preserve item citations through checkpoint restoration', async () => {
    const ports = await import(process.env.PA_KNOWLEDGE_FEED_RECEIPT_TEST_MODULE
      ?? new URL('../../runtime/dist/application/knowledge-feed-receipt.js', import.meta.url).href);
    const knowledgeFeedReceipts = Object.fromEntries(['createKnowledgeFeedReceipt','parseKnowledgeFeedReceipt',
      'verifyKnowledgeFeedReceiptBinding','knowledgeFeedReceiptItems'].map(key => [key,ports[key]]));
    const rows = new Map();
    const tasks = new Map();
    const checkpoints = {loadCheckpoint(taskId,key) { return structuredClone(rows.get(`${taskId}:${key}`)); },
      saveCheckpoint(taskId,key,value) { rows.set(`${taskId}:${key}`,structuredClone(value)); }};
    const runtime = {...checkpoints,
      findTaskByIdempotencyKey(key) { return structuredClone(tasks.get(key)); },
      submitTask(input) { const task={...input,taskId:`task-${tasks.size+1}`,state:'created',evidenceRefs:[]};
        tasks.set(input.idempotencyKey,task);return structuredClone(task); }};
    let time=base;
    const options={profile:'huawei_ict_agentarts',namespace:'fixture-user',checkpointTaskId:'root-task',
      checkpoints,runtime,knowledgeFeedReceipts,now:()=>time,
      interestDecider:{choose:async()=>({outcome:'selected',requiresHostRevalidation:true,
        selected:{id:'track_public',revision:1},receipt:{modelReceiptId:'fixture-laya'}})},
      feedCollect:async()=>({items:[
        {title:'Rust article',summary:'Rust release statement.',record:{dedupeKey:'a-rust',contentRef:'https://example.com/rust',occurredAt:iso(base)}},
        {title:'TypeScript article',summary:'TypeScript release statement.',record:{dedupeKey:'b-typescript',contentRef:'https://example.com/typescript',occurredAt:iso(base)}},
      ],nextCursor:'cursor-2',hasMore:false,collection:{state:'fetched',subscriptionId:'feed-a',fetchedAt:iso(time),
        validators:{etag:'page-v2',lastModified:null}}})};
    const host=createKnowledgeWatchHost(options);host.start();
    for(const topicId of ['rust','typescript']) {
      const signal={namespace:'fixture-user',topicId,at:iso(base),evidenceMaxAgeMs:120000,watchDurationMs:3600000,
        evidence:[{id:`${topicId}-q`,topicId,sourceId:'conversation',sourceRevision:'r1',occurredAt:iso(base-1000),interactionId:`${topicId}-q`,kind:'question',match:'semantic'},
          {id:`${topicId}-f`,topicId,sourceId:'conversation',sourceRevision:'r1',occurredAt:iso(base),interactionId:`${topicId}-f`,kind:'followup',match:'semantic',relatedEvidenceId:`${topicId}-q`}],
        source:{id:'feed-a',revision:'baseline',visibility:'public',risk:'low',transportVerified:true,verificationExpiresAt:iso(base+3600000)},
        scope:{id:'public-scope',revision:1,state:'granted',publicLowRiskTracking:true,expiresAt:iso(base+3600000)},
        sourceContent:{contentSha256:'a'.repeat(64),cacheVersion:'baseline',lastSuccessfulCheck:iso(base-1000),validUntil:iso(base+3600000)}};
      assert.equal((await host.consumeInterestSignal(signal,{deadline:iso(base+60000),signal:new AbortController().signal})).watch.state,'tracked');
    }
    time+=1000;
    const collected=await host.refreshSubscribedFeed({subscriptionId:'feed-a'});
    assert.equal(collected.accepted,true);
    assert.equal(collected.submitted.length,2);
    const contexts=Object.keys(host.snapshot().submissions).map(key=>host.getRecheckContext(key));
    assert.deepEqual(new Set(contexts.map(ctx=>ctx.topicId)),new Set(['rust','typescript']));
    assert.notEqual(contexts[0].workKey,contexts[1].workKey);
    const ctx=contexts.find(context=>context.topicId==='typescript');
    assert.notEqual(ctx.citation,'https://example.com/rust');
    assert.deepEqual(ctx.summary.split('\n').map(line=>JSON.parse(line).citation),
      ['https://example.com/rust','https://example.com/typescript']);
    const observation=host.dialogueProjection().items.find(item=>item.topicId==='typescript').answer;
    assert.equal(observation.kind,'latest_observation');
    assert.equal(observation.citation,null);
    assert.equal(observation.items[1].citation,'https://example.com/typescript');
    assert.equal(observation.items[1].excerpt,'TypeScript release statement.');
    assert.equal(observation.items[1].sourceRevision,ctx.observedRevision);

    // A synthetic judgment goes through the unchanged v2/Evidence binding gate.
    const task=tasks.get(ctx.workKey);
    const refs=[`knowledge-watch-source-read:${ctx.sourceReadReceiptId}`,`knowledge-recheck-judgment:${task.taskId}`];
    const judgment={version:1,taskId:task.taskId,evidenceRef:refs[1],provider:'local_laya',outcome:'relevant_update',
      sourceReadReceiptId:ctx.sourceReadReceiptId,modelReceiptId:'b'.repeat(64),contextDigest:'c'.repeat(64),
      observedSummarySha256:hash(ctx.summary),evaluatedAt:iso(time)};
    checkpoints.saveCheckpoint(task.taskId,'knowledge-recheck-judgment',judgment);
    checkpoints.saveCheckpoint(task.taskId,'knowledge-recheck-result',{...ctx,version:2,status:'completed',
      taskId:task.taskId,evaluatedContentSha256:ctx.observedContentSha256,evaluatedAt:iso(time),evidenceRefs:refs,
      evaluation:{outcome:'relevant_update',freshnessAction:'refresh_required',freshnessReason:'content_changed',
        topicId:ctx.topicId,consumerRevision:ctx.consumerRevision,sourceId:ctx.sourceId,observedRevision:ctx.observedRevision,
        modelReceiptId:judgment.modelReceiptId,contextDigest:judgment.contextDigest,observedSummarySha256:judgment.observedSummarySha256}});
    task.state='succeeded';task.evidenceRefs=refs;
    assert.equal((await host.bindObservedRevision('typescript')).accepted,true);
    assert.equal(host.dialogueProjection().items.find(item=>item.topicId==='rust').answer.kind,'latest_observation');
    const saved=checkpoints.loadCheckpoint('root-task','knowledge-watch:v1:fixture-user');
    // Legacy document shape lacked source-head receipt refs; recover through exact consumer contexts.
    delete saved.sources['feed-a'].sourceReadTaskId;delete saved.sources['feed-a'].sourceReadReceiptId;
    checkpoints.saveCheckpoint('root-task','knowledge-watch:v1:fixture-user',saved);
    const restored=createKnowledgeWatchHost(options);restored.start();
    const current=restored.dialogueProjection().items.find(item=>item.topicId==='typescript');
    assert.equal(current.answer.kind,'current_fact');
    assert.equal(current.answer.citation,null);
    assert.equal(current.answer.items[1].citation,'https://example.com/typescript');
    const receiptKey=`knowledge-watch-source-read:${ctx.sourceReadReceiptId}`;
    const tampered=checkpoints.loadCheckpoint('root-task',receiptKey);
    tampered.citationItems[1].contentRef='https://example.com/rust';
    checkpoints.saveCheckpoint('root-task',receiptKey,tampered);
    assert.equal(restored.dialogueProjection().items.find(item=>item.topicId==='typescript').answer.kind,'withheld');
    assert.equal(restored.getRecheckContext(ctx.workKey),null);
    host.dispose();restored.dispose();
  });

test('knowledge page renders each original statement beside its own citation and hides bundle identities', () => {
  const html=knowledgeFeedCitationHtml({citation:null,citationBundleRef:'knowledge-feed-citations:internal',items:[
    {itemKey:'rust',citation:'https://example.com/rust',title:'Rust',excerpt:'Rust statement',sourceRevision:'page-v2'},
    {itemKey:'ts',citation:'https://example.com/typescript',title:'TypeScript',excerpt:'<img onerror="bad()">',sourceRevision:'page-v2'},
  ]});
  const rust=html.slice(html.indexOf('data-source-item="rust"'),html.indexOf('data-source-item="ts"'));
  const ts=html.slice(html.indexOf('data-source-item="ts"'));
  assert.ok(rust.includes('https://example.com/rust'));
  assert.equal(rust.includes('https://example.com/typescript'),false);
  assert.ok(ts.includes('https://example.com/typescript'));
  assert.equal(ts.includes('https://example.com/rust'),false);
  assert.equal(html.includes('<img'),false);
  assert.equal(html.includes('knowledge-feed-citations:'),false);
  assert.equal(knowledgeFeedCitationHtml({citation:'knowledge-feed-citations:unknown'}),'');
});
