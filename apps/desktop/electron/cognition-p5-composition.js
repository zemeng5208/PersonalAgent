import {createInboxTriagePipeline} from '@personal-agent/runtime/application';
import {
  ReviewedMeetingFactConsumer,
  createCommittedMeetingProjectionReader,
  createInboxPageConsumer,
  measureTriageClassifier,
  LayaTriageService,
  withCognitionDeadline,
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
 * Assembles committed-Fact review, existing InboxTriagePipeline and device advice
 * with existing Runtime host-state KV, reviewedRepair, and confirmed notification delivery.
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
  reviewedRepair,
  goalCognitionHost,
  readCommittedMeetingProjection,
  facts,
  readMeetingSourceRevision,
  hostStateStorage,
  legacyDeviceNamespace,
  mailStorage,
  inboxPipeline,
  mailReadAuthorization,
  getClassifierFingerprint,
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
  // e11ac12 public host-state API: same TaskRuntime SQLite/migration 10, zero anchor tasks.
  const storage = hostStateStorage ?? application.createHostStateStore?.('proactive-receipts');
  if (typeof storage?.get !== 'function' || typeof storage?.set !== 'function') {
    throw Error('Runtime createHostStateStore(proactive-receipts) is unavailable');
  }
  const runtimeCheckpoints = createP5RuntimeCheckpoints({storage, namespace, userData, legacyDeviceNamespace});
  const receiptStore = runtimeCheckpoints.meetings;
  // A function called policyEvaluator cannot impersonate Runtime tools. It is
  // accepted for source compatibility but never used to append the graph.
  const executionPort = undefined;
  const meetingProjectionReader = readCommittedMeetingProjection ?? (facts && readMeetingSourceRevision
    ? createCommittedMeetingProjectionReader({namespace, store, facts, readSourceRevision: readMeetingSourceRevision}) : undefined);
  const meetingReviewPort = reviewedRepair ?? (goalCognitionHost && meetingProjectionReader
    ? goalCognitionHost.meetingReviewedRepairPort(meetingProjectionReader) : undefined);

  // 3. Resolve chooser & classifier ports directly from layaHost or explicit arguments
  // Public port reuse: consumes layaHost.choose and layaHost.classify without reading private closures or exposing keys
  const resolvedChooser = chooser
    ?? (layaHost && typeof layaHost.choose === 'function' ? { choose: req => layaHost.choose(req) } : undefined);
  const resolvedClassifier = classifier
    ?? (layaHost && typeof layaHost.classify === 'function' ? { classify: req => layaHost.classify(req) } : undefined);

  // 4. Meeting Reschedule Coordinator
  const meetingCoordinator = new ReviewedMeetingFactConsumer({
    store,
    reviewedRepair: meetingReviewPort,
    receiptStore,
    namespace,
    now,
  });

  // One existing InboxTriagePipeline/source cursor/fingerprint/cache/outbox.
  // The trusted loaded-model identity and current local read lease are required.
  const measuredClassifier = !inboxPipeline && (resolvedClassifier || inference) ? measureTriageClassifier(
    resolvedClassifier ?? new LayaTriageService(inference)) : undefined;
  const mailPipeline = inboxPipeline ?? (mailStorage && measuredClassifier && typeof getClassifierFingerprint === 'function'
    && typeof mailReadAuthorization === 'function' ? createInboxTriagePipeline({
      // Existing inbox storage retains private approved header projections. Public
      // host-state metadata KV cannot become a new unencrypted mail-content store.
      storage: mailStorage, namespace, triage: measuredClassifier,
      labels: DEFAULT_MAIL_LABELS, meetingLabels: ['meeting'],
      getClassifierFingerprint, authorizeRead: mailReadAuthorization,
    }) : undefined);
  const mailConsumer = mailPipeline ? createInboxPageConsumer({pipeline: mailPipeline, now}) : undefined;

  // 6. Device Anomaly Decision Service with confirmed delivery
  const anomalyChooser = resolvedChooser ?? inference;
  const deviceAnomalyService = anomalyChooser ? new DeviceAnomalyDecisionService(anomalyChooser, {
    cpuThresholdPercent: 90,
    memoryThresholdPercent: 90,
    recoveryThresholdPercent: 80,
    sustainedSampleCount: 3,
    cooldownMs: 300_000,
    notificationPort,
    checkpoint: runtimeCheckpoints.device,
    now,
  }) : undefined;

  // Lifecycle state: 'idle' | 'running' | 'stopped' | 'disposed'
  let state = autoStart ? 'running' : 'idle';
  const activeSubscriptions = new Set();
  const activeControllers = new Set();
  const mailControllers = new Set();
  const failures = {};

  const publish = () => {
    try { onUpdate(); } catch {}
  };
  const tracked = async (chain, options, operation) => {
    if (state !== 'running') throw new Error(`Cognition P5 composition is not running (state: ${state})`);
    const controller = new AbortController();
    activeControllers.add(controller);
    if (chain === 'mail') mailControllers.add(controller);
    let signal = controller.signal;
    try {
      if (options?.signal) signal = AbortSignal.any([options.signal, controller.signal]);
      const deadline = options?.deadline ?? new Date(now() + 60_000).toISOString();
      const result = await withCognitionDeadline({signal, deadline}, context => operation({...options, ...context}), now);
      delete failures[chain];
      return result;
    } catch (error) {
      // Source text, credentials and absolute storage paths are not UI errors.
      failures[chain] = signal.aborted ? 'cancelled'
        : layaHost && layaHost.snapshot?.()?.ready !== true ? 'model_unavailable' : 'processing_failed';
      throw error;
    } finally {
      activeControllers.delete(controller);
      mailControllers.delete(controller);
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
    get checkpointStorage() { return storage; },
    get executionPort() { return executionPort; },
    get meetingCoordinator() { return meetingCoordinator; },
    get mailPipeline() { return mailPipeline; },
    get deviceAnomalyService() { return deviceAnomalyService; },

    snapshot() {
      return {
        state,
        ready: state === 'running',
        activeSubscriptionCount: activeSubscriptions.size,
        hasMeetingCoordinator: Boolean(meetingReviewPort),
        hasCalendarMeetingSource: Boolean(calendarMeetingSource),
        calendarSource: calendarMeetingSource?.snapshot() ?? {status: 'unavailable', calendarWriteVerified: false},
        hasMailPipeline: Boolean(mailPipeline),
        mail: mailConsumer?.snapshot() ?? {unavailable: true},
        mailMetrics: measuredClassifier?.snapshot(),
        persistence: runtimeCheckpoints.persistence,
        hasDeviceAnomalyService: Boolean(deviceAnomalyService),
        hasExecutionPort: Boolean(meetingReviewPort),
        hasPolicyEvaluator: false,
        legacyExecutionPortIgnored: Boolean(policyEvaluator || meetingExecutionPort),
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
      mailConsumer?.resume();
      publish();
      return this.snapshot();
    },

    async stop() {
      if (state === 'disposed') return this.snapshot();
      if (state === 'stopped') return this.snapshot();
      state = 'stopped';
      mailConsumer?.pause();
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
      mailConsumer?.close();
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
      if (!meetingReviewPort) throw new Error('Committed meeting Fact review port is unavailable');

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

      const unbind = registerSourceListener(mailSource, ['page', 'mail_page'], async page => {
        if (state !== 'running') return;
        try {
          await instance.triageInboxPage(page);
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

    async triageMails(items, options = {}) {
      if (state === 'disposed') throw new Error('Cognition P5 composition has been disposed');
      if (state !== 'running') throw new Error(`Cognition P5 composition is not running (state: ${state})`);
      if (!mailPipeline) throw new Error('Mail pipeline unavailable: Laya inference/classifier not connected');
      // Compatibility name, now requires the same scoped source-page envelope.
      return instance.triageInboxPage({...options, items});
    },

    async triageInboxPage(page) {
      if (!mailConsumer) throw Error('Inbox source, current read lease or classifier identity unavailable');
      return tracked('mail', page, context => mailConsumer.processPage({...page, ...context}));
    },

    pauseMail() {
      mailConsumer?.pause();
      for (const controller of mailControllers) controller.abort();
      publish();
    },
    resumeMail() {
      if (state !== 'running') throw Error('Cognition P5 composition is not running');
      mailConsumer?.resume(); publish();
    },

    async triagePagedMails(pagedRequest) {
      if (state === 'disposed') throw new Error('Cognition P5 composition has been disposed');
      if (state !== 'running') throw new Error(`Cognition P5 composition is not running (state: ${state})`);
      if (!mailPipeline) throw new Error('Mail pipeline unavailable: Laya inference/classifier not connected');
      return tracked('mail', pagedRequest, context => mailConsumer.processStream(context));
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
          decisionAction: receipt.decisionAction, reviewTaskId: receipt.reviewTaskId,
          repairTaskId: receipt.repairTaskId, executionVerified: receipt.executionVerified === true,
          graphUpdateVerified: receipt.graphUpdateVerified === true,
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
      const pending = new Set(['proposal', 'requires_review', 'submitted', 'waiting_approval', 'waiting_reconciliation']);
      return (await meetingCoordinator.listReceipts()).filter(record => pending.has(record.status));
    },

    async listMeetingReceipts(filter) {
      if (!meetingCoordinator) return [];
      return meetingCoordinator.listReceipts(filter);
    },
  };

  return instance;
}
