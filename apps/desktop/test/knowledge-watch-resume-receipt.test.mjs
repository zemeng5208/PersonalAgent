import assert from 'node:assert/strict';
import test from 'node:test';
import {createKnowledgeWatchHost} from '../electron/knowledge-watch-host.js';
import * as receipts from '../../runtime/dist/application/knowledge-feed-receipt.js';

// Explicit synthetic ports, not public-source proof or a cloud/Windows acceptance test.
test('resumed consumer reuses exact durable v3 after 304 without retrying old unknown work or extending validity', async () => {
  let time = Date.parse('2026-09-30T00:00:00.000Z');
  const iso = () => new Date(time).toISOString();
  const expiry = new Date(time + 3600_000).toISOString();
  let version = 'v2'; let unchanged = false;
  const rows = new Map(); const tasks = new Map();
  const intakeTasks = new Map(); const intakeSignals = new Map(); const sourceEvidence = new Map();
  const checkpoints = {loadCheckpoint: (_task, key) => structuredClone(rows.get(key)),
    saveCheckpoint: (_task, key, value) => rows.set(key, structuredClone(value))};
  const grant = {id: 'synthetic-native-grant', revision: 1, state: 'granted',
    publicLowRiskTracking: true, expiresAt: expiry};
  const submitted = [];
  const readGrant = identity => {
    assert.deepEqual(Object.keys(identity).sort(), ['namespace', 'sourceId', 'taskId']);
    const original = intakeSignals.get(identity.taskId);
    if (identity.namespace !== 'synthetic' || identity.sourceId !== original?.source.id
      || !intakeTasks.has(identity.taskId)) return null;
    return structuredClone(grant);
  };
  const host = createKnowledgeWatchHost({profile: 'huawei_ict_agentarts', namespace: 'synthetic',
    checkpointTaskId: 'synthetic-root', checkpoints, knowledgeFeedReceipts: receipts, now: () => time,
    runtime: {getTask: taskId => structuredClone(intakeTasks.get(taskId))},
    readInterestSignal: async identity => identity.namespace === 'synthetic' && intakeTasks.has(identity.taskId)
      ? structuredClone(intakeSignals.get(identity.taskId)) : null,
    readTrackingGrant: async identity => readGrant(identity), readTrackingGrantSnapshot: readGrant,
    readFeedReceiptEvidence: identity => identity.namespace === 'synthetic' && identity.sourceId === 'feed'
      && identity.sourceReadTaskId === 'synthetic-root' ? structuredClone(sourceEvidence.get(identity.receiptId)) : null,
    interestDecider: {choose: async () => ({outcome: 'selected', requiresHostRevalidation: true,
      selected: {id: 'track_public', revision: 1}, receipt: {modelReceiptId: 'synthetic-advisory'}})},
    workPort: {read: async ({idempotencyKey}) => tasks.get(idempotencyKey) ?? {state: 'absent'},
      submit: async ({idempotencyKey, work}) => {
        submitted.push({key: idempotencyKey, work});
        const task = {state: 'accepted', taskId: `synthetic-${submitted.length}`};
        tasks.set(idempotencyKey, task);
        return work.consumer.id === 'A' && submitted.filter(item => item.work.consumer.id === 'A').length === 1
          ? {state: 'unknown'} : {...task, accepted: true};
      }},
    feedCollect: async () => {
      const result = {items: unchanged ? [] : [{title: `Release ${version}`, summary: `Synthetic ${version}`,
      record: {dedupeKey: 'article', contentRef: 'https://example.com/release', occurredAt: iso(),
        accountRef: 'feed', fetchedAt: iso(), sensitivity: 'public'}}], nextCursor: 'synthetic-cursor', hasMore: false,
      collection: {state: unchanged ? 'unchanged' : 'fetched', subscriptionId: 'feed', fetchedAt: iso(),
        validators: {etag: version, lastModified: null}}};
      if (!unchanged) {
        const receipt = receipts.createKnowledgeFeedReceiptFromCollectResult({namespace: 'synthetic', sourceId: 'feed', result});
        assert.ok(receipt);
        sourceEvidence.set(receipt.receiptId, receipt);
      }
      return result;
    },
  });
  host.start();
  try {
    for (const topicId of ['A', 'B']) {
      const signal = {namespace: 'synthetic', topicId, at: iso(), evidenceMaxAgeMs: 120_000, watchDurationMs: 3600_000,
        evidence: [{id: `${topicId}-1`, topicId, sourceId: 'conversation', sourceRevision: '1', occurredAt: iso(),
          interactionId: `${topicId}-1`, kind: 'question', match: 'exact'},
        {id: `${topicId}-2`, topicId, sourceId: 'conversation', sourceRevision: '2', occurredAt: iso(),
          interactionId: `${topicId}-2`, kind: 'followup', match: 'exact', relatedEvidenceId: `${topicId}-1`}],
        scope: grant, source: {id: 'feed', revision: 'baseline', visibility: 'public', risk: 'low',
          transportVerified: true, verificationExpiresAt: expiry}, sourceContent: {contentSha256: 'a'.repeat(64),
          cacheVersion: 'baseline', lastSuccessfulCheck: iso(), validUntil: expiry}};
      const taskId = `synthetic-intake-${topicId}`;
      intakeTasks.set(taskId, {taskId, conversationId: 'synthetic-conversation', goal: `Follow up ${topicId}`, state: 'created'});
      intakeSignals.set(taskId, structuredClone(signal));
      const result = await host.consumeInterestTask(taskId, {deadline: expiry, signal: new AbortController().signal});
      assert.equal(result.accepted, true);
      assert.equal(result.watch.state, 'tracked');
      assert.equal(result.watch.consumer.intakeTaskId, taskId);
    }
    time += 1000; await host.refreshSubscribedFeed({subscriptionId: 'feed'});
    const oldA = submitted.find(item => item.work.consumer.id === 'A');
    // Retain an uncertain prior submission; the recovery must never submit its key again.
    assert.equal(host.snapshot().submissions[oldA.key].state, 'unknown');
    await host.pause('A');
    time += 1000; version = 'v3'; await host.refreshSubscribedFeed({subscriptionId: 'feed'});
    await host.resume('A');
    const before = host.snapshot(); const receiptKeys = [...rows.keys()].filter(key => key.startsWith('knowledge-watch-source-read:'));
    const count = submitted.length;
    time += 1000; unchanged = true;
    const result = await host.refreshSubscribedFeed({subscriptionId: 'feed'});
    assert.equal(result.reason, 'unchanged'); assert.equal(submitted.length, count + 1);
    const replay = submitted.at(-1);
    assert.equal(replay.work.consumer.id, 'A'); assert.notEqual(replay.key, oldA.key);
    const context = host.getRecheckContext(replay.key);
    assert.equal(context.observedRevision, before.sources.feed.revision);
    assert.equal(context.observedAt, before.sources.feed.observedAt);
    assert.equal(context.boundValidUntil, expiry);
    assert.equal(submitted.filter(item => item.key === oldA.key).length, 1);
    assert.deepEqual([...rows.keys()].filter(key => key.startsWith('knowledge-watch-source-read:')), receiptKeys);
    assert.notEqual(host.dialogueProjection().items.find(item => item.topicId === 'A').answer.kind, 'current_fact');
  } finally {host.dispose();}
});
