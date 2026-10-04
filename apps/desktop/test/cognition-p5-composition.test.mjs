import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {FakeCoordinationStoreHost} from '@personal-agent/goals/store';
import {LayaTriageService} from '@personal-agent/cognition';
import {createCognitionP5Composition} from '../electron/cognition-p5-composition.js';
import {p5FixturePorts, inboxScope, inboxItem} from './helpers/p5-fixture.mjs';

test('P5 stop cancels direct classification; failed source state is visible and resume does not start shared weights', async t => {
  const root = fileURLToPath(new URL('../../../.cache/cognition-p5-test/', import.meta.url));
  await mkdir(root, {recursive: true});
  const userData = await mkdtemp(path.join(root, 'case-stop-'));
  t.after(() => rm(userData, {recursive: true, force: true}));
  const storeHost = new FakeCoordinationStoreHost();
  storeHost.provision('default');
  const application = {runtime: {bindCoordinationStore: ns => storeHost.bind(ns)}};
  let signal, entered, starts = 0;
  const waitEntered = new Promise(resolve => {entered = resolve;});
  const layaHost = {snapshot: () => ({state: 'stopped', ready: false}),
    start: () => {starts++;}, choose: () => {throw Error('not ready');},
    classify: async request => {
      signal = request.signal; entered();
      await new Promise(resolve => signal.addEventListener('abort', resolve, {once: true}));
      throw Error('private source text and absolute path must not reach snapshot');
    }};
  const composition = createCognitionP5Composition({...p5FixturePorts(),application, userData, layaHost});
  const operation = composition.triageMails([inboxItem('direct','hello')],inboxScope);
  await waitEntered;
  await composition.stop();
  assert.equal(signal.aborted, true);
  await assert.rejects(operation);
  assert.deepEqual(composition.snapshot().failures, {mail: 'cancelled'});
  assert.equal(JSON.stringify(composition.snapshot()).includes('private source text'), false);
  await composition.start();
  assert.equal(starts, 0);
  assert.equal(composition.snapshot().modelReady, false);
  await composition.stop();
  await assert.rejects(composition.applyMeetingProposal({eventId: 'x', source: 'calendar'}), /not running/);
});

function createMockLayaInference(preferredIndex = 0) {
  return {
    async infer(payload) {
      if (payload.questions?.action) {
        const question = payload.questions.action;
        const keys = Object.keys(question.criteria ?? {});
        const choice = keys[preferredIndex] ?? keys[0];
        const probs = {};
        for (const k of keys) {
          probs[k] = k === choice ? 0.8 : Number(((0.2 / (keys.length - 1))).toFixed(4));
        }
        return {
          answers: {
            action: {
              choice,
              probabilities: probs,
              answer_confidence: 0.8,
              confidence: 0.7,
            },
          },
        };
      }
      if (payload.questions?.category_0) {
        const catKeys = Object.keys(payload.questions.category_0.criteria);
        const catProbs = {};
        for (const k of catKeys) {
          catProbs[k] = k === 'work' ? 0.85 : Number(((0.15 / (catKeys.length - 1))).toFixed(4));
        }
        return {
          answers: {
            category_0: {
              choice: 'work',
              probabilities: catProbs,
              answer_confidence: 0.85,
              confidence: 0.75,
            },
            impact_0: {
              choice: 'routine',
              probabilities: {routine: 0.90, high_impact: 0.10},
              answer_confidence: 0.90,
              confidence: 0.80,
            },
          },
        };
      }
      return {answers: {}};
    },
  };
}

test('cognition-p5-composition: wires host KV, reviewed-Fact boundary, mail pipeline and device anomaly', async t => {
  const root = fileURLToPath(new URL('../../../.cache/cognition-p5-test/', import.meta.url));
  await mkdir(root, {recursive: true});
  const userData = await mkdtemp(path.join(root, 'case-'));

  t.after(async () => {
    await rm(userData, {recursive: true, force: true});
  });

  const storeHost = new FakeCoordinationStoreHost();
  const graphNamespace = 'test-p5-desktop';
  const store = storeHost.provision(graphNamespace);

  // Seed meeting
  store.append(0, {
    id: 'meeting-p5-1',
    kind: 'fact',
    summary: '周四下午 15:00 架构评审会',
    sourceRef: 'calendar:work',
    sensitivity: 'private',
    state: 'active',
    validFrom: '2026-09-29T10:00:00.000Z',
    validUntil: '2026-09-30T00:00:00.000Z',
    reason: '初始日程',
    dependencies: [],
  });

  const application = {
    runtime: {
      bindCoordinationStore: ns => storeHost.bind(ns),
    },
  };

  const mockInference = createMockLayaInference(0);
  let policyAllowed = true;
  let notificationDelivered = true;

  const composition = createCognitionP5Composition({
    ...p5FixturePorts(),
    application,
    userData,
    namespace: graphNamespace,
    inference: mockInference,
    policyEvaluator: {
      evaluateExecution: () => ({
        allowed: policyAllowed,
        reason: policyAllowed ? 'OK' : 'Policy rejected',
      }),
    },
    notificationPort: {
      sendAdvisoryNotification: async () => ({delivered: notificationDelivered}),
    },
  });

  const snap = composition.snapshot();
  assert.equal(snap.hasMeetingCoordinator, false);
  assert.equal(snap.hasMailPipeline, true);
  assert.equal(snap.hasDeviceAnomalyService, true);

  // 1. Process Meeting Reschedule
  const event = {
    eventId: 'evt-p5-test-1',
    source: 'calendar:work',
    meetingFactId: 'meeting-p5-1',
    originalSummary: '周四下午 15:00 架构评审会',
    newSummary: '周四下午 16:30 架构评审会',
    sourceRevision: 'v-1',
    detectedAt: '2026-09-29T11:00:00.000Z',
    deadline: new Date(Date.now() + 60_000).toISOString(),
    signal: new AbortController().signal,
  };

  const meetingReceipt = await composition.processMeetingEvent(event);
  assert.equal(meetingReceipt.status, 'requires_review');
  assert.equal(store.read().revision, 1);

  // Receipt is in the injected host KV, with no legacy receipt file.
  const receiptFromDisk = await composition.getMeetingReceipt('evt-p5-test-1', 'calendar:work');
  assert.ok(receiptFromDisk);
  assert.equal(receiptFromDisk.status, 'requires_review');
  assert.equal(composition.snapshot().persistence,'runtime_sqlite');
  assert.equal(existsSync(path.join(userData,'meeting-receipts')),false);

  // 2. Mail Triage Batch
  const mailSummary = await composition.triageMails([
    inboxItem('msg-p5-1','发件人：团队组织者\n主题：架构评审时间推迟确认'),
  ],inboxScope);
  assert.equal(mailSummary.summary.total, 1);
  assert.equal(mailSummary.classified, 1);

  // Classification stays in the injected inbox store, not the removed JSON path.
  const checkpointFile = path.join(userData, 'mail-triage-checkpoint.json');
  assert.equal(existsSync(checkpointFile), false);
  assert.equal(composition.mailPipeline.snapshot().total,1);

  // 3. Device Anomaly Evaluation
  const anomalyReceipt = await composition.evaluateDeviceSample({
    source: 'node:os',
    timestamp: new Date().toISOString(),
    cpuPercent: 95,
    memoryPercent: 50,
    samplingIntervalMs: 5000,
  });
  assert.equal(anomalyReceipt.status, 'monitoring'); // 1st elevated sample
});

test('cognition-p5-composition: missing review port does not mutate graph or create an unauthorized mail pipeline', async t => {
  const root = fileURLToPath(new URL('../../../.cache/cognition-p5-test/', import.meta.url));
  await mkdir(root, {recursive: true});
  const userData = await mkdtemp(path.join(root, 'case-unconfigured-'));

  t.after(async () => {
    await rm(userData, {recursive: true, force: true});
  });

  const storeHost = new FakeCoordinationStoreHost();
  const graphNamespace = 'test-p5-unconfigured';
  const store = storeHost.provision(graphNamespace);

  store.append(0, {
    id: 'meeting-p5-unconf',
    kind: 'fact',
    summary: '周五技术方案讨论',
    sourceRef: 'calendar:work',
    sensitivity: 'private',
    state: 'active',
    validFrom: '2026-09-29T10:00:00.000Z',
    validUntil: '2026-09-30T00:00:00.000Z',
    reason: '初始日程',
    dependencies: [],
  });

  const application = {
    runtime: {
      bindCoordinationStore: ns => storeHost.bind(ns),
    },
  };

  const mockInference = createMockLayaInference(0);

  // Explicitly omit policyEvaluator and notificationPort
  const composition = createCognitionP5Composition({
    hostStateStorage:p5FixturePorts().hostStateStorage,
    application,
    userData,
    namespace: graphNamespace,
    inference: mockInference,
  });

  const snap = composition.snapshot();
  assert.equal(snap.hasExecutionPort, false);
  assert.equal(snap.hasPolicyEvaluator, false);
  assert.equal(snap.hasNotificationPort, false);

  // 1. Process Meeting Event: must produce proposal, NOT applied, and graph revision unchanged!
  const event = {
    eventId: 'evt-unconf-1',
    source: 'calendar:work',
    meetingFactId: 'meeting-p5-unconf',
    originalSummary: '周五技术方案讨论',
    newSummary: '周五技术方案讨论 (推迟至17:00)',
    sourceRevision: 'v-1',
    detectedAt: '2026-09-29T11:00:00.000Z',
    deadline: new Date(Date.now() + 60_000).toISOString(),
    signal: new AbortController().signal,
  };

  const meetingReceipt = await composition.processMeetingEvent(event);
  assert.equal(meetingReceipt.status, 'requires_review');
  assert.equal(store.read().revision, 1); // Graph untouched!

  // Classifier availability alone cannot authorize private mail consumption.
  assert.equal(composition.snapshot().hasMailPipeline,false);
  await assert.rejects(async () => {
    await composition.triageMails([
      {
        source: 'mail:work',
        messageId: 'msg-p5-corrupt',
        sourceRevision: 'rev-1',
        text: '发件人：测试\n主题：测试\n正文：测试',
      },
    ]);
  }, /Mail pipeline unavailable/);
});

test('cognition-p5-composition: integrates createLocalLayaHost public ports without .inference or key leakage', async t => {
  const root = fileURLToPath(new URL('../../../.cache/cognition-p5-test/', import.meta.url));
  await mkdir(root, {recursive: true});
  const userData = await mkdtemp(path.join(root, 'case-laya-host-'));

  t.after(async () => {
    await rm(userData, {recursive: true, force: true});
  });

  const storeHost = new FakeCoordinationStoreHost();
  const graphNamespace = 'test-p5-laya-host';
  const store = storeHost.provision(graphNamespace);

  store.append(0, {
    id: 'meeting-lh-1',
    kind: 'fact',
    summary: '周三产品评审会',
    sourceRef: 'calendar:work',
    sensitivity: 'private',
    state: 'active',
    validFrom: '2026-09-29T10:00:00.000Z',
    validUntil: '2026-09-30T00:00:00.000Z',
    reason: '初始日程',
    dependencies: [],
  });

  const application = {
    runtime: {
      bindCoordinationStore: ns => storeHost.bind(ns),
    },
  };

  // Mock matching createLocalLayaHost exactly: snapshot, start, stop, choose, classify. NO .inference.
  let chooseCalls = 0;
  let classifyCalls = 0;
  const mockLayaHost = {
    snapshot: () => ({state: 'ready', ready: true, localOnly: true}),
    async start() { return this.snapshot(); },
    async stop() { return {state: 'stopped', ready: false, localOnly: true}; },
    async choose(req) {
      chooseCalls++;
      const selected = req.candidates[0];
      return {
        state: 'selected',
        selected: {id: selected.id, revision: selected.revision},
        eligibleForRuntime: true,
        reason: 'selected',
        calibrated: false,
        scores: [{candidate: {id: selected.id, revision: selected.revision}, probability: 0.88}],
        answerConfidence: 0.88,
        entropyConcentration: 0.76,
        receipt: {
          id: `choice-rec-${chooseCalls}`,
          promptVersion: 'action-choice-v1',
          contextDigest: 'ctx',
          candidates: req.candidates.map(c => ({candidate: {id: c.id, revision: c.revision}, digest: c.argumentsDigest})),
        },
      };
    },
    async classify(req) {
      classifyCalls++;
      return new LayaTriageService(createMockLayaInference()).classify(req);
    },
  };

  assert.equal(mockLayaHost.inference, undefined);

  const composition = createCognitionP5Composition({
    application,
    userData,
    namespace: graphNamespace,
    layaHost: mockLayaHost,
    ...p5FixturePorts(),
    policyEvaluator: {
      evaluateExecution: () => ({allowed: true}),
    },
    notificationPort: {
      sendAdvisoryNotification: async () => ({delivered: true}),
    },
  });

  const snap = composition.snapshot();
  assert.equal(snap.hasMeetingCoordinator, false);
  assert.equal(snap.hasMailPipeline, true);
  assert.equal(snap.hasDeviceAnomalyService, true);
  assert.equal(snap.layaHostState, 'ready');

  // A chooser cannot impersonate the missing committed-Fact review port.
  const meetingReceipt = await composition.processMeetingEvent({
    eventId: 'evt-lh-1',
    source: 'calendar:work',
    meetingFactId: 'meeting-lh-1',
    originalSummary: '周三产品评审会',
    newSummary: '周三产品评审会 (提前至14:00)',
    sourceRevision: 'rev-lh-1',
    detectedAt: '2026-09-29T10:30:00.000Z',
    deadline: new Date(Date.now() + 60_000).toISOString(),
    signal: new AbortController().signal,
  });

  assert.equal(meetingReceipt.status, 'requires_review');
  assert.equal(chooseCalls, 0);

  // 2. Process Mail Batch via layaHost.classify
  const mailSummary = await composition.triageMails([
    inboxItem('msg-lh-1','发件人：PM\n主题：评审会议提前'),
  ],inboxScope);
  assert.equal(mailSummary.summary.total, 1);
  assert.equal(mailSummary.classified, 1);
  assert.equal(classifyCalls, 1);

  // 3. Process Device Anomaly via layaHost.choose
  // 3 consecutive elevated samples to trigger choose
  for (let i = 0; i < 3; i++) {
    await composition.evaluateDeviceSample({
      source: 'node:os',
      timestamp: new Date(Date.now() + i * 5000).toISOString(),
      cpuPercent: 95,
      memoryPercent: 40,
      samplingIntervalMs: 5000,
    });
  }
  assert.equal(chooseCalls, 1);
});

test('cognition-p5-composition: event consumption, lifecycle (stop/start/dispose), and subscription release', async t => {
  const root = fileURLToPath(new URL('../../../.cache/cognition-p5-test/', import.meta.url));
  await mkdir(root, {recursive: true});
  const userData = await mkdtemp(path.join(root, 'case-lifecycle-'));

  t.after(async () => {
    await rm(userData, {recursive: true, force: true});
  });

  const storeHost = new FakeCoordinationStoreHost();
  const graphNamespace = 'test-p5-lifecycle';
  const store = storeHost.provision(graphNamespace);

  store.append(0, {
    id: 'meeting-lc-1',
    kind: 'fact',
    summary: '周五周会',
    sourceRef: 'calendar:work',
    sensitivity: 'private',
    state: 'active',
    validFrom: '2026-09-29T10:00:00.000Z',
    validUntil: '2026-09-30T00:00:00.000Z',
    reason: '初始日程',
    dependencies: [],
  });

  const application = {
    runtime: {
      bindCoordinationStore: ns => storeHost.bind(ns),
    },
  };

  let chooseCount = 0;
  let projectionReads = 0;
  let classifyCount = 0;
  const mockLayaHost = {
    snapshot: () => ({state: 'ready', ready: true}),
    async start() { return this.snapshot(); },
    async stop() { return {state: 'stopped', ready: false}; },
    async choose(req) {
      chooseCount++;
      const selected = req.candidates[0];
      return {
        state: 'selected',
        selected: {id: selected.id, revision: selected.revision},
        eligibleForRuntime: true,
        reason: 'selected',
        calibrated: false,
        scores: [{candidate: {id: selected.id, revision: selected.revision}, probability: 0.9}],
        answerConfidence: 0.9,
        entropyConcentration: 0.8,
        receipt: {
          id: `lc-choice-${chooseCount}`,
          promptVersion: 'action-choice-v1',
          contextDigest: 'ctx',
          candidates: req.candidates.map(c => ({candidate: {id: c.id, revision: c.revision}, digest: c.argumentsDigest})),
        },
      };
    },
    async classify(req) {
      classifyCount++;
      return new LayaTriageService(createMockLayaInference()).classify(req);
    },
  };

  const composition = createCognitionP5Composition({
    application,
    userData,
    namespace: graphNamespace,
    layaHost: mockLayaHost,
    ...p5FixturePorts(),
    reviewedRepair:{readCommittedProjection:async()=>{projectionReads++;return undefined;}},
    policyEvaluator: {
      evaluateExecution: () => ({allowed: true}),
    },
    notificationPort: {
      sendAdvisoryNotification: async () => ({delivered: true}),
    },
  });

  // Initial state is running (autoStart = true)
  assert.equal(composition.snapshot().state, 'running');
  assert.equal(composition.snapshot().ready, true);

  // Setup mock event sources with EventEmitter style
  class MockSource {
    constructor() { this.listeners = new Map(); }
    on(event, fn) {
      if (!this.listeners.has(event)) this.listeners.set(event, new Set());
      this.listeners.get(event).add(fn);
    }
    off(event, fn) { this.listeners.get(event)?.delete(fn); }
    emit(event, data) {
      for (const fn of Array.from(this.listeners.get(event) ?? [])) fn(data);
    }
    listenerCount(event) { return this.listeners.get(event)?.size ?? 0; }
  }

  const calendarSource = new MockSource();
  const mailSource = new MockSource();
  const deviceSource = new MockSource();

  // 1. Bind sources
  const calSub = composition.bindCalendarSource(calendarSource);
  const mailSub = composition.bindMailSource(mailSource);
  const devSub = composition.bindDeviceTelemetrySource(deviceSource);

  assert.equal(composition.snapshot().activeSubscriptionCount, 3);
  assert.equal(calendarSource.listenerCount('reschedule'), 1);
  assert.equal(mailSource.listenerCount('page'), 1);
  assert.equal(deviceSource.listenerCount('sample'), 1);

  // 2. Emit calendar event while running -> consumed
  calendarSource.emit('reschedule', {
    eventId: 'evt-lc-run-1',
    source: 'calendar:work',
    meetingFactId: 'meeting-lc-1',
    originalSummary: '周五周会',
    newSummary: '周五周会 (调整至10:00)',
    sourceRevision: 'r1',
    detectedAt: '2026-09-29T10:00:00.000Z',
    deadline: new Date(Date.now() + 60_000).toISOString(),
    signal: new AbortController().signal,
  });

  // Wait a microtask tick for async handler
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(projectionReads, 1);
  assert.equal(chooseCount, 0);

  // 3. Stop composition -> incoming events are NOT consumed, and direct calls reject
  await composition.stop();
  assert.equal(composition.snapshot().state, 'stopped');
  assert.equal(composition.snapshot().ready, false);

  calendarSource.emit('reschedule', {
    eventId: 'evt-lc-stopped',
    source: 'calendar:work',
    meetingFactId: 'meeting-lc-1',
    originalSummary: '周五周会 (调整至10:00)',
    newSummary: '周五周会 (调整至11:00)',
    sourceRevision: 'r2',
    detectedAt: '2026-09-29T10:00:00.000Z',
    deadline: new Date(Date.now() + 60_000).toISOString(),
    signal: new AbortController().signal,
  });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(projectionReads, 1); // No new review while stopped.
  assert.equal(chooseCount, 0);

  await assert.rejects(async () => {
    await composition.processMeetingEvent({
      eventId: 'evt-direct-stopped',
      source: 'calendar:work',
      meetingFactId: 'meeting-lc-1',
      originalSummary: '周五周会',
      newSummary: '周五周会',
      sourceRevision: 'r3',
      detectedAt: '2026-09-29T10:00:00.000Z',
      deadline: new Date(Date.now() + 60_000).toISOString(),
      signal: new AbortController().signal,
    });
  }, /Cognition P5 composition is not running \(state: stopped\)/);

  // 4. Repeated start ("重复启动") -> consumption resumes
  await composition.start();
  assert.equal(composition.snapshot().state, 'running');
  assert.equal(composition.snapshot().ready, true);

  // Emit mail event -> consumed
  mailSource.emit('page', {...inboxScope,items:[inboxItem('msg-resumed-1','发件人：测试\n主题：恢复运行后的邮件')]});
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(classifyCount, 1);
  assert.equal(composition.mailPipeline.snapshot().total,1);
  assert.deepEqual(composition.snapshot().failures,{});

  // 5. Unsubscribe single source (calSub)
  calSub.unsubscribe();
  assert.equal(composition.snapshot().activeSubscriptionCount, 2);
  assert.equal(calendarSource.listenerCount('reschedule'), 0);

  // 6. Dispose composition -> all remaining subscriptions released, state becomes disposed
  composition.dispose();
  assert.equal(composition.snapshot().state, 'disposed');
  assert.equal(composition.snapshot().ready, false);
  assert.equal(composition.snapshot().activeSubscriptionCount, 0);
  assert.equal(mailSource.listenerCount('page'), 0);
  assert.equal(deviceSource.listenerCount('sample'), 0);

  // Subsequent calls throw
  await assert.rejects(async () => {
    await composition.start();
  }, /Cognition P5 composition has been disposed/);

  await assert.rejects(async () => {
    await composition.triageMails([]);
  }, /Cognition P5 composition has been disposed/);

  await assert.rejects(async () => {
    await composition.evaluateDeviceSample({
      source: 'node:os',
      timestamp: new Date().toISOString(),
      cpuPercent: 50,
      memoryPercent: 50,
      samplingIntervalMs: 5000,
    });
  }, /Cognition P5 composition has been disposed/);
});
