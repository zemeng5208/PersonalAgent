import test from 'node:test';
import assert from 'node:assert/strict';
import {FakeCoordinationStoreHost} from '@personal-agent/goals/store';
import {
  MeetingRescheduleCoordinator,
  createStoreExecutionPort,
  InMemoryMeetingDecisionReceiptStore,
} from '../dist/index.js';

function createMeetingFixture() {
  const storeHost = new FakeCoordinationStoreHost();
  const store = storeHost.provision('test-user-namespace');

  // Seed graph with meeting, attendance goal, departure decision, and reminder plan
  const t0 = '2026-09-29T10:00:00.000Z';
  const tEnd = '2026-09-30T00:00:00.000Z';

  store.append(0, {
    id: 'meeting-sync-1',
    kind: 'fact',
    summary: '周四下午 15:00 项目架构同步会',
    sourceRef: 'calendar:work',
    sensitivity: 'private',
    state: 'active',
    validFrom: t0,
    validUntil: tEnd,
    reason: '会议邀请接入',
    dependencies: [],
  });

  store.append(1, {
    id: 'goal-attend-sync',
    kind: 'goal',
    summary: '准时参加项目架构同步会',
    sourceRef: 'user:goal',
    sensitivity: 'private',
    state: 'active',
    validFrom: t0,
    validUntil: tEnd,
    reason: '重点关注架构依赖',
    dependencies: [{id: 'meeting-sync-1', revision: 1}],
  });

  store.append(2, {
    id: 'decide-depart-sync',
    kind: 'decision',
    summary: '14:30 从工位出发前往 302 会议室',
    sourceRef: 'agent:schedule',
    sensitivity: 'private',
    state: 'active',
    validFrom: t0,
    validUntil: tEnd,
    reason: '预留 30 分钟准备与通勤',
    dependencies: [{id: 'goal-attend-sync', revision: 1}],
  });

  store.append(3, {
    id: 'plan-remind-sync',
    kind: 'plan',
    summary: '14:15 弹出准备材料与出发提醒',
    sourceRef: 'agent:schedule',
    sensitivity: 'private',
    state: 'active',
    validFrom: t0,
    validUntil: tEnd,
    reason: '提前 15 分钟准备笔记本与投屏',
    dependencies: [{id: 'decide-depart-sync', revision: 1}],
  });

  // Add an unrelated branch node with independent dependencies to verify preservation
  store.append(4, {
    id: 'plan-unrelated-work',
    kind: 'plan',
    summary: '16:00 独立代码评审',
    sourceRef: 'agent:schedule',
    sensitivity: 'private',
    state: 'active',
    validFrom: t0,
    validUntil: tEnd,
    reason: '独立任务',
    dependencies: [],
  });

  return {store};
}

/** Mock inference port producing valid Laya choices according to LayaActionChoiceService contract. */
function createMockLaya(chosenIndex = 0, confidence = 0.95) {
  let callCount = 0;
  let lastPayload = null;
  const inference = {
    getCallCount: () => callCount,
    getLastPayload: () => lastPayload,
    infer: async (payload, signal) => {
      if (signal.aborted) throw new Error('cancelled');
      callCount++;
      lastPayload = payload;
      const questionKey = Object.keys(payload.questions)[0];
      const criteriaKeys = Object.keys(payload.questions[questionKey].criteria);
      const chosenKey = criteriaKeys[chosenIndex] ?? 'candidate_0';
      const remainingProb = (1.0 - confidence) / (criteriaKeys.length - 1);
      const probabilities = {};
      for (const k of criteriaKeys) {
        probabilities[k] = k === chosenKey ? confidence : remainingProb;
      }
      const answer = {
        choice: chosenKey,
        probabilities,
        answer_confidence: confidence,
        confidence: 0.92,
      };
      return {
        answers: {
          [questionKey]: answer,
        },
      };
    },
  };
  return inference;
}

test('MeetingRescheduleCoordinator: with executionPort, atomically applies full batch and preserves unrelated branches', async () => {
  const {store} = createMeetingFixture();
  const mockLaya = createMockLaya(0, 0.95);
  const executionPort = createStoreExecutionPort(store);
  const receiptStore = new InMemoryMeetingDecisionReceiptStore();

  const coordinator = new MeetingRescheduleCoordinator({
    store,
    inference: mockLaya,
    executionPort,
    receiptStore,
  });

  const event = {
    eventId: 'evt-reschedule-101',
    source: 'calendar:work',
    meetingFactId: 'meeting-sync-1',
    originalSummary: '周四下午 15:00 项目架构同步会',
    newSummary: '周四下午 17:00 项目架构同步会 (推迟2小时)',
    sourceRevision: 'rev-2',
    detectedAt: '2026-09-29T11:00:00.000Z',
    deadline: new Date(Date.now() + 60_000).toISOString(),
    signal: new AbortController().signal,
  };

  const receipt = await coordinator.processEvent(event);
  assert.equal(receipt.status, 'applied');
  assert.equal(receipt.selectedCandidateId, 'cand-adjust-schedule');
  assert.equal(receipt.actionId, 'adjust_schedule');
  assert.equal(receipt.graphRevisionBefore, 5);
  // Initial 5 + 1 fact + 3 dependent nodes (goal, decision, plan) = 9
  assert.equal(receipt.graphRevisionAfter, 9);
  assert.equal(mockLaya.getCallCount(), 1);

  // Read back and verify final graph nodes and dependencies
  const finalGraph = store.read();
  const currentMeeting = finalGraph.history.findLast(n => n.id === 'meeting-sync-1');
  const currentGoal = finalGraph.history.findLast(n => n.id === 'goal-attend-sync');
  const currentDecision = finalGraph.history.findLast(n => n.id === 'decide-depart-sync');
  const currentPlan = finalGraph.history.findLast(n => n.id === 'plan-remind-sync');
  const unrelatedPlan = finalGraph.history.findLast(n => n.id === 'plan-unrelated-work');

  assert.equal(currentMeeting.revision, 2);
  assert.match(currentMeeting.summary, /17:00/);

  assert.equal(currentGoal.revision, 2);
  assert.deepEqual(currentGoal.dependencies, [{id: 'meeting-sync-1', revision: 2}]);

  assert.equal(currentDecision.revision, 2);
  assert.deepEqual(currentDecision.dependencies, [{id: 'goal-attend-sync', revision: 2}]);

  assert.equal(currentPlan.revision, 2);
  assert.deepEqual(currentPlan.dependencies, [{id: 'decide-depart-sync', revision: 2}]);

  // Unrelated plan is completely unaffected
  assert.equal(unrelatedPlan.revision, 1);

  // Restart coordinator with new instance sharing the durable receipt store -> deduplicated without model re-run
  const newCoordinator = new MeetingRescheduleCoordinator({
    store,
    inference: mockLaya,
    executionPort,
    receiptStore,
  });
  const replayReceipt = await newCoordinator.processEvent(event);
  assert.equal(replayReceipt.status, 'already_processed');
  assert.equal(mockLaya.getCallCount(), 1); // No new model call
});

test('MeetingRescheduleCoordinator: without executionPort, emits proposal without mutating store', async () => {
  const {store} = createMeetingFixture();
  const mockLaya = createMockLaya(0, 0.95);

  const coordinator = new MeetingRescheduleCoordinator({
    store,
    inference: mockLaya,
    // NO executionPort passed!
  });

  const event = {
    eventId: 'evt-reschedule-proposal-1',
    source: 'calendar:work',
    meetingFactId: 'meeting-sync-1',
    originalSummary: '周四下午 15:00 项目架构同步会',
    newSummary: '周四下午 17:00 项目架构同步会 (推迟2小时)',
    sourceRevision: 'rev-2',
    detectedAt: '2026-09-29T11:00:00.000Z',
    deadline: new Date(Date.now() + 60_000).toISOString(),
    signal: new AbortController().signal,
  };

  const receipt = await coordinator.processEvent(event);
  assert.equal(receipt.status, 'proposal');
  assert.equal(receipt.graphRevisionAfter, 5); // Store NOT mutated!
  assert.equal(store.read().revision, 5); // Graph untouched
  assert.ok(receipt.proposedModifications && receipt.proposedModifications.length > 0);
});

test('MeetingRescheduleCoordinator: detects conflict on same eventId with mutated input', async () => {
  const {store} = createMeetingFixture();
  const mockLaya = createMockLaya(0, 0.95);
  const receiptStore = new InMemoryMeetingDecisionReceiptStore();

  const coordinator = new MeetingRescheduleCoordinator({
    store,
    inference: mockLaya,
    receiptStore,
  });

  const event1 = {
    eventId: 'evt-shared-id-1',
    source: 'calendar:work',
    meetingFactId: 'meeting-sync-1',
    originalSummary: '周四下午 15:00 项目架构同步会',
    newSummary: '周四下午 17:00 项目架构同步会',
    sourceRevision: 'rev-1',
    detectedAt: '2026-09-29T11:00:00.000Z',
    deadline: new Date(Date.now() + 60_000).toISOString(),
    signal: new AbortController().signal,
  };
  await coordinator.processEvent(event1);

  // Same eventId with conflicting newSummary
  const event2 = {
    ...event1,
    newSummary: '周四下午 18:00 项目架构同步会 (冲突改动)',
  };
  const conflictReceipt = await coordinator.processEvent(event2);
  assert.equal(conflictReceipt.status, 'conflict');
  assert.match(conflictReceipt.reason, /冲突/);
});

test('MeetingRescheduleCoordinator: high-risk escalate_conflict holds for review without mutating plan', async () => {
  const {store} = createMeetingFixture();
  const mockLaya = createMockLaya(2, 0.90);
  const coordinator = new MeetingRescheduleCoordinator({
    store,
    inference: mockLaya,
  });

  const event = {
    eventId: 'evt-reschedule-conflict-102',
    source: 'calendar:work',
    meetingFactId: 'meeting-sync-1',
    originalSummary: '周四下午 15:00 项目架构同步会',
    newSummary: '周四下午 20:00 项目架构同步会 (严重冲突)',
    sourceRevision: 'rev-3',
    detectedAt: '2026-09-29T11:00:00.000Z',
    deadline: new Date(Date.now() + 60_000).toISOString(),
    signal: new AbortController().signal,
  };

  const receipt = await coordinator.processEvent(event);
  assert.equal(receipt.status, 'requires_review');
  assert.equal(receipt.selectedCandidateId, 'cand-escalate-conflict');
  assert.equal(store.read().revision, 5); // Graph untouched
});

test('MeetingRescheduleCoordinator: defer_and_verify defers without mutating store', async () => {
  const {store} = createMeetingFixture();
  const mockLaya = createMockLaya(1, 0.92);
  const coordinator = new MeetingRescheduleCoordinator({
    store,
    inference: mockLaya,
  });

  const event = {
    eventId: 'evt-reschedule-defer-103',
    source: 'calendar:work',
    meetingFactId: 'meeting-sync-1',
    originalSummary: '周四下午 15:00 项目架构同步会',
    newSummary: '周四下午 16:30 项目架构同步会',
    sourceRevision: 'rev-4',
    detectedAt: '2026-09-29T11:00:00.000Z',
    deadline: new Date(Date.now() + 60_000).toISOString(),
    signal: new AbortController().signal,
  };

  const receipt = await coordinator.processEvent(event);
  assert.equal(receipt.status, 'deferred');
  assert.equal(store.read().revision, 5);
});
