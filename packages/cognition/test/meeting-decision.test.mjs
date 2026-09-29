import test from 'node:test';
import assert from 'node:assert/strict';
import {FakeCoordinationStoreHost} from '@personal-agent/goals/store';
import {MeetingRescheduleCoordinator} from '../dist/index.js';

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

test('MeetingRescheduleCoordinator: low-risk adjust_schedule updates graph, clears impact, and applies CAS', async () => {
  const {store} = createMeetingFixture();
  // index 0: cand-adjust-schedule
  const mockLaya = createMockLaya(0, 0.95);
  const coordinator = new MeetingRescheduleCoordinator({
    store,
    inference: mockLaya,
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
  assert.equal(receipt.graphRevisionBefore, 4);
  // Initial 4 + 1 fact + 3 dependent nodes (goal, decision, plan) = 8
  assert.equal(receipt.graphRevisionAfter, 8);
  assert.equal(mockLaya.getCallCount(), 1);

  // Read back and verify final graph nodes and dependencies
  const finalGraph = store.read();
  const currentMeeting = finalGraph.history.findLast(n => n.id === 'meeting-sync-1');
  const currentGoal = finalGraph.history.findLast(n => n.id === 'goal-attend-sync');
  const currentDecision = finalGraph.history.findLast(n => n.id === 'decide-depart-sync');
  const currentPlan = finalGraph.history.findLast(n => n.id === 'plan-remind-sync');

  assert.equal(currentMeeting.revision, 2);
  assert.match(currentMeeting.summary, /17:00/);

  assert.equal(currentGoal.revision, 2);
  assert.deepEqual(currentGoal.dependencies, [{id: 'meeting-sync-1', revision: 2}]);

  assert.equal(currentDecision.revision, 2);
  assert.deepEqual(currentDecision.dependencies, [{id: 'goal-attend-sync', revision: 2}]);

  assert.equal(currentPlan.revision, 2);
  assert.deepEqual(currentPlan.dependencies, [{id: 'decide-depart-sync', revision: 2}]);
});

test('MeetingRescheduleCoordinator: high-risk escalate_conflict holds for review without mutating plan', async () => {
  const {store} = createMeetingFixture();
  // index 2: cand-escalate-conflict
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
    newSummary: '周四下午 20:00 项目架构同步会 (与晚间既定活动严重冲突)',
    sourceRevision: 'rev-3',
    detectedAt: '2026-09-29T11:00:00.000Z',
    deadline: new Date(Date.now() + 60_000).toISOString(),
    signal: new AbortController().signal,
  };

  const receipt = await coordinator.processEvent(event);
  assert.equal(receipt.status, 'requires_review');
  assert.equal(receipt.selectedCandidateId, 'cand-escalate-conflict');
  assert.match(receipt.reason, /高风险/);

  // Graph after fact should only have the fact appended (+1 revision), no plan mutation
  assert.equal(receipt.graphRevisionAfter, 5);
  const finalGraph = store.read();
  const currentPlan = finalGraph.history.findLast(n => n.id === 'plan-remind-sync');
  assert.equal(currentPlan.revision, 1); // Not mutated!
});

test('MeetingRescheduleCoordinator: defer_and_verify defers plan changes gracefully', async () => {
  const {store} = createMeetingFixture();
  // index 1: cand-defer-verify
  const mockLaya = createMockLaya(1, 0.88);
  const coordinator = new MeetingRescheduleCoordinator({
    store,
    inference: mockLaya,
  });

  const event = {
    eventId: 'evt-reschedule-defer-103',
    source: 'calendar:work',
    meetingFactId: 'meeting-sync-1',
    originalSummary: '周四下午 15:00 项目架构同步会',
    newSummary: '周四下午 16:30 项目架构同步会 (待二次确认)',
    sourceRevision: 'rev-4',
    detectedAt: '2026-09-29T11:00:00.000Z',
    deadline: new Date(Date.now() + 60_000).toISOString(),
    signal: new AbortController().signal,
  };

  const receipt = await coordinator.processEvent(event);
  assert.equal(receipt.status, 'deferred');
  assert.equal(receipt.selectedCandidateId, 'cand-defer-verify');
  assert.match(receipt.reason, /暂缓/);
  assert.equal(receipt.graphRevisionAfter, 5); // Only fact appended
});

test('MeetingRescheduleCoordinator: replay protection deduplicates identical eventId without re-running Laya', async () => {
  const {store} = createMeetingFixture();
  const mockLaya = createMockLaya(0, 0.95);
  const coordinator = new MeetingRescheduleCoordinator({
    store,
    inference: mockLaya,
  });

  const event = {
    eventId: 'evt-reschedule-idempotent-104',
    source: 'calendar:work',
    meetingFactId: 'meeting-sync-1',
    originalSummary: '周四下午 15:00 项目架构同步会',
    newSummary: '周四下午 17:00 项目架构同步会',
    sourceRevision: 'rev-2',
    detectedAt: '2026-09-29T11:00:00.000Z',
    deadline: new Date(Date.now() + 60_000).toISOString(),
    signal: new AbortController().signal,
  };

  const firstReceipt = await coordinator.processEvent(event);
  assert.equal(firstReceipt.status, 'applied');
  assert.equal(mockLaya.getCallCount(), 1);
  const revAfterFirst = store.read().revision;

  // Replay exact same event
  const replayReceipt = await coordinator.processEvent(event);
  assert.equal(replayReceipt.status, 'already_processed');
  assert.equal(replayReceipt.selectedCandidateId, firstReceipt.selectedCandidateId);
  // Must NOT have called Laya again!
  assert.equal(mockLaya.getCallCount(), 1);
  // Must NOT have mutated store again!
  assert.equal(store.read().revision, revAfterFirst);

  // Readback via getReceipt
  const readback = coordinator.getReceipt(event.eventId);
  assert.ok(readback);
  assert.equal(readback.eventId, event.eventId);
});

test('MeetingRescheduleCoordinator: non-existent meeting fact rejects cleanly', async () => {
  const {store} = createMeetingFixture();
  const mockLaya = createMockLaya();
  const coordinator = new MeetingRescheduleCoordinator({
    store,
    inference: mockLaya,
  });

  const event = {
    eventId: 'evt-invalid-fact',
    source: 'calendar:work',
    meetingFactId: 'non-existent-meeting-id',
    originalSummary: '未知会议',
    newSummary: '未知会议',
    sourceRevision: 'rev-1',
    detectedAt: '2026-09-29T11:00:00.000Z',
    deadline: new Date(Date.now() + 60_000).toISOString(),
    signal: new AbortController().signal,
  };

  await assert.rejects(() => coordinator.processEvent(event), {
    code: 'NOT_APPLICABLE',
  });
});
