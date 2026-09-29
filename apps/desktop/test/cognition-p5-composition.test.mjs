import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {FakeCoordinationStoreHost} from '@personal-agent/goals/store';
import {createCognitionP5Composition} from '../electron/cognition-p5-composition.js';

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

test('cognition-p5-composition: wires durable stores, policy execution, mail pipeline and device anomaly', async t => {
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
  assert.equal(snap.hasMeetingCoordinator, true);
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
  assert.equal(meetingReceipt.status, 'applied');
  assert.equal(store.read().revision, 2);

  // Check file persisted in userData/meeting-receipts
  const receiptFromDisk = await composition.getMeetingReceipt('evt-p5-test-1', 'calendar:work');
  assert.ok(receiptFromDisk);
  assert.equal(receiptFromDisk.status, 'applied');

  // 2. Mail Triage Batch
  const mailSummary = await composition.triageMails([
    {
      source: 'mail:work',
      messageId: 'msg-p5-1',
      sourceRevision: 'rev-1',
      text: '发件人：团队组织者\n主题：架构评审时间推迟确认\n正文：请大家注意架构评审会议推迟。',
    },
  ]);
  assert.equal(mailSummary.total, 1);
  assert.equal(mailSummary.classifiedCount, 1);

  // Check file persisted in userData/mail-triage-checkpoint.json
  const checkpointFile = path.join(userData, 'mail-triage-checkpoint.json');
  assert.equal(existsSync(checkpointFile), true);
  const checkpoint = JSON.parse(readFileSync(checkpointFile, 'utf8'));
  assert.ok(Object.keys(checkpoint).length > 0);

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
