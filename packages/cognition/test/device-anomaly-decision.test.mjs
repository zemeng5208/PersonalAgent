import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DeviceAnomalyDecisionService,
  CognitionError,
} from '../dist/index.js';

function createMockLayaChoiceInference(preferredChoiceIndex = 0) {
  const calls = [];
  const inference = {
    async infer(payload) {
      calls.push(payload);
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
    assert.notEqual(cand.tool?.name, 'process:kill');
    assert.notEqual(cand.tool?.name, 'fs:delete');
  }
});

test('DeviceAnomalyDecisionService applies cooldown suppression during sustained alerts', async () => {
  const inference = createMockLayaChoiceInference(1); // pick candidate 1 (defer_background_tasks)
  const service = new DeviceAnomalyDecisionService(inference, {
    cpuThresholdPercent: 90,
    memoryThresholdPercent: 90,
    recoveryThresholdPercent: 80,
    sustainedSampleCount: 2,
    cooldownMs: 60_000, // 60s cooldown
  });

  const baseTime = Date.parse('2026-09-29T14:00:00.000Z');

  // Trigger alert with 2 consecutive samples
  await service.evaluateSample({
    source: 'system:metrics',
    timestamp: new Date(baseTime).toISOString(),
    cpuPercent: 94,
    memoryPercent: 50,
    samplingIntervalMs: 5000,
  });
  const triggered = await service.evaluateSample({
    source: 'system:metrics',
    timestamp: new Date(baseTime + 5000).toISOString(),
    cpuPercent: 95,
    memoryPercent: 52,
    samplingIntervalMs: 5000,
  });
  assert.equal(triggered.status, 'alert_triggered');
  assert.equal(triggered.selectedCandidate?.id, 'defer_background_tasks');
  assert.equal(inference.calls.length, 1);

  // Sample 3 arrives at +10s (still within 60s cooldown) -> suppressed
  const suppressed = await service.evaluateSample({
    source: 'system:metrics',
    timestamp: new Date(baseTime + 10000).toISOString(),
    cpuPercent: 93,
    memoryPercent: 55,
    samplingIntervalMs: 5000,
  });
  assert.equal(suppressed.status, 'cooldown_suppressed');
  assert.equal(suppressed.isAlertActive, true);
  assert.equal(inference.calls.length, 1); // No new Laya inference
});

test('DeviceAnomalyDecisionService applies hysteresis recovery and clears alert', async () => {
  const inference = createMockLayaChoiceInference(0);
  const service = new DeviceAnomalyDecisionService(inference, {
    cpuThresholdPercent: 90,
    memoryThresholdPercent: 90,
    recoveryThresholdPercent: 80,
    sustainedSampleCount: 1,
    cooldownMs: 60_000,
  });

  const baseTime = Date.parse('2026-09-29T15:00:00.000Z');

  // 1. Trigger alert
  const alertRes = await service.evaluateSample({
    source: 'system:metrics',
    timestamp: new Date(baseTime).toISOString(),
    cpuPercent: 95,
    memoryPercent: 70,
    samplingIntervalMs: 5000,
  });
  assert.equal(alertRes.status, 'alert_triggered');
  assert.equal(alertRes.isAlertActive, true);

  // 2. Metric drops to 85% CPU (between recovery 80% and alarm 90%) -> Hysteresis holds
  const hystRes = await service.evaluateSample({
    source: 'system:metrics',
    timestamp: new Date(baseTime + 5000).toISOString(),
    cpuPercent: 85,
    memoryPercent: 70,
    samplingIntervalMs: 5000,
  });
  assert.equal(hystRes.status, 'alert_active_hysteresis');
  assert.equal(hystRes.isAlertActive, true);

  // 3. Metric drops to 75% CPU (< recovery 80%) -> Alert clears and recovers!
  const recRes = await service.evaluateSample({
    source: 'system:metrics',
    timestamp: new Date(baseTime + 10000).toISOString(),
    cpuPercent: 75,
    memoryPercent: 70,
    samplingIntervalMs: 5000,
  });
  assert.equal(recRes.status, 'recovered');
  assert.equal(recRes.isAlertActive, false);
  assert.equal(recRes.consecutiveElevatedCount, 0);

  // 4. Metric stays at 60% CPU -> Normal
  const normRes = await service.evaluateSample({
    source: 'system:metrics',
    timestamp: new Date(baseTime + 15000).toISOString(),
    cpuPercent: 60,
    memoryPercent: 60,
    samplingIntervalMs: 5000,
  });
  assert.equal(normRes.status, 'normal');
  assert.equal(normRes.isAlertActive, false);
});

test('DeviceAnomalyDecisionService handles replayed timestamps and validates options', async () => {
  const inference = createMockLayaChoiceInference(0);
  const service = new DeviceAnomalyDecisionService(inference);

  const t0 = '2026-09-29T16:00:00.000Z';
  await service.evaluateSample({
    source: 'system:metrics',
    timestamp: t0,
    cpuPercent: 50,
    memoryPercent: 50,
    samplingIntervalMs: 5000,
  });

  // Replay same timestamp
  const replay = await service.evaluateSample({
    source: 'system:metrics',
    timestamp: t0,
    cpuPercent: 50,
    memoryPercent: 50,
    samplingIntervalMs: 5000,
  });
  assert.equal(replay.status, 'replayed');

  // Invalid options: recoveryThreshold >= cpuThreshold
  assert.throws(
    () => new DeviceAnomalyDecisionService(inference, {
      cpuThresholdPercent: 85,
      recoveryThresholdPercent: 85,
    }),
    (err) => err instanceof CognitionError && err.code === 'INVALID_ARGUMENT'
  );
});
