import path from 'node:path';
import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {
  MeetingRescheduleCoordinator,
  FileMeetingDecisionReceiptStore,
  createPolicyGuardedExecutionPort,
  MailTriagePipeline,
  DEFAULT_MAIL_LABELS,
  DeviceAnomalyDecisionService,
} from '@personal-agent/cognition';

/**
 * P5 exclusive desktop composition entry:
 * Assembles MeetingRescheduleCoordinator, MailTriagePipeline, and DeviceAnomalyDecisionService
 * with durable file-backed stores, policy-guarded execution, and confirmed notification delivery.
 */
export function createCognitionP5Composition({
  application,
  client,
  userData,
  namespace = 'default',
  inference,
  chooser,
  policyEvaluator,
  notificationPort,
  now = Date.now,
  onUpdate = () => {},
}) {
  if (!application?.runtime || !userData) {
    throw new Error('Invalid cognition P5 composition arguments');
  }

  const store = application.runtime.bindCoordinationStore(namespace);
  const receiptsDir = path.join(userData, 'meeting-receipts');
  mkdirSync(receiptsDir, {recursive: true});

  // 1. Durable meeting decision receipt store
  const receiptStore = new FileMeetingDecisionReceiptStore({storageDir: receiptsDir});

  // 2. Policy-guarded execution port: enforces policy checks before CAS appendBatch.
  // Requires explicit, trusted policyEvaluator. When missing, executionPort is undefined
  // and the coordinator outputs structured proposals (status: 'proposal') without mutating the graph.
  const executionPort = policyEvaluator ? createPolicyGuardedExecutionPort({
    store,
    policy: policyEvaluator,
    receiptStore,
    namespace,
    onExecuted: () => {
      try { onUpdate(); } catch {}
    },
  }) : undefined;

  // 3. Meeting Reschedule Coordinator
  const meetingInference = inference ?? chooser?.inference;
  const meetingCoordinator = meetingInference ? new MeetingRescheduleCoordinator({
    store,
    inference: meetingInference,
    executionPort,
    receiptStore,
    namespace,
    now,
  }) : undefined;

  // 4. Mail Triage Pipeline with durable file checkpoint
  const mailCheckpointFile = path.join(userData, 'mail-triage-checkpoint.json');
  const mailCheckpointPort = {
    load() {
      if (!existsSync(mailCheckpointFile)) return {};
      try {
        return JSON.parse(readFileSync(mailCheckpointFile, 'utf8'));
      } catch (err) {
        throw new Error(`Mail triage checkpoint file corrupt or unavailable (${mailCheckpointFile}): ${err.message}`);
      }
    },
    save(results) {
      mkdirSync(userData, {recursive: true});
      const tmp = `${mailCheckpointFile}.tmp-${process.pid}-${Date.now()}`;
      writeFileSync(tmp, JSON.stringify(results, null, 2), 'utf8');
      renameSync(tmp, mailCheckpointFile);
    },
  };

  const mailPipeline = meetingInference ? new MailTriagePipeline({
    inference: meetingInference,
    checkpoint: mailCheckpointPort,
    labels: DEFAULT_MAIL_LABELS,
    now,
  }) : undefined;

  // 5. Device Anomaly Decision Service with confirmed delivery.
  // When notificationPort is missing, alerts do not claim delivery or lock cooldown.
  const deviceAnomalyService = meetingInference ? new DeviceAnomalyDecisionService(meetingInference, {
    cpuThresholdPercent: 90,
    memoryThresholdPercent: 90,
    recoveryThresholdPercent: 80,
    sustainedSampleCount: 3,
    cooldownMs: 300_000,
    notificationPort,
    now,
  }) : undefined;

  return {
    get receiptStore() { return receiptStore; },
    get executionPort() { return executionPort; },
    get meetingCoordinator() { return meetingCoordinator; },
    get mailPipeline() { return mailPipeline; },
    get deviceAnomalyService() { return deviceAnomalyService; },

    snapshot() {
      return {
        hasMeetingCoordinator: Boolean(meetingCoordinator),
        hasMailPipeline: Boolean(mailPipeline),
        hasDeviceAnomalyService: Boolean(deviceAnomalyService),
        hasExecutionPort: Boolean(executionPort),
        hasPolicyEvaluator: Boolean(policyEvaluator),
        hasNotificationPort: Boolean(notificationPort),
        namespace,
      };
    },

    async processMeetingEvent(event) {
      if (!meetingCoordinator) throw new Error('Meeting coordinator unavailable: Laya inference not connected');
      return meetingCoordinator.processEvent(event);
    },

    async applyMeetingProposal(query, options) {
      if (!meetingCoordinator) throw new Error('Meeting coordinator unavailable: Laya inference not connected');
      return meetingCoordinator.applyApprovedProposal(query, options);
    },

    async getMeetingReceipt(eventId, source) {
      if (!meetingCoordinator) return undefined;
      return meetingCoordinator.getReceipt(eventId, source);
    },

    async triageMails(messages, options = {}) {
      if (!mailPipeline) throw new Error('Mail pipeline unavailable: Laya inference not connected');
      const deadline = options.deadline ?? new Date(now() + 60_000).toISOString();
      const signal = options.signal ?? new AbortController().signal;
      return mailPipeline.processBatch({messages, deadline, signal});
    },

    async evaluateDeviceSample(sample, layaRequest) {
      if (!deviceAnomalyService) throw new Error('Device anomaly service unavailable: Laya inference not connected');
      return deviceAnomalyService.evaluateSample(sample, layaRequest);
    },

    async getPendingProposals() {
      if (!meetingCoordinator) return [];
      const proposals = await meetingCoordinator.listReceipts({status: 'proposal'});
      const reviews = await meetingCoordinator.listReceipts({status: 'requires_review'});
      return [...proposals, ...reviews];
    },

    async listMeetingReceipts(filter) {
      if (!meetingCoordinator) return [];
      return meetingCoordinator.listReceipts(filter);
    },

    dispose() {
      // Clean up any composition listeners or resources
    },
  };
}
