import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DeviceAnomalyDecisionService,
  CognitionError,
} from '../dist/index.js';

test('queued device evaluation preserves submitted telemetry and request deadline', async () => {
  let release;
  const loading = new Promise(resolve => { release = resolve; });
  const checkpoint = {load: () => loading, save() {}};
  const service = new DeviceAnomalyDecisionService(createMockLayaChoiceInference(), {checkpoint});
  const sample = {source: 'synthetic', timestamp: new Date().toISOString(), cpuPercent: 10,
    memoryPercent: 20, samplingIntervalMs: 1000, unavailableMetrics: []};
  const expected = structuredClone(sample);
  const request = {deadline: new Date(Date.now() + 5000).toISOString(), signal: new AbortController().signal};
  const pending = service.evaluateSample(sample, request);
  sample.cpuPercent = 95;
  sample.unavailableMetrics.push('memory');
  request.deadline = new Date(Date.now() - 1000).toISOString();
  release(undefined);
  const receipt = await pending;
  assert.equal(receipt.status, 'normal');
  assert.deepEqual(receipt.sample, expected);
});

test('returned device receipts cannot rewrite later feedback or caller telemetry', async () => {
  let saved;
  const checkpoint = {load: () => saved, save: value => { saved = structuredClone(value); }};
  const service = new DeviceAnomalyDecisionService(createMockLayaChoiceInference(), {checkpoint});
  const sample = {source: 'synthetic', timestamp: new Date().toISOString(), cpuPercent: 10,
    memoryPercent: 20, samplingIntervalMs: 1000};
  const receipt = await service.evaluateSample(sample);
  const expected = structuredClone(receipt);
  receipt.status = 'alert_triggered';
  receipt.notificationDelivered = true;
  receipt.sample.cpuPercent = 99;
  assert.equal(sample.cpuPercent, 10);
  sample.memoryPercent = 99;
  assert.deepEqual((await service.readFeedback())[0].receipt, expected);
  assert.deepEqual(saved.sources.synthetic.lastReceipt, expected);
});

test('uncooperative device choices honor cancellation and deadline without blocking feedback', async () => {
  for (const interruption of ['cancel', 'deadline']) {
    const controller = new AbortController();
    let portSignal;
    let started;
    const entered = new Promise(resolve => { started = resolve; });
    let deliveries = 0;
    const service = new DeviceAnomalyDecisionService({choose({signal}) {
      portSignal = signal;
      started();
      return new Promise(() => {});
    }}, {sustainedSampleCount: 1, notificationPort: {sendAdvisoryNotification() {
      deliveries++;
      return {delivered: true};
    }}});
    const sample = {source: 'synthetic', timestamp: new Date().toISOString(), cpuPercent: 95,
      memoryPercent: 20, samplingIntervalMs: 1000};
    const pending = service.evaluateSample(sample, {
      deadline: new Date(Date.now() + (interruption === 'deadline' ? 30 : 5000)).toISOString(),
      signal: controller.signal,
    });
    await entered;
    if (interruption === 'cancel') controller.abort();
    let guard;
    try {
      const receipt = await Promise.race([pending,
        new Promise(resolve => { guard = setTimeout(() => resolve({status: 'unsettled'}), 300); })]);
      assert.equal(receipt.status, 'monitoring');
      assert.equal(portSignal.aborted, true);
      assert.equal(deliveries, 0);
      assert.equal((await service.readFeedback())[0].receipt.status, 'monitoring');
      assert.equal((await service.evaluateSample({...sample, cpuPercent: 10,
        timestamp: new Date(Date.parse(sample.timestamp) + 1000).toISOString()})).status, 'normal');
    } finally { clearTimeout(guard); }
  }
});

test('cancellation or deadline expiry during durable intent save prevents notification and preserves recovery', async () => {
  for (const mode of ['cancelled', 'deadline']) {
    let saved, saves = 0, deliveries = 0, entered, release, firstIntent, clock = Date.now();
    const started = new Promise(resolve => {entered = resolve;});
    const waiting = new Promise(resolve => {release = resolve;});
    const checkpoint = {load: () => saved, async save(value) {
      if (++saves === 1) {firstIntent = structuredClone(value); entered(); await waiting;}
      saved = structuredClone(value);
    }};
    const inference = createMockLayaChoiceInference(), controller = new AbortController();
    const options = {checkpoint, sustainedSampleCount: 1, now: () => clock,
      notificationPort: {sendAdvisoryNotification: () => {deliveries++; return {delivered: true};}}};
    const service = new DeviceAnomalyDecisionService(inference, options);
    const sample = {source: 'synthetic', timestamp: new Date(clock).toISOString(), cpuPercent: 95,
      memoryPercent: 50, samplingIntervalMs: 1000};
    const request = {signal: controller.signal, deadline: new Date(clock + 60_000).toISOString()};
    const pending = service.evaluateSample(sample, request);
    await started;
    assert.ok(firstIntent.sources.synthetic.pendingDelivery);
    assert.equal(deliveries, 0);
    if (mode === 'cancelled') controller.abort();
    else clock = Date.parse(request.deadline);
    release();
    const receipt = await pending;
    assert.equal(deliveries, 0, mode);
    assert.equal(receipt.status, 'monitoring', mode);
    assert.equal(receipt.notificationDelivered, false, mode);
    assert.equal(saved.sources.synthetic.pendingDelivery, undefined);
    assert.equal(saved.sources.synthetic.lastAlertTimestampMs, null);
    const restarted = new DeviceAnomalyDecisionService(inference, options);
    const feedback = (await restarted.readFeedback())[0];
    assert.equal(feedback.pendingDeliveryId, undefined);
    assert.equal(feedback.receipt.status, 'monitoring');
    assert.equal((await restarted.evaluateSample(sample)).status, 'replayed');
    assert.equal(deliveries, 0);
    const fresh = {...sample, timestamp: new Date(Date.parse(sample.timestamp) + 1000).toISOString()};
    assert.equal((await restarted.evaluateSample(fresh)).notificationDelivered, true);
    assert.equal(deliveries, 1);
    assert.equal((await restarted.evaluateSample({...sample,
      timestamp: new Date(Date.parse(sample.timestamp) + 2000).toISOString()})).status, 'cooldown_suppressed');
    assert.equal(deliveries, 1);
  }
});

test('durable device feedback preserves cooldown and replay protection across restart', async () => {
  let saved;
  const checkpoint = {load: () => saved, save: value => {saved = structuredClone(value);}};
  let deliveries = 0;
  const inference = createMockLayaChoiceInference();
  const options = {checkpoint, sustainedSampleCount: 1,
    notificationPort: {sendAdvisoryNotification: () => {deliveries++; return {delivered: true};}}};
  const sample = {source: 'windows', timestamp: new Date().toISOString(), cpuPercent: 95,
    memoryPercent: 50, samplingIntervalMs: 5000};
  const first = await new DeviceAnomalyDecisionService(inference, options).evaluateSample(sample);
  assert.equal(first.notificationDelivered, true);
  const restarted = new DeviceAnomalyDecisionService(inference, options);
  assert.equal((await restarted.evaluateSample(sample)).status, 'replayed');
  assert.equal((await restarted.evaluateSample({...sample,
    timestamp: new Date(Date.parse(sample.timestamp) + 5000).toISOString()})).status, 'cooldown_suppressed');
  const feedback = await restarted.readFeedback();
  assert.equal(feedback[0].receipt.status, 'cooldown_suppressed');
  assert.equal(deliveries, 1);
  assert.equal(inference.calls.length, 1);
});

test('post-delivery checkpoint failure leaves a durable intent requiring reconciliation without resending', async () => {
  let saved, saves = 0, deliveries = 0;
  const checkpoint = {load: () => saved, save: value => {
    if (++saves === 2) throw Error('disk unavailable');
    saved = structuredClone(value);
  }};
  const inference = createMockLayaChoiceInference();
  const options = {checkpoint, sustainedSampleCount: 1, notificationPort: {
    sendAdvisoryNotification: () => {deliveries++; return {delivered: true};}}};
  const sample = {source: 'windows', timestamp: new Date().toISOString(), cpuPercent: 95,
    memoryPercent: 50, samplingIntervalMs: 5000};
  await assert.rejects(new DeviceAnomalyDecisionService(inference, options).evaluateSample(sample), /disk unavailable/);
  const restarted = new DeviceAnomalyDecisionService(inference, options);
  assert.equal((await restarted.evaluateSample(sample)).status, 'indeterminate');
  assert.equal(deliveries, 1);
  const pending = (await restarted.readFeedback())[0].pendingDeliveryId;
  await assert.rejects(restarted.reconcileDelivery('windows', 'wrong-id', true));
  await restarted.reconcileDelivery('windows', pending, true);
  assert.equal((await restarted.evaluateSample({...sample,
    timestamp: new Date(Date.parse(sample.timestamp) + 5000).toISOString()})).status, 'cooldown_suppressed');
  assert.equal(deliveries, 1);
});

test('review cannot send notifications and unknown telemetry breaks consecutive elevation', async () => {
  const inference = createMockLayaChoiceInference();
  let delivered = 0;
  const service = new DeviceAnomalyDecisionService({choose: async request => ({
    state: 'review', reason: 'uncertain', eligibleForRuntime: false, calibrated: false,
    scores: [], selected: {id: request.candidates[0].id, revision: 1}, receipt: {id: 'review'}})}, {
    sustainedSampleCount: 2, notificationPort: {sendAdvisoryNotification: () => {delivered++; return {delivered: true};}}});
  const sample = {source: 'windows', timestamp: new Date().toISOString(), cpuPercent: 95,
    memoryPercent: 50, samplingIntervalMs: 5000};
  const at = index => ({...sample, timestamp: new Date(Date.parse(sample.timestamp) + index * 5000).toISOString()});
  await service.evaluateSample(at(0));
  await service.evaluateSample({...at(1), unavailableMetrics: ['cpu', 'memory']});
  assert.equal((await service.evaluateSample(at(2))).consecutiveElevatedCount, 1);
  const review = await service.evaluateSample(at(3));
  assert.equal(review.notificationDelivered, false);
  assert.equal(delivered, 0);
});

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

test('DeviceAnomalyDecisionService: missing notificationPort does not claim delivery or lock cooldown', async () => {
  const inference = createMockLayaChoiceInference(0);
  const service = new DeviceAnomalyDecisionService(inference, {
    cpuThresholdPercent: 90,
    sustainedSampleCount: 1,
    cooldownMs: 60_000,
    // notificationPort explicitly omitted
  });

  const baseTime = Date.parse('2026-09-29T19:00:00.000Z');

  // Sample 1: Triggers alert without notificationPort
  const res1 = await service.evaluateSample({
    source: 'sys:metric-unconfigured',
    timestamp: new Date(baseTime).toISOString(),
    cpuPercent: 95,
    memoryPercent: 50,
    samplingIntervalMs: 5000,
  });
  assert.equal(res1.status, 'alert_triggered');
  assert.equal(res1.notificationDelivered, false);
  assert.match(res1.safeAdvice, /未配置通知端口/);

  // Sample 2 (5s later): Cooldown was NOT locked, so it triggers again!
  const res2 = await service.evaluateSample({
    source: 'sys:metric-unconfigured',
    timestamp: new Date(baseTime + 5000).toISOString(),
    cpuPercent: 95,
    memoryPercent: 50,
    samplingIntervalMs: 5000,
  });
  assert.equal(res2.status, 'alert_triggered');
  assert.equal(res2.notificationDelivered, false);
});
