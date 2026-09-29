import {ProtocolError} from '@personal-agent/contracts';
import type {RegisteredTool, StoragePort, ProtocolContracts} from '@personal-agent/contracts';
import {QQMailProvider, register as registerMail} from '@personal-agent/mail';
import {LayaTriageService, LocalLayaBatchHttpTransport} from '@personal-agent/cognition';
import type {RuntimeApplication} from './runtime-application.js';
import {createInboxTriagePipeline} from './inbox-triage.js';
import type {InboxAnalysisAcceptance, InboxTriageContext} from './inbox-triage.js';

export function createLocalInboxClassifier(options: {port: number; getApiKey: () => string}) {
  return new LayaTriageService(new LocalLayaBatchHttpTransport(options.port, options.getApiKey), {batching:'multi_state'});
}

export interface QQMailTriageHostOptions {
  readonly user: string;
  readonly authCode: string;
  readonly accountRef: string;
  readonly storage: StoragePort;
  readonly namespace: string;
  readonly triage?: Pick<LayaTriageService, 'classify'>;
  readonly labels: Readonly<Record<string, string>>;
  readonly meetingLabels?: readonly string[];
  readonly isSessionAllowed: () => boolean;
}

/** Trusted composition: only the registered tool touches IMAP, after Runtime/Policy authorization. */
export function createQQMailTriageHost(options: QQMailTriageHostOptions) {
  const provider = new QQMailProvider({user: options.user, authCode: options.authCode});
  let application: RuntimeApplication | undefined;
  let sessionId: string | undefined;
  let controller = new AbortController();
  let closed = false, refreshing = false, reading = 0, status = options.triage ? 'ready' : 'unavailable';
  let taskId: string | undefined, cursor: string | undefined, deadline = '';
  let analysisSessionId: string | undefined;
  const allowed = () => !closed && options.isSessionAllowed();
  const pipeline = options.triage ? createInboxTriagePipeline({storage: options.storage,
    namespace: options.namespace, triage: options.triage, labels: options.labels,
    ...(options.meetingLabels ? {meetingLabels: options.meetingLabels} : {}),
    authorizeRead: scope => allowed() && scope.accountRef === options.accountRef && scope.folder === 'INBOX'}) : undefined;
  const tools: RegisteredTool[] = [];
  const disposeRegistration = registerMail({register(implementation) {
    if (implementation.descriptor.name !== 'mail.inbox') return () => {};
    tools.push({descriptor: implementation.descriptor, async execute(input, context) {
      const args = input as {account?: unknown; folder?: unknown};
      if (!allowed() || !pipeline || !sessionId || context.taskId !== taskId
        || args.account !== options.accountRef || args.folder !== 'INBOX') {
        throw new ProtocolError('UNAUTHORIZED', 'Inbox read is outside its local session');
      }
      const signal = AbortSignal.any([context.signal, controller.signal]);
      if (signal.aborted) throw new ProtocolError('CANCELLED', 'Inbox read cancelled');
      const abort = () => {void provider.dispose();};
      signal.addEventListener('abort', abort, {once: true});
      reading++;
      try {
        const result = await implementation.execute(input, {...context, signal});
        if (!allowed() || signal.aborted) throw new ProtocolError('CANCELLED', 'Inbox read revoked');
        return result;
      } finally {
        signal.removeEventListener('abort', abort);
        reading--;
        // connect() may have finished after dispose() saw no current client.
        if (signal.aborted || !allowed()) await provider.dispose();
        if (controller.signal.aborted && reading === 0) status = 'disabled';
      }
    }});
    return () => {tools.length = 0;};
  }}, {provider, accountRef: options.accountRef});
  const snapshot = () => {
    const summary = pipeline?.snapshot();
    return {configured: true, status: controller.signal.aborted && reading > 0 ? 'stop_unconfirmed' : status,
      headersOnly: true, counts: {total: summary?.total ?? 0, needsReview: summary?.needsReview ?? 0,
        highImpactCandidates: summary?.highImpactCandidates ?? 0, meetingCandidates: summary?.meetingCandidates ?? 0,
        groups: summary?.groups ?? {}},
      reason: !pipeline ? '本地 Laya 服务未配置，尚未读取邮箱' : undefined};
  };
  const next = () => {
    if (!application || !sessionId) throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'Inbox Runtime is not bound');
    const page = application.nextMailReadSession(sessionId);
    if (page.state === 'submitted') {taskId = page.page.task.taskId; status = 'reading';}
    else if (page.state === 'done') {
      application.stopMailReadSession(sessionId); sessionId = undefined; taskId = undefined; status = 'complete';
    } else status = page.state;
  };
  const cancel = async () => {
    controller.abort();
    analysisSessionId = undefined;
    if (application && sessionId) application.stopMailReadSession(sessionId);
    sessionId = undefined;
    status = reading > 0 ? 'stop_unconfirmed' : 'disabled';
    await provider.dispose();
    return snapshot();
  };
  const analysisContext = (context: InboxTriageContext) => {
    if (!context || !(context.signal instanceof AbortSignal) || !Number.isFinite(Date.parse(context.deadline))) {
      throw new ProtocolError('INVALID_ARGUMENT', 'Invalid inbox analysis context');
    }
    if (!allowed() || controller.signal.aborted || !analysisSessionId || Date.now() >= Date.parse(deadline)) {
      throw new ProtocolError('UNAUTHORIZED', 'Local inbox analysis session is no longer valid');
    }
    return {deadline: new Date(Math.min(Date.parse(context.deadline), Date.parse(deadline))).toISOString(),
      signal: AbortSignal.any([context.signal, controller.signal])};
  };
  return Object.freeze({
    tools: Object.freeze([...tools]), snapshot,
    /** Local-only projections. Root must separately authorize every cloud send. */
    pendingAnalyses(context: InboxTriageContext) {
      const current = analysisContext(context);
      return (pipeline?.pendingAnalyses(current) ?? []).map(item => ({...item, sessionId: analysisSessionId!}));
    },
    /** Synchronous current-head read, including accepted items, for beforeCompetitionSend. */
    readAnalysis(workKey: string, context: InboxTriageContext) {
      const current = analysisContext(context);
      const item = pipeline?.readAnalysis(workKey, current);
      return item ? {...item, sessionId: analysisSessionId!} : undefined;
    },
    confirmAnalysisAccepted(input: InboxAnalysisAcceptance & {readonly sessionId: string}, context: InboxTriageContext) {
      const current = analysisContext(context);
      if (!input || input.sessionId !== analysisSessionId || !pipeline) {
        throw new ProtocolError('UNAUTHORIZED', 'Inbox analysis belongs to a different session');
      }
      return {...pipeline.confirmAnalysisAccepted(input, current), sessionId: analysisSessionId!};
    },
    bindApplication(value: RuntimeApplication) {
      if (application && application !== value) throw Error('Inbox host is already bound');
      application = value;
    },
    startBatch({expiresAt}: {expiresAt: string}) {
      if (!application || !pipeline) throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'Local inbox classification is unavailable');
      if (!allowed()) throw new ProtocolError('UNAUTHORIZED', 'Inbox read consent is absent');
      if (sessionId || reading > 0) throw new ProtocolError('REVISION_CONFLICT', 'Inbox batch is already active');
      const session = application.startMailReadSession({accountRef: options.accountRef, folder: 'INBOX', expiresAt});
      sessionId = session.sessionId; analysisSessionId = session.sessionId;
      deadline = expiresAt; cursor = undefined; controller = new AbortController();
      next();
      return snapshot();
    },
    async refresh() {
      if (!application || !sessionId || !taskId || !pipeline || refreshing || status === 'classification_unavailable') return snapshot();
      if (!allowed() || Date.now() >= Date.parse(deadline)) return cancel();
      let read;
      try { read = application.readHostToolTask(taskId); }
      catch (error) { await cancel(); throw error; }
      if (!read.confirmed) {
        status = read.task.state;
        if (['failed', 'cancelled'].includes(status)) return cancel();
        return snapshot();
      }
      const page = read.confirmed.result as {account: string; folder: string; items: ProtocolContracts['connectorItem'][];
        nextCursor: string; hasMore: boolean};
      if (!page || page.account !== options.accountRef || page.folder !== 'INBOX') {
        await cancel();
        throw new ProtocolError('EXTERNAL_FAILURE', 'Confirmed inbox scope mismatch');
      }
      refreshing = true; status = 'classifying';
      try {
        const result = await pipeline.processPage({accountRef: options.accountRef, folder: 'INBOX',
          ...(cursor ? {cursor} : {}), nextCursor: page.nextCursor, hasMore: page.hasMore, items: page.items,
          deadline, signal: controller.signal});
        if (!result.complete) {status = 'classification_unavailable'; return snapshot();}
        cursor = page.nextCursor;
        if (allowed() && !controller.signal.aborted) next();
      } catch {status = controller.signal.aborted ? 'disabled' : 'classification_unavailable';}
      finally {refreshing = false;}
      return snapshot();
    },
    retryClassification() {if (status === 'classification_unavailable' && allowed()) status = 'reading'; return snapshot();},
    cancel,
    async close() {closed = true; await cancel(); disposeRegistration();},
  });
}
