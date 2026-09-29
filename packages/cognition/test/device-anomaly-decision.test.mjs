import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DeviceAnomalyDecisionService,
  CognitionError,
} from '../dist/index.js';

function createMockLayaChoiceInference(preferredChoiceIndex = 0, shouldFail = false) {
  const calls = [];
  const inference = {
    async infer(payload) {
      calls.push(payload);
      if (shouldFail) throw new Error('inference_timeout');
      const question = payload.questions.action;
      const criteriaKeys = Object.keys(question?.criteria ?? {});
      const choiceKey = criteriaKeys[preferredChoiceIndex] ?? criteriaKeys[0];
      const probs = {};
      const remainingCount = Math.max(1, criteriaKeys.length - 1);
      const remainingProb = Number(((0.2 / remainingCount)).toFixed(4));
      let sum = 0;
      for (let i = 0; i < criteriaKeys.length; i++) {
        const k = criteriaKeys[i];
        if (k === choiceKey) {
          probs[k] = 0.8;
          sum += 0.8;
        } else if (i === criteriaKeys.length - 1 && choiceKey !== k) {
          probs[k] = Number((1.0 - sum).toFixed(4));
        } else {
          probs[k] = remainingProb;
          sum += remainingProb;
        }
      }
      return {
        answers: {
          action: {
            choice: choiceKey,
            probabilities: probs,
            answer_confidence: 0.8,
            confidence: 0.7,
          },
        },
      };
    },
    calls,
  };
  return inference;
}

test('DeviceAnomalyDecisionService requires sustained samples to confirm anomaly and avoids single-spike alerts', async () => {
  const inference = createMockLayaChoiceInference(0);
  const service = new DeviceAnomalyDecisionService(inference, {
    cpuThresholdPercent: 90,
    memoryThresholdPercent: 90,
    recoveryThresholdPercent: 80,
    sustainedSampleCount: 3,
    cooldownMs: 300_000,
  });

  const baseTime = Date.parse('2026-09-29T12:00:00.000Z');

  // Sample 1: Normal
  const res1 = await service.evaluateSample({
    source: 'system:metrics',
    timestamp: new Date(baseTime).toISOString(),
    cpuPercent: 35,
    memoryPercent: 60,
    samplingIntervalMs: 5000,
  });
  assert.equal(res1.status, 'normal');
  assert.equal(res1.isAlertActive, false);
  assert.equal(res1.consecutiveElevatedCount, 0);
  assert.equal(inference.calls.length, 0);

  // Sample 2: Isolated spike 1 (CPU 95%) -> monitoring
  const res2 = await service.evaluateSample({
    source: 'system:metrics',
    timestamp: new Date(baseTime + 5000).toISOString(),
    cpuPercent: 95,
    memoryPercent: 60,
    samplingIntervalMs: 5000,
  });
  assert.equal(res2.status, 'monitoring');
  assert.equal(res2.isAlertActive, false);
  assert.equal(res2.consecutiveElevatedCount, 1);
  assert.equal(inference.calls.length, 0);

  // Sample 3: Spike 2 (CPU 92%) -> monitoring
  const res3 = await service.evaluateSample({
    source: 'system:metrics',
    timestamp: new Date(baseTime + 10000).toISOString(),
    cpuPercent: 92,
    memoryPercent: 62,
    samplingIntervalMs: 5000,
  });
  assert.equal(res3.status, 'monitoring');
  assert.equal(res3.isAlertActive, false);
  assert.equal(res3.consecutiveElevatedCount, 2);
  assert.equal(inference.calls.length, 0);

  // Sample 4: Spike 3 (CPU 96%) -> Sustained anomaly triggered!
  const res4 = await service.evaluateSample({
    source: 'system:metrics',
    timestamp: new Date(baseTime + 15000).toISOString(),
    cpuPercent: 96,
    memoryPercent: 65,
    samplingIntervalMs: 5000,
  });
  assert.equal(res4.status, 'alert_triggered');
  assert.equal(res4.isAlertActive, true);
  assert.equal(res4.consecutiveElevatedCount, 3);
  assert.equal(inference.calls.length, 1);

  // Verify Laya selection
  assert.equal(res4.selection?.state, 'selected');
  assert.equal(res4.selectedCandidate?.id, 'remind_user_inspect');
  assert.ok(res4.safeAdvice.includes('桌面通知提醒用户检查资源占用情况'));

  // STRICT GUARDRAIL CHECK: Ensure no destructive operations
  for (const cand of res4.candidates) {
    assert.doesNotMatch(cand.description, /杀|终止|kill|delete|删除|关闭应用/i);
    assert.notEqual(cand.kind, 'tool'); // All are advisory non-tool candidates
  }
});

test('DeviceAnomalyDecisionService resets un-alerted consecutive count when sample drops into hysteresis band (95->85->95)', async () => {
  const inference = createMockLayaChoiceInference(0);
  const service = new DeviceAnomalyDecisionService(inference, {
    cpuThresholdPercent: 90,
    recoveryThresholdPercent: 80,
    sustainedSampleCount: 3,
  });

  const baseTime = Date.parse('2026-09-29T13:00:00.000Z');

  // 1: 95% -> count 1
  const r1 = await service.evaluateSample({
    source: 'node:os',
    timestamp: new Date(baseTime).toISOString(),
    cpuPercent: 95,
    memoryPercent: 50,
    samplingIntervalMs: 5000,
  });
  assert.equal(r1.consecutiveElevatedCount, 1);

  // 2: drops to 85% (hysteresis zone) -> resets un-alerted count to 0!
  const r2 = await service.evaluateSample({
    source: 'node:os',
    timestamp: new Date(baseTime + 5000).toISOString(),
    cpuPercent: 85,
    memoryPercent: 50,
    samplingIntervalMs: 5000,
  });
  assert.equal(r2.consecutiveElevatedCount, 0);

  // 3: 95% -> count 1
  const r3 = await service.evaluateSample({
    source: 'node:os',
    timestamp: new Date(baseTime + 10000).toISOString(),
    cpuPercent: 95,
    memoryPercent: 50,
    samplingIntervalMs: 5000,
  });
  assert.equal(r3.consecutiveElevatedCount, 1);

  // 4: drops to 85% -> resets to 0!
  const r4 = await service.evaluateSample({
    source: 'node:os',
    timestamp: new Date(baseTime + 15000).toISOString(),
    cpuPercent: 85,
    memoryPercent: 50,
    samplingIntervalMs: 5000,
  });
  assert.equal(r4.consecutiveElevatedCount, 0);

  // 5: 95% -> count 1 (NOT 3!)
  const r5 = await service.evaluateSample({
    source: 'node:os',
    timestamp: new Date(baseTime + 20000).toISOString(),
    cpuPercent: 95,
    memoryPercent: 50,
    samplingIntervalMs: 5000,
  });
  assert.equal(r5.consecutiveElevatedCount, 1);
  assert.equal(r5.status, 'monitoring'); // Still monitoring, did NOT trigger!
  assert.equal(inference.calls.length, 0);
});

test('DeviceAnomalyDecisionService resets count on sampling interval gap', async () => {
  const inference = createMockLayaChoiceInference(0);
  const service = new DeviceAnomalyDecisionService(inference, {
    cpuThresholdPercent: 90,
    sustainedSampleCount: 3,
  });

  const baseTime = Date.parse('2026-09-29T14:00:00.000Z');

  // Sample 1 at t=0
  await service.evaluateSample({
    source: 'metrics:local',
    timestamp: new Date(baseTime).toISOString(),
    cpuPercent: 95,
    memoryPercent: 50,
    samplingIntervalMs: 5000,
  });

  // Sample 2 arrives after 30 seconds (> 5000 * 2.5 = 12.5s gap) -> resets count!
  const r2 = await service.evaluateSample({
    source: 'metrics:local',
    timestamp: new Date(baseTime + 30000).toISOString(),
    cpuPercent: 95,
    memoryPercent: 50,
    samplingIntervalMs: 5000,
  });
  assert.equal(r2.consecutiveElevatedCount, 1); // Reset to 1 instead of accumulating to 2
});

test('DeviceAnomalyDecisionService isolates state per source', async () => {
  const inference = createMockLayaChoiceInference(0);
  const service = new DeviceAnomalyDecisionService(inference, {
    cpuThresholdPercent: 90,
    sustainedSampleCount: 2,
  });

  const t0 = new Date('2026-09-29T15:00:00.000Z').toISOString();

  // Source A: 1 sample
  const rA = await service.evaluateSample({
    source: 'host-A',
    timestamp: t0,
    cpuPercent: 95,
    memoryPercent: 50,
    samplingIntervalMs: 5000,
  });
  assert.equal(rA.consecutiveElevatedCount, 1);

  // Source B: 1 sample should have its own count = 1, NOT 2!
  const rB = await service.evaluateSample({
    source: 'host-B',
    timestamp: t0,
    cpuPercent: 95,
    memoryPercent: 50,
    samplingIntervalMs: 5000,
  });
  assert.equal(rB.consecutiveElevatedCount, 1);
  assert.equal(rB.status, 'monitoring');
});

test('DeviceAnomalyDecisionService handles unavailable metrics without false recovery', async () => {
  const inference = createMockLayaChoiceInference(0);
  const service = new DeviceAnomalyDecisionService(inference, {
    cpuThresholdPercent: 90,
    sustainedSampleCount: 1,
  });

  const baseTime = Date.parse('2026-09-29T16:00:00.000Z');

  // Trigger alert
  const triggered = await service.evaluateSample({
    source: 'agent:telemetry',
    timestamp: new Date(baseTime).toISOString(),
    cpuPercent: 95,
    memoryPercent: 70,
    samplingIntervalMs: 5000,
  });
  assert.equal(triggered.status, 'alert_triggered');
  assert.equal(triggered.isAlertActive, true);

  // Next sample: CPU and memory both unavailable -> status indeterminate, alert remains active!
  const indet = await service.evaluateSample({
    source: 'agent:telemetry',
    timestamp: new Date(baseTime + 5000).toISOString(),
    cpuPercent: 0,
    memoryPercent: 0,
    unavailableMetrics: ['cpu', 'memory'],
    samplingIntervalMs: 5000,
  });
  assert.equal(indet.status, 'indeterminate');
  assert.equal(indet.isAlertActive, true); // Did NOT false recover!
});

test('DeviceAnomalyDecisionService does not lock cooldown when inference fails', async () => {
  const failingInference = createMockLayaChoiceInference(0, true);
  const service = new DeviceAnomalyDecisionService(failingInference, {
    cpuThresholdPercent: 90,
    sustainedSampleCount: 1,
    cooldownMs: 60_000,
  });

  const baseTime = Date.parse('2026-09-29T17:00:00.000Z');

  // First sample attempts to alert, but inference throws
  const res1 = await service.evaluateSample({
    source: 'sys:metric',
    timestamp: new Date(baseTime).toISOString(),
    cpuPercent: 95,
    memoryPercent: 50,
    samplingIntervalMs: 5000,
  });
  assert.equal(res1.status, 'monitoring');
  assert.equal(res1.isAlertActive, false); // Alert not confirmed due to failure

  // Next sample arrives 5 seconds later: should NOT be suppressed by cooldown
  const res2 = await service.evaluateSample({
    source: 'sys:metric',
    timestamp: new Date(baseTime + 5000).toISOString(),
    cpuPercent: 95,
    memoryPercent: 50,
    samplingIntervalMs: 5000,
  });
  assert.notEqual(res2.status, 'cooldown_suppressed');
});

test('DeviceAnomalyDecisionService only locks cooldown when notification delivery is confirmed', async () => {
  const inference = createMockLayaChoiceInference(0);
  let shouldSucceed = false;
  const sentNotifications = [];

  const notificationPort = {
    async sendAdvisoryNotification(notif) {
      sentNotifications.push(notif);
      return { delivered: shouldSucceed };
    },
  };

  const service = new DeviceAnomalyDecisionService(inference, {
    cpuThresholdPercent: 90,
    sustainedSampleCount: 1,
    cooldownMs: 60_000,
    notificationPort,
  });

  const baseTime = Date.parse('2026-09-29T18:00:00.000Z');

  // Sample 1: Notification delivery FAILS
  const res1 = await service.evaluateSample({
    source: 'sys:metric',
    timestamp: new Date(baseTime).toISOString(),
    cpuPercent: 95,
    memoryPercent: 50,
    samplingIntervalMs: 5000,
  });
  assert.equal(res1.status, 'alert_triggered');
  assert.equal(res1.notificationDelivered, false);
  assert.match(res1.safeAdvice, /投递失败/);

  // Sample 2 (10s later): Since delivery failed, cooldown was NOT locked! It triggers again!
  const res2 = await service.evaluateSample({
    source: 'sys:metric',
    timestamp: new Date(baseTime + 10000).toISOString(),
    cpuPercent: 95,
    memoryPercent: 50,
    samplingIntervalMs: 5000,
  });
  assert.equal(res2.status, 'alert_triggered'); // NOT cooldown_suppressed!

  // Now enable successful delivery
  shouldSucceed = true;
  const res3 = await service.evaluateSample({
    source: 'sys:metric',
    timestamp: new Date(baseTime + 20000).toISOString(),
    cpuPercent: 95,
    memoryPercent: 50,
    samplingIntervalMs: 5000,
  });
  assert.equal(res3.status, 'alert_triggered');
  assert.equal(res3.notificationDelivered, true);

  // Sample 4 (5s after successful delivery): NOW it is cooldown_suppressed!
  const res4 = await service.evaluateSample({
    source: 'sys:metric',
    timestamp: new Date(baseTime + 25000).toISOString(),
    cpuPercent: 95,
    memoryPercent: 50,
    samplingIntervalMs: 5000,
  });
  assert.equal(res4.status, 'cooldown_suppressed');
});
