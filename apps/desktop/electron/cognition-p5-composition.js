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
import {createCalendarMeetingSource} from './p5-calendar-meeting-source.js';
import {createP5RuntimeCheckpoints} from './p5-runtime-checkpoints.js';

/**
 * Register a listener on an event source, supporting:
 * 1. source.subscribe(handler) returning unsubscribe fn or { unsubscribe }
 * 2. source.on(eventName, handler) / source.off(eventName, handler)
 * 3. source.addListener(eventName, handler) / source.removeListener(eventName, handler)
 */
function registerSourceListener(source, eventNames, handler) {
  if (!source) throw new Error('Cannot bind null or undefined source');
  let unbind;
  if (typeof source.subscribe === 'function') {
    const res = source.subscribe(handler);
    if (typeof res === 'function') {
      unbind = res;
    } else if (res && typeof res.unsubscribe === 'function') {
      unbind = () => res.unsubscribe();
    }
  }
  if (!unbind) {
    const names = Array.isArray(eventNames) ? eventNames : [eventNames];
    for (const name of names) {
      if (typeof source.on === 'function') {
        source.on(name, handler);
        unbind = () => {
          if (typeof source.off === 'function') source.off(name, handler);
          else if (typeof source.removeListener === 'function') source.removeListener(name, handler);
        };
        break;
      } else if (typeof source.addListener === 'function') {
        source.addListener(name, handler);
        unbind = () => {
          if (typeof source.removeListener === 'function') source.removeListener(name, handler);
        };
        break;
      }
    }
  }
  if (!unbind) {
    throw new Error('Unsupported event source interface: missing subscribe, on, or addListener');
  }
  return unbind;
}

/**
 * Creates an idempotent subscription handle callable as fn or via .unsubscribe().
 */
function createSubscriptionHandle(unbind, activeSubscriptions) {
  let released = false;
  const unsubscribe = () => {
    if (released) return;
    released = true;
    activeSubscriptions.delete(unsubscribe);
    try { unbind(); } catch {}
  };
  unsubscribe.unsubscribe = unsubscribe;
  activeSubscriptions.add(unsubscribe);
  return unsubscribe;
}

/**
 * P5 exclusive desktop composition entry:
 * Assembles MeetingRescheduleCoordinator, MailTriagePipeline, and DeviceAnomalyDecisionService
 * with existing Runtime SQLite checkpoints (legacy files for explicit minimal test hosts),
 * an injected execution port, and confirmed notification delivery.
 * Reuses existing local Laya model host via public ports (.choose, .classify) without spawning second processes.
 */
export function createCognitionP5Composition({
  application,
  client,
  userData,
  namespace = 'default',
  layaHost,
  inference,
  chooser,
  classifier,
  policyEvaluator,
  meetingExecutionPort,
  notificationPort,
  calendarReadPort,
  autoStart = true,
  now = Date.now,
  onUpdate = () => {},
}) {
  if (!application?.runtime || !userData) {
    throw new Error('Invalid cognition P5 composition arguments');
  }

  const store = application.runtime.bindCoordinationStore(namespace);
  const receiptsDir = path.join(userData, 'meeting-receipts');
  mkdirSync(receiptsDir, {recursive: true});

  // 1. Production state shares the existing TaskRuntime SQLite and namespace.
  // Minimal offline hosts without checkpoint APIs retain the explicit legacy file ports.
  const runtimeCheckpoints = typeof application.createHostStateStore === 'function'
    ? createP5RuntimeCheckpoints({storage: application.createHostStateStore('proactive-receipts'), namespace, userData}) : undefined;
  const receiptStore = runtimeCheckpoints?.meetings ?? new FileMeetingDecisionReceiptStore({storageDir: receiptsDir});

  // 2. Production composition injects its Runtime/Policy/ToolGateway execution port.
  // The older policyEvaluator port is compatibility for isolated domain callers;
  // its direct CAS is not production execution Evidence. With neither, emit a proposal.
  const executionPort = meetingExecutionPort ?? (policyEvaluator ? createPolicyGuardedExecutionPort({
    store,
    policy: policyEvaluator,
    receiptStore,
    namespace,
    onExecuted: () => {
      try { onUpdate(); } catch {}
    },
  }) : undefined);

  // 3. Resolve chooser & classifier ports directly from layaHost or explicit arguments
  // Public port reuse: consumes layaHost.choose and layaHost.classify without reading private closures or exposing keys
  const resolvedChooser = chooser
    ?? (layaHost && typeof layaHost.choose === 'function' ? { choose: req => layaHost.choose(req) } : undefined);
  const resolvedClassifier = classifier
    ?? (layaHost && typeof layaHost.classify === 'function' ? { classify: req => layaHost.classify(req) } : undefined);

  // 4. Meeting Reschedule Coordinator
  const meetingCoordinator = (resolvedChooser || inference) ? new MeetingRescheduleCoordinator({
    store,
    ...(resolvedChooser ? { chooser: resolvedChooser } : { inference }),
    executionPort,
    receiptStore,
    namespace,
    now,
  }) : undefined;

  // 5. Mail Triage Pipeline with durable file checkpoint
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

  const mailPipeline = (resolvedClassifier || inference) ? new MailTriagePipeline({
    ...(resolvedClassifier ? { classifier: resolvedClassifier } : { inference }),
    checkpoint: mailCheckpointPort,
    labels: DEFAULT_MAIL_LABELS,
    now,
  }) : undefined;

  // 6. Device Anomaly Decision Service with confirmed delivery
  const anomalyChooser = resolvedChooser ?? inference;
  const deviceCheckpointFile = path.join(userData, 'device-anomaly-checkpoint.json');
  const deviceCheckpoint = {
    load() {
      if (!existsSync(deviceCheckpointFile)) return undefined;
      return JSON.parse(readFileSync(deviceCheckpointFile, 'utf8'));
    },
    save(value) {
      mkdirSync(userData, {recursive: true});
      const tmp = `${deviceCheckpointFile}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(value), 'utf8');
      renameSync(tmp, deviceCheckpointFile);
    },
  };
  const deviceAnomalyService = anomalyChooser ? new DeviceAnomalyDecisionService(anomalyChooser, {
    cpuThresholdPercent: 90,
    memoryThresholdPercent: 90,
    recoveryThresholdPercent: 80,
    sustainedSampleCount: 3,
    cooldownMs: 300_000,
    notificationPort,
    checkpoint: runtimeCheckpoints?.device ?? deviceCheckpoint,
    now,
  }) : undefined;

  // Lifecycle state: 'idle' | 'running' | 'stopped' | 'disposed'
  let state = autoStart ? 'running' : 'idle';
  const activeSubscriptions = new Set();
  const activeControllers = new Set();
  const failures = {};

  const publish = () => {
    try { onUpdate(); } catch {}
  };
  const tracked = async (chain, options, operation) => {
    if (state !== 'running') throw new Error(`Cognition P5 composition is not running (state: ${state})`);
    const controller = new AbortController();
    activeControllers.add(controller);
    let signal = controller.signal;
    try {
      if (options?.signal) signal = AbortSignal.any([options.signal, controller.signal]);
      const result = await operation({...options, signal,
        deadline: options?.deadline ?? new Date(now() + 60_000).toISOString()});
      delete failures[chain];
      return result;
    } catch (error) {
      // Source text, credentials and absolute storage paths are not UI errors.
      failures[chain] = signal.aborted ? 'cancelled'
        : layaHost && layaHost.snapshot?.()?.ready !== true ? 'model_unavailable' : 'processing_failed';
      throw error;
    } finally {
      activeControllers.delete(controller);
      publish();
    }
  };

  // Trusted host ports only; missing source/baseline wiring remains unavailable.
  const calendarMeetingSource = meetingCoordinator && calendarReadPort ? createCalendarMeetingSource({
    readCurrent: calendarReadPort.readCurrent,
    readBaseline: calendarReadPort.readBaseline,
    processMeetingEvent: event => meetingCoordinator.processEvent(event),
    now,
    onUpdate: publish,
  }) : undefined;

  const instance = {
    get receiptStore() { return receiptStore; },
    get executionPort() { return executionPort; },
    get meetingCoordinator() { return meetingCoordinator; },
    get mailPipeline() { return mailPipeline; },
    get deviceAnomalyService() { return deviceAnomalyService; },

    snapshot() {
      return {
        state,
        ready: state === 'running',
        activeSubscriptionCount: activeSubscriptions.size,
        hasMeetingCoordinator: Boolean(meetingCoordinator),
        hasCalendarMeetingSource: Boolean(calendarMeetingSource),
        calendarSource: calendarMeetingSource?.snapshot() ?? {status: 'unavailable', calendarWriteVerified: false},
        hasMailPipeline: Boolean(mailPipeline),
        hasDeviceAnomalyService: Boolean(deviceAnomalyService),
        hasExecutionPort: Boolean(executionPort),
        hasPolicyEvaluator: Boolean(policyEvaluator),
        persistence: runtimeCheckpoints?.persistence ?? 'legacy_files',
        hasNotificationPort: Boolean(notificationPort),
        layaHostState: layaHost?.snapshot?.()?.state ?? null,
        modelReady: layaHost ? layaHost.snapshot?.()?.ready === true : Boolean(inference || chooser || classifier),
        failures: {...failures},
        namespace,
      };
    },

    async start() {
      if (state === 'disposed') throw new Error('Cognition P5 composition has been disposed');
      if (state === 'running') return this.snapshot();
      // The shared model owner controls start/stop. Resuming P5 subscriptions
      // must not load weights or restart a model the user explicitly stopped.
      state = 'running';
      publish();
      return this.snapshot();
    },

    async stop() {
      if (state === 'disposed') return this.snapshot();
      if (state === 'stopped') return this.snapshot();
      state = 'stopped';
      for (const ac of Array.from(activeControllers)) {
        try { ac.abort(); } catch {}
      }
      activeControllers.clear();
      publish();
      return this.snapshot();
    },

    dispose() {
      if (state === 'disposed') return;
      state = 'disposed';
      for (const sub of Array.from(activeSubscriptions)) {
        try { sub.unsubscribe(); } catch {}
      }
      activeSubscriptions.clear();
      for (const ac of Array.from(activeControllers)) {
        try { ac.abort(); } catch {}
      }
      activeControllers.clear();
      publish();
    },

    bindCalendarSource(calendarSource) {
      if (state === 'disposed') throw new Error('Cognition P5 composition has been disposed');
      if (!meetingCoordinator) throw new Error('Meeting coordinator unavailable: Laya inference/chooser not connected');

      const unbind = registerSourceListener(calendarSource, ['reschedule', 'meeting_reschedule', 'event'], async (event) => {
        if (state !== 'running') return;
        try {
          await instance.processMeetingEvent(event);
        } catch {
          // Isolate listener failure to protect source loop
        }
      });

      return createSubscriptionHandle(unbind, activeSubscriptions);
    },

    bindMailSource(mailSource) {
      if (state === 'disposed') throw new Error('Cognition P5 composition has been disposed');
      if (!mailPipeline) throw new Error('Mail pipeline unavailable: Laya inference/classifier not connected');

      const unbind = registerSourceListener(mailSource, ['batch', 'mails', 'mail_batch'], async (batchOrMessages) => {
        if (state !== 'running') return;
        const messages = Array.isArray(batchOrMessages)
          ? batchOrMessages
          : (batchOrMessages?.messages ?? [batchOrMessages]);
        if (!Array.isArray(messages) || messages.length === 0) return;
        try {
          await instance.triageMails(messages);
        } catch {
          // Isolate listener failure
        }
      });

      return createSubscriptionHandle(unbind, activeSubscriptions);
    },

    bindDeviceTelemetrySource(telemetrySource) {
      if (state === 'disposed') throw new Error('Cognition P5 composition has been disposed');
      if (!deviceAnomalyService) throw new Error('Device anomaly service unavailable: Laya inference/chooser not connected');

      const unbind = registerSourceListener(telemetrySource, ['sample', 'telemetry', 'metric'], async (sample) => {
        if (state !== 'running') return;
        if (!sample) return;
        try {
          await instance.evaluateDeviceSample(sample);
        } catch {
          // Isolate listener failure
        }
      });

      return createSubscriptionHandle(unbind, activeSubscriptions);
    },

    async processMeetingEvent(event) {
      if (state === 'disposed') throw new Error('Cognition P5 composition has been disposed');
      if (state !== 'running') throw new Error(`Cognition P5 composition is not running (state: ${state})`);
      if (!meetingCoordinator) throw new Error('Meeting coordinator unavailable: Laya inference/chooser not connected');
      return tracked('meeting', event, context => meetingCoordinator.processEvent({...event, ...context}));
    },

    async refreshCalendarMeeting(binding, options = {}) {
      if (!calendarMeetingSource) throw new Error('Calendar source or durable baseline unavailable');
      return tracked('meeting', options, context => calendarMeetingSource.refresh(binding, context));
    },

    async applyMeetingProposal(query, options) {
      if (state === 'disposed') throw new Error('Cognition P5 composition has been disposed');
      if (!meetingCoordinator) throw new Error('Meeting coordinator unavailable: Laya inference/chooser not connected');
      return tracked('meeting', options, context => meetingCoordinator.applyApprovedProposal(query, context));
    },

    async getMeetingReceipt(eventId, source) {
      if (!meetingCoordinator) return undefined;
      return meetingCoordinator.getReceipt(eventId, source);
    },

    async triageMails(messages, options = {}) {
      if (state === 'disposed') throw new Error('Cognition P5 composition has been disposed');
      if (state !== 'running') throw new Error(`Cognition P5 composition is not running (state: ${state})`);
      if (!mailPipeline) throw new Error('Mail pipeline unavailable: Laya inference/classifier not connected');
      return tracked('mail', options, context => mailPipeline.processBatch({...context, messages}));
    },

    async triagePagedMails(pagedRequest) {
      if (state === 'disposed') throw new Error('Cognition P5 composition has been disposed');
      if (state !== 'running') throw new Error(`Cognition P5 composition is not running (state: ${state})`);
      if (!mailPipeline) throw new Error('Mail pipeline unavailable: Laya inference/classifier not connected');
      return tracked('mail', pagedRequest, context => mailPipeline.processPagedStream(context));
    },

    async evaluateDeviceSample(sample, layaRequest) {
      if (state === 'disposed') throw new Error('Cognition P5 composition has been disposed');
      if (state !== 'running') throw new Error(`Cognition P5 composition is not running (state: ${state})`);
      if (!deviceAnomalyService) throw new Error('Device anomaly service unavailable: Laya inference/chooser not connected');
      return tracked('device', layaRequest, context => deviceAnomalyService.evaluateSample(sample, context));
    },

    async readDeviceFeedback() {
      return deviceAnomalyService?.readFeedback() ?? [];
    },

    async dialogueProjection() {
      const records = await instance.listMeetingReceipts();
      const devices = await instance.readDeviceFeedback();
      return {state, modelReady: instance.snapshot().modelReady, failures: {...failures},
        calendarSource: instance.snapshot().calendarSource,
        meetings: records.slice(-20).map(({receipt}) => ({eventId: receipt.eventId,
          status: receipt.status, graphRevisionAfter: receipt.graphRevisionAfter,
          confidence: receipt.confidence, actionId: receipt.actionId,
          selectionState: receipt.selection?.state, selectionReason: receipt.selection?.reason,
          selectionReceiptId: receipt.selection?.receipt?.id, calibrated: false,
          retryableInference: receipt.retryableInference === true,
          // This is an internal graph commit, never proof of provider reschedule.
          calendarWriteVerified: false})),
        devices: devices.map(({source, pendingDeliveryId, receipt}) => ({source,
          status: receipt?.status ?? 'unobserved', notificationDelivered: receipt?.notificationDelivered === true,
          selectionState: receipt?.selection?.state, selectionReason: receipt?.selection?.reason,
          selectionReceiptId: receipt?.selection?.receipt?.id, confidence: receipt?.selection?.answerConfidence ?? null,
          calibrated: false,
          deliveryNeedsReconciliation: Boolean(pendingDeliveryId), receiptId: receipt?.receiptId})),
      };
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
  };

  return instance;
}
