import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createDesktopFeedsHost} from '../electron/feeds-host.js';
import {createKnowledgeWatchHost} from '../electron/knowledge-watch-host.js';
import {TaskRuntime} from '@personal-agent/runtime';
import {createRuntimeApplication} from '@personal-agent/runtime/application';
import {FakeFeedProvider} from '@personal-agent/feeds';

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: val => Buffer.from(val).reverse(),
  decryptString: buf => Buffer.from(buf).reverse().toString(),
};

test('Formal desktop feeds.collect path through session consent, genuine recheck dispatch and revision binding', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pa-kw-formal-feeds-'));
  const runtimeDb = path.join(dir, 'runtime.sqlite');

  const runtimeApp = createRuntimeApplication({
    path: runtimeDb,
    profile: 'huawei_ict_agentarts',
    coordination: {
      invoke: async () => ({kind: 'text_response', text: 'ok', verification: 'verified'}),
    },
  });
  const runtime = runtimeApp.runtime;

  const rootTask = runtime.submitTask({
    goal: 'Knowledge Watch Root Task',
    conversationId: 'knowledge-watch:test-user',
    idempotencyKey: 'kw-root',
  });

  const feedUrl = 'https://devblogs.microsoft.com/typescript/feed/';
  const fixtureV1 = {
    url: feedUrl,
    etag: 'W/"v1"',
    body: `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>TypeScript 官方更新</title>
    <link>https://devblogs.microsoft.com/typescript/</link>
    <description>TypeScript 博客</description>
    <item>
      <title>TypeScript 5.8 发布</title>
      <link>https://example.com/ts58</link>
      <description>更新说明：速度提升</description>
      <guid>ts-58</guid>
      <pubDate>Wed, 29 Sep 2026 00:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`,
  };

  const fakeProvider = new FakeFeedProvider([fixtureV1]);
  Object.defineProperty(fakeProvider, 'verification', {value: 'conditional'});

  const feedsUserData = path.join(dir, 'feeds-user');
  const feedsHost = createDesktopFeedsHost({
    userData: feedsUserData,
    safeStorage,
    provider: fakeProvider,
  });

  // 1. Add subscription
  feedsHost.add({title: 'TypeScript 官方更新', url: feedUrl});
  feedsHost.prepare();
  feedsHost.bindApplication({runtime});

  // 2. Wrap feedCollect delegating through competitionToolAvailability
  const collectTool = feedsHost.tools.find(tool => tool.descriptor?.name === 'feeds.collect');
  assert.ok(collectTool, 'feeds.collect tool must be registered after prepare');

  const availability = feedsHost.competitionToolAvailability.find(item => item.toolName === 'feeds.collect');
  assert.ok(availability, 'feeds.collect competitionToolAvailability must be present');

  const feedCollect = async (query, signal) => {
    const isAvailable = availability.available({taskId: rootTask.taskId, signal});
    if (!isAvailable) {
      const error = new Error('订阅收集工具未获用户会话授权');
      error.code = 'UNAUTHORIZED';
      throw error;
    }
    return collectTool.execute(query, {taskId: rootTask.taskId, signal});
  };

  const subscriptionId = feedsHost.snapshot().subscriptions[0].id;
  assert.ok(subscriptionId);

  const host = createKnowledgeWatchHost({
    profile: 'huawei_ict_agentarts',
    namespace: 'test-user',
    checkpointTaskId: rootTask.taskId,
    checkpoints: runtime,
    now: () => Date.now(),
    runtime,
    feedCollect,
    feedSubscriptionId: subscriptionId,
    layaChooser: {
      async choose() {
        return {
          state: 'selected',
          selected: {id: 'track_public', revision: 1},
          eligibleForRuntime: false,
          reason: 'selected',
          calibrated: false,
          scores: [],
          receipt: {id: 'model-real', promptVersion: 'action-choice-v1', contextDigest: 'digest', candidates: []},
        };
      },
    },
  });
  await host.start();

  // 3. Before session consent: feed collection fails with UNAUTHORIZED, watch data is not lost or forged
  const unconsented = await host.refreshSubscribedFeed();
  assert.equal(unconsented.accepted, false);
  assert.equal(unconsented.availability, 'unavailable');
  assert.equal(unconsented.reason, 'source_unavailable');
  assert.equal(unconsented.code, 'UNAUTHORIZED');

  // 4. User grants session consent
  feedsHost.authorize({readAndCloudConsent: true});
  assert.equal(feedsHost.snapshot().sessionAllowed, true);

  // 5. Establish tracked watch on typescript
  const now = Date.now();
  const trackedResult = await host.consumeInterestSignal({
    namespace: 'test-user',
    topicId: 'typescript',
    at: new Date(now).toISOString(),
    evidenceMaxAgeMs: 2 * 60 * 1000,
    watchDurationMs: 60 * 60 * 1000,
    evidence: [
      {id: 'q1', topicId: 'typescript', sourceId: 'conversation', sourceRevision: 'r1', occurredAt: new Date(now - 1000).toISOString(), interactionId: 'q1', kind: 'question', match: 'semantic'},
      {id: 'q2', topicId: 'typescript', sourceId: 'conversation', sourceRevision: 'r1', occurredAt: new Date(now).toISOString(), interactionId: 'q2', kind: 'followup', match: 'semantic', relatedEvidenceId: 'q1'},
    ],
    scope: {state: 'granted', id: 'public-tracking', revision: 1, publicLowRiskTracking: true, expiresAt: new Date(now + 3600000).toISOString()},
    source: {id: subscriptionId, revision: 'v1', visibility: 'public', risk: 'low', transportVerified: true, verificationExpiresAt: new Date(now + 3600000).toISOString()},
    sourceContent: {contentSha256: 'a'.repeat(64), cacheVersion: 'v1', lastSuccessfulCheck: new Date(now - 60000).toISOString(), validUntil: new Date(now + 3600000).toISOString()},
  }, {deadline: new Date(now + 60000).toISOString(), signal: new AbortController().signal});

  assert.equal(trackedResult.watch.state, 'tracked');

  // 6. Refresh subscribed feed with fixtureV1 (different from initial watch revision v1)
  const refreshed = await host.refreshSubscribedFeed();
  assert.equal(refreshed.provider, 'feeds');
  assert.equal(refreshed.notified, true);

  // Dialogue projection shows latest_observation (not current_fact)
  const projectionAfterUpdate = host.dialogueProjection();
  const item = projectionAfterUpdate.items.find(i => i.topicId === 'typescript');
  assert.ok(item);
  assert.equal(item.answer.kind, 'latest_observation');
  assert.equal(item.usableAsCurrentFact, false);

  // 7. Verify recheck task was submitted in runtime with state 'created'
  const submissions = host.snapshot().submissions;
  assert.ok(submissions);
  const firstSubmission = Object.values(submissions)[0];
  assert.ok(firstSubmission);
  assert.equal(firstSubmission.state, 'accepted');

  const recheckTask = runtime.getTask(firstSubmission.taskId);
  assert.ok(recheckTask, 'Recheck task must exist in runtime');
  assert.equal(recheckTask.state, 'created');

  // Attempting to bind revision early before recheck task succeeds fails with reevaluation_unconfirmed
  const earlyBind = await host.bindObservedRevision('typescript');
  assert.equal(earlyBind.accepted, false);
  assert.equal(earlyBind.reason, 'reevaluation_unconfirmed');
  assert.equal(earlyBind.taskState, 'created');

  // 8. Dispatch and execute the genuine recheck task via RuntimeApplication
  const recheckWorkKey = Object.keys(submissions)[0];
  const recheckContext = host.getRecheckContext(recheckWorkKey);
  assert.ok(recheckContext, 'getRecheckContext must resolve context for submitted work key');
  assert.equal(recheckContext.topicId, 'typescript');
  assert.equal(recheckContext.sourceId, subscriptionId);
  assert.equal(recheckContext.citation, 'https://example.com/ts58');

  await runtimeApp.dispatchKnowledgeRecheckTask(recheckTask.taskId, recheckContext);

  const confirmedTask = runtime.getTask(recheckTask.taskId);
  assert.equal(confirmedTask.state, 'succeeded');
  assert.deepEqual(confirmedTask.evidenceRefs, ['https://example.com/ts58']);

  const checkpoint = runtime.loadCheckpoint(recheckTask.taskId, 'knowledge-recheck-result');
  assert.ok(checkpoint, 'Knowledge recheck result checkpoint must be saved');
  assert.equal(checkpoint.status, 'confirmed');
  assert.equal(checkpoint.topicId, 'typescript');
  assert.equal(checkpoint.citation, 'https://example.com/ts58');

  // 9. Now bindObservedRevision succeeds with genuine confirmed reevaluation!
  const bound = await host.bindObservedRevision('typescript');
  assert.equal(bound.accepted, true);
  assert.equal(bound.reason, 'bound');

  // 10. Dialogue projection now projects current_fact with usableAsCurrentFact: true
  const projectionAfterBind = host.dialogueProjection();
  const finalItem = projectionAfterBind.items.find(i => i.topicId === 'typescript');
  assert.equal(finalItem.answer.kind, 'current_fact');
  assert.equal(finalItem.usableAsCurrentFact, true);
  assert.equal(finalItem.answer.citation, 'https://example.com/ts58');

  // Ordered cleanup
  await host.dispose();
  feedsHost.close();
  runtimeApp.close();
  try { rmSync(dir, {recursive: true, force: true}); } catch {}
});

test('Legacy empty succeeded task is rejected by bindObservedRevision and cannot promote current_fact', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pa-kw-legacy-empty-'));
  const runtimeDb = path.join(dir, 'runtime.sqlite');
  const runtime = new TaskRuntime(runtimeDb);

  const rootTask = runtime.submitTask({
    goal: 'Knowledge Watch Root Task',
    conversationId: 'knowledge-watch:test-user',
    idempotencyKey: 'kw-root',
  });

  const feedUrl = 'https://devblogs.microsoft.com/typescript/feed/';
  const fixtureV1 = {
    url: feedUrl,
    etag: 'W/"v1"',
    body: `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>TypeScript 官方更新</title>
    <link>https://devblogs.microsoft.com/typescript/</link>
    <item>
      <title>TypeScript 5.8 发布</title>
      <link>https://example.com/ts58</link>
      <guid>ts-58</guid>
      <pubDate>Wed, 29 Sep 2026 00:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`,
  };
  const fakeProvider = new FakeFeedProvider([fixtureV1]);
  Object.defineProperty(fakeProvider, 'verification', {value: 'conditional'});
  const feedsHost = createDesktopFeedsHost({
    userData: path.join(dir, 'feeds-user'),
    safeStorage,
    provider: fakeProvider,
  });
  feedsHost.add({title: 'TypeScript 官方更新', url: feedUrl});
  feedsHost.prepare();
  feedsHost.bindApplication({runtime});
  feedsHost.authorize({readAndCloudConsent: true});

  const collectTool = feedsHost.tools.find(tool => tool.descriptor?.name === 'feeds.collect');
  const availability = feedsHost.competitionToolAvailability.find(item => item.toolName === 'feeds.collect');
  const feedCollect = async (query, signal) => {
    if (!availability.available({taskId: rootTask.taskId, signal})) {
      const error = new Error('订阅收集工具未获用户会话授权');
      error.code = 'UNAUTHORIZED';
      throw error;
    }
    return collectTool.execute(query, {taskId: rootTask.taskId, signal});
  };
  const subscriptionId = feedsHost.snapshot().subscriptions[0].id;

  const host = createKnowledgeWatchHost({
    profile: 'huawei_ict_agentarts',
    namespace: 'test-user',
    checkpointTaskId: rootTask.taskId,
    checkpoints: runtime,
    now: () => Date.now(),
    runtime,
    feedCollect,
    feedSubscriptionId: subscriptionId,
    layaChooser: {
      async choose() {
        return {
          state: 'selected',
          selected: {id: 'track_public', revision: 1},
          eligibleForRuntime: false,
          reason: 'selected',
          calibrated: false,
          scores: [],
          receipt: {id: 'model-real', promptVersion: 'action-choice-v1', contextDigest: 'digest', candidates: []},
        };
      },
    },
  });
  await host.start();

  const now = Date.now();
  await host.consumeInterestSignal({
    namespace: 'test-user',
    topicId: 'typescript',
    at: new Date(now).toISOString(),
    evidenceMaxAgeMs: 2 * 60 * 1000,
    watchDurationMs: 60 * 60 * 1000,
    evidence: [
      {id: 'q1', topicId: 'typescript', sourceId: 'conversation', sourceRevision: 'r1', occurredAt: new Date(now - 1000).toISOString(), interactionId: 'q1', kind: 'question', match: 'semantic'},
      {id: 'q2', topicId: 'typescript', sourceId: 'conversation', sourceRevision: 'r1', occurredAt: new Date(now).toISOString(), interactionId: 'q2', kind: 'followup', match: 'semantic', relatedEvidenceId: 'q1'},
    ],
    scope: {state: 'granted', id: 'public-tracking', revision: 1, publicLowRiskTracking: true, expiresAt: new Date(now + 3600000).toISOString()},
    source: {id: subscriptionId, revision: 'v1', visibility: 'public', risk: 'low', transportVerified: true, verificationExpiresAt: new Date(now + 3600000).toISOString()},
    sourceContent: {contentSha256: 'a'.repeat(64), cacheVersion: 'v1', lastSuccessfulCheck: new Date(now - 60000).toISOString(), validUntil: new Date(now + 3600000).toISOString()},
  }, {deadline: new Date(now + 60000).toISOString(), signal: new AbortController().signal});

  await host.refreshSubscribedFeed();

  // Find the created recheck task
  const submissions = host.snapshot().submissions;
  const firstSubmission = Object.values(submissions)[0];
  const recheckTask = runtime.getTask(firstSubmission.taskId);

  // Execute it as old legacy no-op: state succeeds, but evidenceRefs is [] and no checkpoint is saved!
  await runtime.runTask(recheckTask.taskId, async () => {
    return {
      resultSummary: 'Old empty no-op recheck',
      evidenceRefs: [],
    };
  }, {
    deadline: new Date(Date.now() + 60_000).toISOString(),
    sideEffect: 'read',
  });

  const legacyTaskSnapshot = runtime.getTask(recheckTask.taskId);
  assert.equal(legacyTaskSnapshot.state, 'succeeded');
  assert.deepEqual(legacyTaskSnapshot.evidenceRefs, []);

  // Now attempt to bind observed revision: it MUST fail with unconfirmed_empty_task!
  const bindAttempt = await host.bindObservedRevision('typescript');
  assert.equal(bindAttempt.accepted, false);
  assert.equal(bindAttempt.reason, 'reevaluation_unconfirmed');
  assert.equal(bindAttempt.taskState, 'unconfirmed_empty_task');

  // And dialogue projection MUST NOT promote to current_fact!
  const projection = host.dialogueProjection();
  const item = projection.items.find(i => i.topicId === 'typescript');
  assert.equal(item.usableAsCurrentFact, false);
  assert.equal(item.answer.kind, 'latest_observation');

  await host.dispose();
  feedsHost.close();
  runtime.close();
  try { rmSync(dir, {recursive: true, force: true}); } catch {}
});
