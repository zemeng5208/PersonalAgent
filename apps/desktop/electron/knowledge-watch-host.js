import {createHash} from 'node:crypto';
import {buildInterestOptions, decideKnowledgeFreshness, LayaInterestDecisionService,
  planKnowledgeReevaluation} from '@personal-agent/cognition';

const PROFILE = 'huawei_ict_agentarts';
const KEY_PREFIX = 'knowledge-watch:v1:';
const LABELS = {
  suggested: '待建议',
  tracked: '已跟踪',
  paused: '暂停',
  revoked: '撤销',
  expired: '过期',
  source_unavailable: '来源不可用',
  authorization_required: '待授权',
};
const WATCH_STATES = new Set(Object.keys(LABELS));
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);

const fail = code => { throw Object.assign(new Error(code), {code}); };
const clone = value => structuredClone(value);
const text = value => typeof value === 'string' && value.trim().length > 0 && !value.includes('\0');
const sha = value => /^[a-f0-9]{64}$/.test(value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const iso = ms => new Date(ms).toISOString();
const clip = (value, max = 240) => value.length <= max ? value : value.slice(0, max);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

export function knowledgeWatchCheckpointKey(namespace) {
  if (!text(namespace) || namespace.length > 200) fail('INVALID_ARGUMENT');
  return KEY_PREFIX + namespace;
}

/**
 * Explicit test double. Production wiring must not call it.
 * A missing production provider is unavailable; it is not this object.
 */
export function createUnavailableSourcePort(reason = 'source_provider_missing') {
  return Object.freeze({
    kind: 'fake',
    availability: 'unavailable',
    read() {
      return Promise.resolve({availability: 'unavailable', reason, provider: 'fake'});
    },
  });
}

export function knowledgeWatchConversationId(namespace) {
  if (!identifier(namespace)) fail('INVALID_ARGUMENT');
  return `knowledge-watch:${namespace}`;
}

/** One Runtime schedule. The host does not compute the next run or dispatch it. */
export function knowledgeWatchScheduleInput({namespace, runAt, checkId} = {}) {
  if (!identifier(namespace) || !identifier(checkId) || !Number.isFinite(instant(runAt))) fail('INVALID_ARGUMENT');
  return {
    scheduleId: `knowledge-watch:${namespace}:${checkId}`,
    goal: '检查已授权的公开订阅',
    conversationId: knowledgeWatchConversationId(namespace),
    runAt,
    timeZone: 'UTC',
    missedRunPolicy: 'run_once',
    taskIdempotencyKey: `knowledge-watch:${namespace}:${checkId}`,
  };
}

function adaptRuntimeWork(runtime, namespace) {
  const conversationId = knowledgeWatchConversationId(namespace);
  return {
    async read({idempotencyKey}) {
      try {
        const task = runtime.findTaskByIdempotencyKey(idempotencyKey);
        if (task === undefined) return {state: 'absent'};
        if (!text(task?.taskId) || task.goal !== `RECHECK ${idempotencyKey}`
          || task.conversationId !== conversationId) return {state: 'unknown'};
        return {state: 'accepted', taskId: task.taskId, ...(text(task.state) ? {taskState: task.state} : {})};
      } catch { return {state: 'unknown'}; }
    },
    async submit({idempotencyKey}) {
      const task = await runtime.submitTask({
        goal: `RECHECK ${idempotencyKey}`,
        conversationId,
        idempotencyKey,
      });
      if (!text(task?.taskId)) return {accepted: false};
      return {accepted: true, taskId: task.taskId};
    },
  };
}

function adaptNotificationService(service, namespace) {
  return {
    async send(notice) {
      if (!text(notice?.citation) || !sha(notice.id) || !Number.isFinite(instant(notice.createdAt))) {
        return {delivered: false, reason: 'citation_missing'};
      }
      const item = {
        source: 'knowledge-watch',
        accountRef: namespace,
        externalId: notice.id,
        occurredAt: notice.createdAt,
        fetchedAt: notice.createdAt,
        contentRef: notice.citation,
        sensitivity: 'public',
        dedupeKey: `${namespace}:${notice.id}`,
      };
      try {
        service.ingest([item]);
        const drained = service.drain();
        const batch = drained?.batches?.find(entry => entry?.state === 'ready_for_delivery'
          && text(entry.id) && Array.isArray(entry.itemRefs) && entry.itemRefs.includes(item.dedupeKey));
        if (!batch) return {delivered: false, reason: 'awaiting_batch'};
        return {delivered: false, receiptId: batch.id, deliveryState: 'ready_for_delivery'};
      } catch { return null; }
    },
    async read(notice) {
      try {
        const drained = service.drain();
        const batch = drained?.batches?.find(entry => entry?.id === notice?.receiptId);
        if (batch?.state === 'ready_for_delivery' && text(batch.id)) {
          return {delivered: false, receiptId: batch.id, deliveryState: 'ready_for_delivery'};
        }
        return {delivered: false, reason: 'acknowledgement_unknown'};
      } catch { return null; }
    },
  };
}

function plain(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function identifier(value) {
  return text(value) && value.length <= 200 && !RESERVED.has(value);
}
function instant(value) {
  if (!text(value)) return NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function emptyDocument(namespace) {
  return {version: 1, namespace, watches: {}, sources: {}, reevaluations: {},
    submissions: {}, notices: {}, tombstones: {}};
}

function readableCheckpoint(raw, namespace) {
  if (raw === undefined) return {ok: true, empty: true};
  if (!plain(raw)) return {ok: false, reason: 'checkpoint_malformed'};
  const keys = Object.keys(raw);
  const expected = ['version', 'namespace', 'watches', 'sources', 'reevaluations',
    'submissions', 'notices', 'tombstones'];
  if (raw.version !== 1 || raw.namespace !== namespace || keys.length !== expected.length
    || expected.some(key => !own(raw, key))
    || [raw.watches, raw.sources, raw.reevaluations, raw.submissions, raw.notices, raw.tombstones]
      .some(value => !plain(value))) return {ok: false, reason: 'checkpoint_malformed'};
  for (const [topicId, tombstone] of Object.entries(raw.tombstones)) {
    if (!identifier(topicId) || !plain(tombstone) || tombstone.topicId !== topicId
      || !identifier(tombstone.id) || !Number.isFinite(instant(tombstone.revokedAt))) {
      return {ok: false, reason: 'checkpoint_tombstone_unreadable'};
    }
  }
  for (const [topicId, watch] of Object.entries(raw.watches)) {
    if (!identifier(topicId) || !plain(watch) || watch.topicId !== topicId
      || !WATCH_STATES.has(watch.state) || !text(watch.reason)
      || !Number.isSafeInteger(watch.revision) || watch.revision < 1) {
      return {ok: false, reason: 'checkpoint_watch_unreadable'};
    }
    if (watch.state === 'revoked' && !raw.tombstones[topicId]) {
      return {ok: false, reason: 'checkpoint_revocation_unreadable'};
    }
    if (watch.delivered === true) return {ok: false, reason: 'checkpoint_watch_unreadable'};
  }
  for (const notice of Object.values(raw.notices)) {
    if (!plain(notice) || !sha(notice.id) || notice.delivered === true && !text(notice.receiptId)) {
      return {ok: false, reason: 'checkpoint_notice_unreadable'};
    }
  }
  for (const submission of Object.values(raw.submissions)) {
    if (!plain(submission) || !['unknown', 'accepted'].includes(submission.state)
      || submission.state === 'accepted' && !text(submission.taskId)) {
      return {ok: false, reason: 'checkpoint_submission_unreadable'};
    }
  }
  return {ok: true, document: raw};
}

/**
 * Desktop consumer for interest decisions and knowledge reevaluation.
 * It does not poll, crawl, start Laya, or grant execution from source text.
 */
export function createKnowledgeWatchHost({
  profile,
  namespace,
  checkpointTaskId,
  checkpoints,
  now = Date.now,
  sourcePort = null,
  subscriptions = null,
  interestDecider = null,
  layaChooser = null,
  workPort = null,
  runtime = null,
  notificationPort = null,
  notificationService = null,
  policyPort = null,
  authorizationRef = null,
  policyToolName = null,
  policyScopes = null,
  readTrackingGrant = null,
  feedCollect = null,
  feedSubscriptionId = null,
  scheduler = null,
  knowledgeMaxAgeMs = 2 * 60 * 60 * 1000,
} = {}) {
  if (profile !== PROFILE || !identifier(namespace) || !identifier(checkpointTaskId)
    || typeof checkpoints?.loadCheckpoint !== 'function'
    || typeof checkpoints?.saveCheckpoint !== 'function'
    || typeof now !== 'function'
    || !Number.isFinite(knowledgeMaxAgeMs) || knowledgeMaxAgeMs <= 0) fail('INVALID_ARGUMENT');
  if (sourcePort && typeof sourcePort.read !== 'function') fail('INVALID_ARGUMENT');
  if (feedCollect && typeof feedCollect !== 'function') fail('INVALID_ARGUMENT');
  if (feedSubscriptionId !== null && !identifier(feedSubscriptionId)) fail('INVALID_ARGUMENT');
  if (subscriptions && typeof subscriptions.subscribe !== 'function') fail('INVALID_ARGUMENT');
  if (interestDecider && typeof interestDecider.choose !== 'function') fail('INVALID_ARGUMENT');
  if (layaChooser && typeof layaChooser.choose !== 'function') fail('INVALID_ARGUMENT');
  if (workPort && (typeof workPort.submit !== 'function' || typeof workPort.read !== 'function')) fail('INVALID_ARGUMENT');
  if (runtime !== null && !plain(runtime)) fail('INVALID_ARGUMENT');
  if (notificationPort && typeof notificationPort.send !== 'function') fail('INVALID_ARGUMENT');
  if (notificationService && (typeof notificationService.ingest !== 'function'
    || typeof notificationService.drain !== 'function')) fail('INVALID_ARGUMENT');
  if (policyPort && typeof policyPort.evaluate !== 'function' && typeof policyPort.authorize !== 'function') {
    fail('INVALID_ARGUMENT');
  }
  const policyConfigured = authorizationRef !== null || policyToolName !== null || policyScopes !== null;
  if (policyConfigured && (!text(authorizationRef) || !text(policyToolName) || !Array.isArray(policyScopes)
    || policyScopes.length === 0 || policyScopes.some(scope => !text(scope)))) fail('INVALID_ARGUMENT');
  if (readTrackingGrant && typeof readTrackingGrant !== 'function') fail('INVALID_ARGUMENT');
  if (scheduler && (typeof scheduler.createSchedule !== 'function'
    || typeof scheduler.listSchedules !== 'function'
    || typeof scheduler.reconcileSchedules !== 'function')) fail('INVALID_ARGUMENT');
  const wrappedLaya = !interestDecider && Boolean(layaChooser);
  if (wrappedLaya) interestDecider = new LayaInterestDecisionService(layaChooser, now);
  if (!workPort && typeof runtime?.submitTask === 'function'
    && typeof runtime?.findTaskByIdempotencyKey === 'function') {
    workPort = adaptRuntimeWork(runtime, namespace);
  }
  if (!notificationPort && notificationService) notificationPort = adaptNotificationService(notificationService, namespace);
  const boundScheduler = scheduler ?? (typeof runtime?.createSchedule === 'function'
    && typeof runtime?.listSchedules === 'function'
    && typeof runtime?.reconcileSchedules === 'function' ? runtime : null);

  const checkpointKey = knowledgeWatchCheckpointKey(namespace);
  let document = null;
  let health = {status: 'ready'};
  let running = false;
  let disposed = false;
  let unsubscribe = null;
  let controller = null;
  let chain = Promise.resolve();
  let subscriptionActive = false;
  let registeredSchedule = false;
  let life = 0;
  let feedReading = false;

  function clock() {
    const value = now();
    if (typeof value !== 'number' || !Number.isFinite(value)) fail('INVALID_ARGUMENT');
    return value;
  }
  function lock(fn) {
    const run = chain.then(fn, fn);
    chain = run.then(() => {}, () => {});
    return run;
  }
  function load() {
    let raw;
    try { raw = checkpoints.loadCheckpoint(checkpointTaskId, checkpointKey); }
    catch { health = {status: 'unreadable', reason: 'checkpoint_load_failed'}; document = null; return; }
    const parsed = readableCheckpoint(raw, namespace);
    if (!parsed.ok) { health = {status: 'unreadable', reason: parsed.reason}; document = null; return; }
    health = {status: 'ready'};
    document = parsed.empty ? emptyDocument(namespace) : clone(parsed.document);
  }
  function persist(next) {
    checkpoints.saveCheckpoint(checkpointTaskId, checkpointKey, next);
    document = next;
  }
  function requireReady() {
    if (disposed) fail('DISPOSED');
    if (!running) fail('STOPPED');
    if (health.status !== 'ready' || !document) fail('CHECKPOINT_UNREADABLE');
  }
  function wiring() {
    return {
      profile: PROFILE,
      source: feedCollect ? 'feeds' : sourcePort ? 'injected' : 'unavailable',
      subscription: subscriptionActive,
      scheduler: Boolean(boundScheduler),
      layaChooser: wrappedLaya,
      interestDecider: Boolean(interestDecider),
      workPort: Boolean(workPort),
      notificationPort: Boolean(notificationPort),
      policyPort: Boolean(policyPort),
      main: false,
    };
  }
  function projectWatch(watch) {
    const current = clock();
    const state = watch.state === 'tracked' && watch.expiresAt && instant(watch.expiresAt) <= current
      ? 'expired' : watch.state;
    return {...clone(watch), state, label: LABELS[state]};
  }
  function sourceFreshness(binding) {
    const head = document.sources[binding.sourceId];
    const sourceState = head?.availability === 'withdrawn' ? 'withdrawn'
      : head?.availability === 'unavailable' ? 'unavailable' : 'available';
    const input = {at: iso(clock()), maxAgeMs: knowledgeMaxAgeMs, requestedVersion: binding.cacheVersion,
      sourceState, cache: {version: binding.cacheVersion, sourceId: binding.sourceId,
        sourceRevision: binding.revision, contentSha256: binding.contentSha256,
        lastSuccessfulCheck: binding.lastSuccessfulCheck, validUntil: binding.validUntil}};
    if (sourceState === 'available' && text(head?.revision) && sha(head?.contentSha256)
      && Number.isFinite(instant(head.observedAt))) {
      input.check = {outcome: head.revision === binding.revision && head.contentSha256 === binding.contentSha256
        ? 'unchanged' : 'changed', checkedAt: head.observedAt, sourceId: binding.sourceId,
        sourceRevision: binding.revision, cachedContentSha256: binding.contentSha256};
    }
    try {
      const decision = decideKnowledgeFreshness(input);
      return {action: decision.action, reason: decision.reason, sourceRevision: decision.sourceRevision,
        contentSha256: decision.contentSha256, lastSuccessfulCheck: decision.lastSuccessfulCheck};
    } catch {
      return {action: 'last_verified_only', reason: 'freshness_unknown'};
    }
  }
  function dialogueView() {
    if (!document) return null;
    const items = Object.values(document.watches).map(watch => {
      const projected = projectWatch(watch);
      const binding = projected.boundSource;
      const bound = binding && text(binding.sourceId) && text(binding.revision) && sha(binding.contentSha256)
        && text(binding.cacheVersion) && Number.isFinite(instant(binding.lastSuccessfulCheck))
        && Number.isFinite(instant(binding.validUntil));
      const freshness = projected.state === 'revoked'
        ? {action: 'unavailable', reason: 'user_revoked'}
        : projected.state === 'expired' ? {action: 'last_verified_only', reason: 'watch_expired'}
        : projected.state === 'suggested' || !bound
          ? {action: 'not_bound', reason: projected.state === 'suggested' ? 'suggested_only' : 'no_source_binding'}
          : sourceFreshness(binding);
      const head = bound ? document.sources[binding.sourceId] : null;
      const same = !!(head && head.revision === binding.revision && head.contentSha256 === binding.contentSha256);
      const citation = same && text(head?.citation) ? head.citation : null;
      const unknown = bound && Object.values(document.submissions).some(item =>
        item.sourceId === binding.sourceId && item.state === 'unknown');
      const usableAsCurrentFact = projected.state === 'tracked' && freshness.action === 'use_cache'
        && text(citation) && !unknown;
      const notice = Object.values(document.notices)
        .filter(item => Array.isArray(item.topicIds) && item.topicIds.includes(projected.topicId))
        .sort((left, right) => instant(right.latest?.fetchedAt) - instant(left.latest?.fetchedAt))[0] ?? null;
      const latestObservation = head ? {availability: head.availability, revision: head.revision ?? null,
        contentSha256: head.contentSha256 ?? null, fetchedAt: head.observedAt ?? null,
        citation: text(head.citation) ? head.citation : null, sameAsBinding: same} : null;
      const update = notice ? {noticeId: notice.id, knowledgeAction: notice.knowledge?.action ?? null,
        knowledgeReason: notice.knowledge?.reason ?? null, citation: text(notice.citation) ? notice.citation : null,
        sourceRevision: notice.latest?.revision ?? null, contentSha256: notice.latest?.contentSha256 ?? null,
        fetchedAt: notice.latest?.fetchedAt ?? null, availability: notice.latest?.availability ?? null,
        delivered: notice.delivered === true, deliveryReason: notice.deliveryReason ?? null,
        usableAsLatestObservation: bound && projected.state === 'tracked'
          && text(notice.citation) && notice.latest?.availability === 'available' && !unknown,
        dataClass: 'untrusted_source_text',
        untrustedExcerpt: projected.state === 'revoked' ? null : notice.untrustedExcerpt ?? null} : null;
      let answer;
      if (projected.state === 'revoked') answer = {kind: 'withheld', reason: 'user_revoked'};
      else if (projected.state === 'expired') answer = {kind: 'withheld', reason: 'watch_expired'};
      else if (projected.state === 'suggested') answer = {kind: 'withheld', reason: 'suggested_only'};
      else if (projected.state === 'paused') answer = {kind: 'withheld', reason: 'user_paused'};
      else if (projected.state === 'authorization_required') answer = {kind: 'withheld', reason: projected.reason};
      else if (projected.state === 'source_unavailable') answer = {kind: 'withheld', reason: freshness.reason};
      else if (unknown) answer = {kind: 'withheld', reason: 'submission_unknown'};
      else if (usableAsCurrentFact) answer = {kind: 'current_fact', sourceId: binding.sourceId,
        sourceRevision: binding.revision, contentSha256: binding.contentSha256,
        fetchedAt: head.observedAt, citation};
      else if (update?.usableAsLatestObservation) answer = {kind: 'latest_observation',
        sourceId: binding.sourceId, sourceRevision: update.sourceRevision,
        contentSha256: update.contentSha256, fetchedAt: update.fetchedAt, citation: update.citation,
        boundRevision: binding.revision, boundContentSha256: binding.contentSha256};
      else if (latestObservation && !latestObservation.sameAsBinding && !text(latestObservation.citation)) {
        answer = {kind: 'withheld', reason: 'citation_missing'};
      } else if (freshness.action === 'use_cache' && !text(citation)) {
        answer = {kind: 'withheld', reason: 'citation_missing'};
      } else answer = {kind: 'withheld', reason: freshness.reason};
      return {topicId: projected.topicId, state: projected.state, label: projected.label,
        reason: projected.reason, authorization: clone(projected.authorization ?? null),
        modelReceiptId: text(projected.modelReceiptId) ? projected.modelReceiptId : null,
        revocable: projected.state !== 'revoked', tombstoneId: projected.tombstoneId ?? null,
        usableAsCurrentFact, freshness, citation, answer,
        boundSource: bound ? {sourceId: binding.sourceId, revision: binding.revision,
          contentSha256: binding.contentSha256, validUntil: binding.validUntil,
          lastSuccessfulCheck: binding.lastSuccessfulCheck} : null,
        latestObservation, update};
    }).sort((left, right) => left.topicId < right.topicId ? -1 : left.topicId > right.topicId ? 1 : 0);
    return {namespace, generatedAt: iso(clock()), dataClass: 'knowledge_watch_dialogue', items};
  }
  function snapshot() {
    const base = {namespace, running, disposed, health: clone(health), wiring: wiring(),
      checkpointKey, mountedInMain: false};
    if (!document) return {...base, watches: null, notices: null, submissions: null, sources: null, dialogue: null};
    return {...base,
      watches: Object.values(document.watches).map(projectWatch)
        .sort((a, b) => a.topicId < b.topicId ? -1 : a.topicId > b.topicId ? 1 : 0),
      notices: Object.values(document.notices).map(clone),
      submissions: clone(document.submissions),
      sources: clone(document.sources),
      dialogue: dialogueView()};
  }
  function dialogueProjection() {
    if (!document) fail('CHECKPOINT_UNREADABLE');
    return dialogueView();
  }
  function listPending() {
    const view = snapshot();
    if (!document) fail('CHECKPOINT_UNREADABLE');
    return {
      watches: view.watches.filter(watch => ['suggested', 'authorization_required',
        'source_unavailable', 'paused'].includes(watch.state)),
      notices: view.notices.filter(notice => notice.delivered !== true),
      submissions: Object.values(view.submissions).filter(item => item.state === 'unknown'),
    };
  }
  function listWatches() {
    if (!document) fail('CHECKPOINT_UNREADABLE');
    return snapshot().watches;
  }

  function policyInput(signal, userEnable) {
    const watch = document.watches[signal.topicId];
    const tombstone = document.tombstones[signal.topicId];
    const input = {
      topicId: signal.topicId,
      at: signal.at,
      evidenceMaxAgeMs: signal.evidenceMaxAgeMs,
      watchDurationMs: signal.watchDurationMs,
      evidence: clone(signal.evidence),
      scope: clone(signal.scope),
    };
    if (signal.source) input.source = clone(signal.source);
    if (signal.classification) input.classification = clone(signal.classification);
    if (watch?.policyState) input.previous = {state: watch.policyState};
    if (tombstone) input.tombstone = clone(tombstone);
    if (userEnable) input.explicitEnable = clone(userEnable);
    return input;
  }
  function formalDecision(signal) {
    if (typeof policyPort?.authorize === 'function' && typeof policyPort.evaluate !== 'function') {
      if (!policyConfigured) return {allowed: false, reason: 'policy_request_incomplete'};
      try {
        const decision = policyPort.authorize({
          authorizationRef,
          taskId: checkpointTaskId,
          toolName: policyToolName,
          requiredScopes: [...policyScopes],
          now: clock(),
        });
        const scopes = Array.isArray(decision?.scopes) ? decision.scopes.filter(text) : [];
        if (policyScopes.every(scope => scopes.includes(scope))) {
          return {allowed: true, reason: 'authorized', scopes};
        }
        return {allowed: false, reason: 'scope_missing'};
      } catch (error) {
        return {allowed: false, reason: text(error?.code) ? error.code : 'policy_failed'};
      }
    }
    if (typeof policyPort?.evaluate !== 'function') return {allowed: false, reason: 'policy_port_missing'};
    let decision;
    try {
      decision = policyPort.evaluate({namespace, topicId: signal.topicId, action: 'track_public',
        risk: signal.source?.risk ?? 'low', scopeExpansion: signal.requestsScopeExpansion === true,
        sourceId: signal.source?.id ?? null});
    } catch { return {allowed: false, reason: 'policy_failed'}; }
    if (decision?.allowed === true) {
      return {allowed: true, reason: text(decision.reason) ? decision.reason : 'allowed'};
    }
    return {allowed: false, reason: text(decision?.reason) ? decision.reason : 'denied'};
  }
  function needsFormalPolicy(signal) {
    return signal.requestsScopeExpansion === true || signal.source?.risk === 'high'
      || signal.source?.visibility === 'private';
  }
  function sourceReady(signal) {
    const content = signal.sourceContent;
    return plain(content) && sha(content.contentSha256) && text(content.cacheVersion)
      && Number.isFinite(instant(content.lastSuccessfulCheck))
      && Number.isFinite(instant(content.validUntil));
  }
  function nextState(policy, signal, approach, blocked) {
    if (policy.state === 'revoked') return ['revoked', policy.reason];
    if (blocked) return ['authorization_required', blocked];
    if (policy.state === 'decay') return ['expired', policy.reason];
    if (policy.state === 'candidate') return ['suggested', policy.reason];
    if (policy.state === 'abstain') {
      if (policy.reason === 'public_source_not_verified') {
        if (signal.source?.risk === 'high' || signal.source?.visibility === 'private') {
          return ['authorization_required', policy.reason];
        }
        return ['source_unavailable', policy.reason];
      }
      if (policy.reason === 'tracking_scope_unavailable') return ['authorization_required', policy.reason];
      return ['suggested', policy.reason];
    }
    if (policy.state === 'watch_public' && approach === 'track_public') {
      if (!sourceReady(signal)) return ['suggested', 'source_identity_incomplete'];
      return ['tracked', policy.reason];
    }
    if (policy.state === 'watch_public') return ['suggested', interestDecider ? 'interest_decision_withheld' : 'decision_port_missing'];
    return ['suggested', policy.reason];
  }
  function authorizationFor(signal, state, formal) {
    if (formal) return {basis: 'formal_policy', allowed: formal.allowed === true, reason: formal.reason};
    if (state === 'tracked') return {basis: 'existing_public_low_risk_scope'};
    return {basis: 'interest_policy'};
  }
  function writeWatch(signal, policy, state, reason, approach, formal, choice) {
    const previous = document.watches[signal.topicId];
    if (previous?.state === 'paused' && state === 'tracked' && signal.resume !== true) {
      state = 'paused';
      reason = 'user_paused';
    }
    if (previous?.state === 'revoked' && state !== 'revoked' && !signal.userEnableApplied) {
      state = 'revoked';
      reason = 'user_revoked';
    }
    const revision = state === 'tracked' && previous?.state !== 'tracked' ? (previous?.revision ?? 0) + 1
      : previous?.revision ?? 1;
    const watch = {
      topicId: signal.topicId,
      state,
      label: LABELS[state],
      reason,
      policyState: state === 'revoked' ? 'revoked' : policy.state,
      evidence: clone(policy.evidence ?? []),
      scope: {id: signal.scope.id, revision: signal.scope.revision, state: signal.scope.state,
        publicLowRiskTracking: signal.scope.publicLowRiskTracking, expiresAt: signal.scope.expiresAt},
      revision,
      updatedAt: signal.at,
      authorization: authorizationFor(signal, state, formal),
    };
    if (policy.expiresAt) watch.expiresAt = policy.expiresAt;
    if (signal.source) watch.source = {id: signal.source.id, revision: signal.source.revision};
    if (state === 'tracked' && sourceReady(signal)) {
      watch.boundSource = {sourceId: signal.source.id, revision: signal.source.revision,
        contentSha256: signal.sourceContent.contentSha256, cacheVersion: signal.sourceContent.cacheVersion,
        lastSuccessfulCheck: signal.sourceContent.lastSuccessfulCheck,
        validUntil: signal.sourceContent.validUntil};
      watch.consumer = {id: signal.topicId, revision};
    } else if (previous?.boundSource && state !== 'tracked') {
      watch.boundSource = clone(previous.boundSource);
      watch.consumer = previous.consumer ? clone(previous.consumer) : {id: signal.topicId, revision: previous.revision};
    }
    if (approach) watch.selectedApproach = approach;
    if (choice?.receipt?.modelReceiptId && text(choice.receipt.modelReceiptId)) {
      watch.modelReceiptId = choice.receipt.modelReceiptId;
    }
    const next = clone(document);
    if (state === 'revoked') {
      if (!next.tombstones[signal.topicId]) {
        next.tombstones[signal.topicId] = {id: `policy-${digest([signal.topicId, reason, signal.at]).slice(0, 24)}`,
          topicId: signal.topicId, revokedAt: signal.at};
      }
      watch.revokedAt = next.tombstones[signal.topicId].revokedAt;
      watch.tombstoneId = next.tombstones[signal.topicId].id;
    }
    next.watches[signal.topicId] = watch;
    persist(next);
    return clone(watch);
  }

  function pickInterest(raw) {
    if (!plain(raw) || raw.namespace !== namespace) fail(raw?.namespace && raw.namespace !== namespace
      ? 'NAMESPACE_MISMATCH' : 'INVALID_ARGUMENT');
    if (!identifier(raw.topicId) || !Number.isFinite(instant(raw.at))) fail('INVALID_ARGUMENT');
    if (!Array.isArray(raw.evidence) || !plain(raw.scope)) fail('INVALID_ARGUMENT');
    const signal = {namespace, topicId: raw.topicId, at: raw.at,
      evidenceMaxAgeMs: raw.evidenceMaxAgeMs, watchDurationMs: raw.watchDurationMs,
      evidence: clone(raw.evidence), scope: clone(raw.scope)};
    if (plain(raw.source)) signal.source = clone(raw.source);
    if (plain(raw.classification)) signal.classification = clone(raw.classification);
    if (plain(raw.sourceContent)) signal.sourceContent = clone(raw.sourceContent);
    if (raw.requestsScopeExpansion === true) signal.requestsScopeExpansion = true;
    return signal;
  }
  function offered(policyOptions, selected) {
    return !!selected && policyOptions.some(option => option.id === selected.id
      && option.revision === selected.revision);
  }
  function commitInterest(signal, choice, userEnable) {
    requireReady();
    const current = clock();
    if (instant(signal.at) > current) fail('INVALID_ARGUMENT');
    const enablement = userEnable && userEnable.topicId === signal.topicId
      && identifier(userEnable.id) && Number.isFinite(instant(userEnable.occurredAt))
      ? {id: userEnable.id, topicId: signal.topicId, occurredAt: userEnable.occurredAt} : null;
    const input = policyInput({...signal, at: iso(current)}, enablement);
    let built;
    try { built = buildInterestOptions(input); }
    catch { fail('INVALID_ARGUMENT'); }
    const freshSelected = choice?.outcome === 'selected' && choice.requiresHostRevalidation === true
      && offered(built.options, choice.selected) ? choice.selected : null;
    const approach = built.policy.state === 'watch_public' && freshSelected?.id === 'track_public'
      ? 'track_public' : null;
    let formal = null;
    let blocked = null;
    if (needsFormalPolicy(signal)) {
      formal = formalDecision(signal);
      if (formal.allowed !== true) blocked = formal.reason;
    }
    if (approach !== 'track_public') formal = needsFormalPolicy(signal) ? formal : null;
    const selectedApproach = blocked ? null : approach;
    const [state, reason] = nextState(built.policy, signal, selectedApproach, blocked);
    const applied = {...signal, at: iso(current), userEnableApplied: Boolean(enablement)};
    const watch = writeWatch(applied, built.policy, state, reason, selectedApproach, formal, choice);
    return {accepted: true, watch};
  }

  function bindingKey(binding) {
    return `${binding.sourceId}\n${binding.revision}\n${binding.contentSha256}`;
  }
  function trackedGroups(sourceId) {
    const groups = new Map();
    for (const watch of Object.values(document.watches)) {
      if (watch.state !== 'tracked' || watch.boundSource?.sourceId !== sourceId) continue;
      const key = bindingKey(watch.boundSource);
      if (!groups.has(key)) groups.set(key, {binding: watch.boundSource, watches: []});
      groups.get(key).watches.push(watch);
    }
    return [...groups.values()];
  }
  function pickSource(raw) {
    if (!plain(raw) || !identifier(raw.sourceId)) fail('INVALID_ARGUMENT');
    if (raw.namespace !== namespace) fail('NAMESPACE_MISMATCH');
    if (!['available', 'unavailable', 'withdrawn'].includes(raw.availability)) fail('INVALID_ARGUMENT');
    if (!Number.isFinite(instant(raw.fetchedAt))) fail('INVALID_ARGUMENT');
    const event = {namespace, sourceId: raw.sourceId, availability: raw.availability, fetchedAt: raw.fetchedAt};
    if (text(raw.revision)) event.revision = raw.revision;
    if (typeof raw.contentSha256 === 'string') event.contentSha256 = raw.contentSha256;
    if (typeof raw.summary === 'string') event.summary = clip(raw.summary, 2000);
    if (plain(raw.citation) && text(raw.citation.locator)) event.citation = {locator: clip(raw.citation.locator, 500)};
    if (text(raw.cacheVersion)) event.cacheVersion = raw.cacheVersion;
    if (text(raw.requestedVersion)) event.requestedVersion = raw.requestedVersion;
    if (Number.isFinite(raw.maxAgeMs) && raw.maxAgeMs > 0) event.maxAgeMs = raw.maxAgeMs;
    if (text(raw.reason)) event.reason = clip(raw.reason, 200);
    if (text(raw.provider)) event.provider = clip(raw.provider, 80);
    if (text(raw.feedCursor)) event.feedCursor = raw.feedCursor;
    if (plain(raw.check)) event.check = clone(raw.check);
    return event;
  }
  function freshnessFor(group, event) {
    const binding = group.binding;
    const changed = event.availability === 'available'
      && (event.revision !== binding.revision || event.contentSha256 !== binding.contentSha256);
    const check = changed ? {outcome: 'changed', checkedAt: event.fetchedAt, sourceId: binding.sourceId,
      sourceRevision: binding.revision, cachedContentSha256: binding.contentSha256} : event.check;
    return {at: event.fetchedAt, maxAgeMs: event.maxAgeMs ?? knowledgeMaxAgeMs,
      requestedVersion: event.requestedVersion ?? binding.cacheVersion,
      sourceState: event.availability, cache: {version: binding.cacheVersion, sourceId: binding.sourceId,
        sourceRevision: binding.revision, contentSha256: binding.contentSha256,
        lastSuccessfulCheck: binding.lastSuccessfulCheck, validUntil: binding.validUntil},
      ...(check ? {check} : {})};
  }
  function prepareSource(event) {
    requireReady();
    const at = instant(event.fetchedAt);
    if (at > clock()) fail('INVALID_ARGUMENT');
    expireDue();
    const head = document.sources[event.sourceId];
    if (head && instant(head.observedAt) > at) return {accepted: false, reason: 'stale_event', duplicate: false};
    if (head && head.observedAt === event.fetchedAt && head.revision === (event.revision ?? null)
      && head.contentSha256 === (event.contentSha256 ?? null) && head.availability === event.availability) {
      return {accepted: true, reason: 'duplicate_event', duplicate: true, notified: false};
    }
    if (head && head.observedAt === event.fetchedAt) return {accepted: false, reason: 'ambiguous_timestamp'};
    if (event.availability === 'available' && event.revision && event.contentSha256
      && head?.revision === event.revision && head.contentSha256 && head.contentSha256 !== event.contentSha256) {
      return {accepted: false, reason: 'revision_hash_conflict'};
    }
    const plans = [];
    for (const group of trackedGroups(event.sourceId)) {
      if (event.availability === 'available' && event.revision === group.binding.revision
        && event.contentSha256 && event.contentSha256 !== group.binding.contentSha256) {
        return {accepted: false, reason: 'revision_hash_conflict'};
      }
      const prior = document.reevaluations[bindingKey(group.binding)];
      let plan;
      try {
        plan = planKnowledgeReevaluation({namespace, freshness: freshnessFor(group, event),
          dependencies: group.watches.filter(watch => watch.consumer).map(watch => ({
            consumer: clone(watch.consumer), sourceId: group.binding.sourceId,
            sourceRevision: group.binding.revision, contentSha256: group.binding.contentSha256})),
          ...(prior ? {checkpoint: clone(prior)} : {})});
      } catch { return {accepted: false, reason: 'invalid_source_event'}; }
      plans.push({group, plan});
    }
    const keys = [];
    const next = clone(document);
    for (const item of plans) {
      for (const work of item.plan.affected) {
        if (work.duplicate || next.submissions[work.workKey]?.state === 'accepted') continue;
        if (!next.submissions[work.workKey]) {
          next.submissions[work.workKey] = {state: 'unknown', namespace, attemptedAt: event.fetchedAt,
            sourceId: event.sourceId};
        }
        keys.push(work.workKey);
      }
    }
    if (keys.length && !workPort && event.availability === 'available') {
      return {accepted: false, reason: 'work_port_missing', proceed: false};
    }
    const skipWork = keys.length > 0 && !workPort;
    if (keys.length && workPort) persist(next);
    return {accepted: true, proceed: true, plans, event, keys: workPort ? keys : [], skipWork};
  }
  async function grantStatus() {
    if (typeof readTrackingGrant !== 'function') return 'unchecked';
    try {
      const grant = await readTrackingGrant({namespace});
      if (!plain(grant) || grant.state !== 'granted' || grant.publicLowRiskTracking !== true) return 'revoked';
      return 'granted';
    } catch { return 'unreadable'; }
  }
  async function boundStillTracked(work) {
    return lock(() => {
      if (!running || !document) return false;
      const topicId = work?.consumer?.id;
      if (!identifier(topicId) || document.tombstones[topicId]) return false;
      return document.watches[topicId]?.state === 'tracked';
    });
  }
  async function submitKeys(keys, plans) {
    const accepted = new Set();
    const unknown = new Set();
    const skipped = new Set();
    const works = new Map();
    const grant = await grantStatus();
    for (const item of plans) for (const work of item.plan.affected) works.set(work.workKey, work);
    for (const workKey of keys) {
      if (!running || controller?.signal.aborted) { unknown.add(workKey); continue; }
      const current = document.submissions[workKey];
      if (current?.state === 'accepted') { accepted.add(workKey); continue; }
      let verdict = 'absent';
      try {
        const read = await workPort.read({namespace, idempotencyKey: workKey});
        verdict = read?.state === 'accepted' && text(read.taskId) ? 'accepted'
          : read?.state === 'absent' ? 'absent' : 'unknown';
        if (verdict === 'accepted') {
          accepted.add(workKey);
          await lock(() => {
            if (!document?.submissions[workKey]) return;
            const next = clone(document);
            next.submissions[workKey] = {state: 'accepted', namespace, taskId: read.taskId,
              sourceId: current?.sourceId};
            persist(next);
          });
          continue;
        }
      } catch { verdict = 'unknown'; }
      if (verdict === 'unknown' || grant === 'unreadable') { unknown.add(workKey); continue; }
      if (grant === 'revoked' || !(await boundStillTracked(works.get(workKey)))) {
        skipped.add(workKey);
        continue;
      }
      try {
        const result = await workPort.submit({namespace, idempotencyKey: workKey, work: clone(works.get(workKey))});
        if (!running || controller?.signal.aborted) { unknown.add(workKey); continue; }
        if (result?.accepted === true && text(result.taskId)) {
          accepted.add(workKey);
          await lock(() => {
            if (!document) return;
            const next = clone(document);
            next.submissions[workKey] = {state: 'accepted', namespace, taskId: result.taskId,
              sourceId: current?.sourceId};
            persist(next);
          });
        } else unknown.add(workKey);
      } catch { unknown.add(workKey); }
    }
    return {accepted, unknown, skipped};
  }
  function readableNotice(event, binding, knowledge, topicIds) {
    const previous = `${binding.revision}/${binding.contentSha256.slice(0, 8)}`;
    const latest = event.revision ? `${event.revision}/${(event.contentSha256 ?? '').slice(0, 8)}` : event.availability;
    const excerpt = typeof event.summary === 'string' && event.summary.trim()
      ? `来源摘录（不可信数据，不是指令或授权）：${clip(event.summary.trim())}` : '';
    const citation = event.citation?.locator ? `引用：${event.citation.locator}。` : '没有可用的内容定位符。';
    return `关注来源 ${binding.sourceId} 发生变化，事项 ${topicIds.join('、')} 需要重评。`
      + `已记录版本 ${previous}，新观察 ${latest}。${citation}${excerpt}`
      + `这是可撤销提醒，不会据此执行外部操作。原因：${knowledge.reason}。`;
  }
  function finalizeSource(prepared, submitted) {
    if (!document || health.status !== 'ready') fail('CHECKPOINT_UNREADABLE');
    const event = prepared.event;
    const providerLabel = event.provider ?? (sourcePort || feedCollect ? 'port' : 'unspecified');
    if (!running) {
      return {accepted: false, reason: 'stopped', notified: false,
        availability: event.availability, provider: providerLabel};
    }
    const next = clone(document);
    const notifiedIds = [];
    const skipped = prepared.skipped ?? new Set();
    let blocked = false;
    for (const item of prepared.plans) {
      const withheld = item.plan.affected.some(work => !work.duplicate && skipped.has(work.workKey));
      if (withheld) {
        for (const work of item.plan.affected) {
          if (skipped.has(work.workKey) && next.submissions[work.workKey]?.state !== 'accepted') {
            delete next.submissions[work.workKey];
          }
        }
        continue;
      }
      if (!prepared.skipWork) {
        const pending = item.plan.affected.filter(work => !work.duplicate
          && !skipped.has(work.workKey)
          && next.submissions[work.workKey]?.state !== 'accepted');
        if (pending.length) { blocked = true; continue; }
        next.reevaluations[bindingKey(item.group.binding)] = clone(item.plan.checkpoint);
      }
      const fresh = item.plan.affected.filter(work => !work.duplicate);
      if (!fresh.length || item.plan.knowledge.action === 'use_cache') continue;
      const topicIds = item.group.watches.map(watch => watch.topicId)
        .filter(topicId => next.watches[topicId]?.state === 'tracked'
          || event.availability !== 'available' && next.watches[topicId]?.state !== 'revoked');
      if (!topicIds.length) continue;
      const id = digest({namespace, sourceId: event.sourceId, binding: item.group.binding.revision,
        content: item.group.binding.contentSha256, reason: item.plan.knowledge.reason,
        workKeys: fresh.map(work => work.workKey)});
      const locator = event.citation?.locator ?? null;
      if (next.notices[id]) {
        if (!text(next.notices[id].citation) && text(locator) && next.notices[id].delivered !== true) {
          next.notices[id].citation = locator;
          next.notices[id].summary = readableNotice(event, item.group.binding, item.plan.knowledge, topicIds);
          next.notices[id].deliveryReason = 'pending';
          notifiedIds.push(id);
        }
        continue;
      }
      next.notices[id] = {id, namespace, topicIds: [...topicIds], sourceId: event.sourceId,
        previous: {revision: item.group.binding.revision, contentSha256: item.group.binding.contentSha256},
        latest: {revision: event.revision ?? null, contentSha256: event.contentSha256 ?? null,
          fetchedAt: event.fetchedAt, availability: event.availability},
        citation: locator,
        knowledge: {action: item.plan.knowledge.action, reason: item.plan.knowledge.reason},
        summary: readableNotice(event, item.group.binding, item.plan.knowledge, topicIds),
        untrustedExcerpt: typeof event.summary === 'string' ? clip(event.summary.trim()) : null,
        createdAt: event.fetchedAt, delivered: false,
        deliveryReason: locator ? 'pending' : 'citation_missing', revocable: true};
      notifiedIds.push(id);
    }
    const confirmsBoundCache = prepared.plans.some(item => item.group.binding.revision === event.revision
      && item.group.binding.contentSha256 === event.contentSha256);
    const existing = next.sources[event.sourceId];
    const preserveHead = existing?.revision && confirmsBoundCache && existing.revision !== event.revision;
    if (!blocked && !preserveHead) {
      if (event.availability !== 'available') {
        for (const watch of Object.values(next.watches)) {
          if (watch.state === 'tracked' && watch.boundSource?.sourceId === event.sourceId) {
            watch.state = 'source_unavailable';
            watch.label = LABELS.source_unavailable;
            watch.reason = event.availability === 'withdrawn' ? 'source_withdrawn' : (event.reason ?? 'source_unavailable');
            watch.updatedAt = event.fetchedAt;
          }
        }
      }
      next.sources[event.sourceId] = {sourceId: event.sourceId, observedAt: event.fetchedAt,
        availability: event.availability, revision: event.revision ?? null,
        contentSha256: event.contentSha256 ?? null, provider: providerLabel,
        citation: event.citation?.locator ?? null,
        feedCursor: event.feedCursor ?? existing?.feedCursor ?? null,
        untrustedExcerpt: typeof event.summary === 'string' ? clip(event.summary.trim()) : null};
    }
    persist(next);
    const provider = providerLabel;
    return {accepted: !blocked, reason: blocked ? 'submission_unverified' : 'observed',
      duplicate: false, notified: notifiedIds.length > 0, noticeIds: notifiedIds,
      availability: event.availability, provider,
      submitted: submitted ? [...submitted.accepted] : []};
  }
  async function deliverPending() {
    if (!document) return;
    const pending = Object.values(document.notices).filter(notice => notice.delivered !== true);
    for (const notice of pending) {
      if (!running || controller?.signal.aborted) return;
      if (!text(notice.citation)) {
        await lock(() => {
          if (!document?.notices[notice.id] || !running) return;
          const next = clone(document);
          next.notices[notice.id].delivered = false;
          next.notices[notice.id].deliveryReason = 'citation_missing';
          persist(next);
        });
        continue;
      }
      if (typeof notificationPort?.send !== 'function') {
        await lock(() => {
          if (!document?.notices[notice.id] || !running) return;
          const next = clone(document);
          next.notices[notice.id].delivered = false;
          next.notices[notice.id].deliveryReason = 'notification_port_missing';
          persist(next);
        });
        continue;
      }
      let receipt = null;
      try {
        receipt = text(notice.receiptId) && typeof notificationPort.read === 'function'
          ? await notificationPort.read(clone(notice))
          : await notificationPort.send(clone(notice));
      } catch { receipt = null; }
      await lock(() => {
        if (!document?.notices[notice.id] || !running) return;
        const next = clone(document);
        const saved = next.notices[notice.id];
        if (receipt?.delivered === true && text(receipt.receiptId)) {
          saved.delivered = true;
          saved.receiptId = receipt.receiptId.trim();
          saved.deliveryReason = 'provider_receipt';
        } else if (text(receipt?.receiptId)) {
          saved.delivered = false;
          saved.receiptId = receipt.receiptId.trim();
          saved.deliveryReason = 'awaiting_acknowledgement';
        } else {
          saved.delivered = false;
          saved.deliveryReason = text(receipt?.reason) ? receipt.reason : (receipt ? 'invalid_receipt' : 'notification_failed');
          if (!text(saved.receiptId)) delete saved.receiptId;
        }
        persist(next);
      });
    }
  }
  function expireDue() {
    const current = clock();
    let changed = false;
    const next = clone(document);
    for (const watch of Object.values(next.watches)) {
      if (watch.state === 'tracked' && watch.expiresAt && instant(watch.expiresAt) <= current) {
        watch.state = 'expired';
        watch.label = LABELS.expired;
        watch.reason = 'watch_expired';
        watch.policyState = 'decay';
        changed = true;
      }
    }
    if (changed) persist(next);
  }

  async function scopeFromGrant(signal) {
    if (typeof readTrackingGrant !== 'function') return signal;
    let grant;
    try {
      grant = await readTrackingGrant({namespace, topicId: signal.topicId, sourceId: signal.source?.id ?? null});
    } catch { return null; }
    if (!plain(grant) || !['granted', 'none', 'revoked'].includes(grant.state) || !identifier(grant.id)
      || !Number.isSafeInteger(grant.revision) || grant.revision < 1
      || typeof grant.publicLowRiskTracking !== 'boolean'
      || !Number.isFinite(instant(grant.expiresAt))) return null;
    return {...signal, scope: {state: grant.state, id: grant.id, revision: grant.revision,
      publicLowRiskTracking: grant.publicLowRiskTracking, expiresAt: grant.expiresAt}};
  }
  function recordGrantUnreadable(signal) {
    requireReady();
    const watch = writeWatch({...signal, at: iso(clock())},
      {state: 'abstain', reason: 'grant_unreadable', evidence: []},
      'authorization_required', 'grant_unreadable', null, {allowed: false, reason: 'grant_unreadable'}, null);
    return {accepted: true, watch};
  }
  async function consumeInterestSignal(raw, request = {}) {
    let signal = pickInterest(raw);
    const userEnable = request.userEnable ?? null;
    await lock(() => { requireReady(); });
    const granted = await scopeFromGrant(signal);
    if (!granted) return lock(() => recordGrantUnreadable(signal));
    signal = granted;
    let choice = null;
    const preview = await lock(() => {
      requireReady();
      try { return buildInterestOptions(policyInput(signal, userEnable)); }
      catch { fail('INVALID_ARGUMENT'); }
    });
    if (preview.policy.state === 'watch_public' && interestDecider) {
      if (!text(request.deadline) || !(request.signal instanceof AbortSignal)) fail('INVALID_ARGUMENT');
      const listen = AbortSignal.any([request.signal, controller.signal]);
      choice = await interestDecider.choose(policyInput(signal, userEnable),
        {deadline: request.deadline, signal: listen});
      if (!running || controller.signal.aborted || request.signal.aborted) return {accepted: false, reason: 'stopped'};
      const again = await scopeFromGrant(signal);
      if (!again) return lock(() => recordGrantUnreadable(signal));
      signal = again;
    }
    const result = await lock(() => commitInterest(signal, choice, userEnable));
    return result;
  }
  async function consumeSourceUpdate(raw) {
    const event = pickSource(raw);
    const prepared = await lock(() => prepareSource(event));
    if (!prepared.proceed) return prepared;
    const submitted = prepared.keys?.length ? await submitKeys(prepared.keys, prepared.plans) : null;
    if (submitted?.skipped) prepared.skipped = submitted.skipped;
    const result = await lock(() => finalizeSource(prepared, submitted));
    await deliverPending();
    return result;
  }
  async function refreshSource(sourceId) {
    requireReady();
    if (!identifier(sourceId)) fail('INVALID_ARGUMENT');
    if (typeof sourcePort?.read !== 'function') {
      return {accepted: false, availability: 'unavailable', reason: 'source_provider_missing'};
    }
    let reading;
    try { reading = await sourcePort.read({namespace, sourceId, signal: controller.signal}); }
    catch (error) {
      if (!running || controller?.signal.aborted || error?.code === 'CANCELLED') {
        return {accepted: false, reason: 'stopped'};
      }
      if (['TIMEOUT', 'EXTERNAL_FAILURE', 'RATE_LIMITED'].includes(error?.code)) {
        return {accepted: false, availability: 'unavailable', reason: 'source_transient_failure', code: error.code};
      }
      return {accepted: false, availability: 'unavailable', reason: 'source_unavailable',
        ...(text(error?.code) ? {code: error.code} : {})};
    }
    if (!running || controller.signal.aborted) return {accepted: false, reason: 'stopped'};
    const availability = reading?.availability === 'withdrawn' ? 'withdrawn'
      : reading?.availability === 'available' ? 'available' : 'unavailable';
    const provider = text(reading?.provider) ? reading.provider : 'port';
    if (availability !== 'available') {
      return consumeSourceUpdate({namespace, sourceId, availability, fetchedAt: iso(clock()),
        reason: text(reading?.reason) ? reading.reason : 'source_unavailable', provider});
    }
    return consumeSourceUpdate({...reading, namespace, sourceId, availability, provider});
  }

  function mutateWatch(topicId, change) {
    requireReady();
    if (!identifier(topicId) || !document.watches[topicId] && change.requireWatch) fail('NOT_FOUND');
    const next = clone(document);
    change(next, topicId);
    persist(next);
    return clone(next.watches[topicId] ?? null);
  }
  function revoke(topicId, tombstone) {
    if (!identifier(topicId) || !plain(tombstone) || !identifier(tombstone.id)) fail('INVALID_ARGUMENT');
    const revokedAt = tombstone.revokedAt ?? iso(clock());
    if (!Number.isFinite(instant(revokedAt)) || instant(revokedAt) > clock()) fail('INVALID_ARGUMENT');
    return lock(() => {
      requireReady();
      return mutateWatch(topicId, next => {
        next.tombstones[topicId] = {id: tombstone.id, topicId, revokedAt};
        const previous = next.watches[topicId];
        next.watches[topicId] = {...(previous ?? {topicId, revision: 1, evidence: [],
          scope: {id: 'revoked', revision: 1, state: 'revoked', publicLowRiskTracking: false, expiresAt: revokedAt}}),
          topicId, state: 'revoked', label: LABELS.revoked, reason: 'user_revoked', policyState: 'revoked',
          revokedAt, tombstoneId: tombstone.id, updatedAt: revokedAt, selectedApproach: 'keep_revoked'};
      });
    });
  }
  function pause(topicId) {
    return lock(() => mutateWatch(topicId, (next, id) => {
      const watch = next.watches[id];
      if (!watch) fail('NOT_FOUND');
      if (watch.state === 'revoked') return;
      watch.state = 'paused';
      watch.label = LABELS.paused;
      watch.reason = 'user_paused';
      watch.updatedAt = iso(clock());
    }));
  }
  function resume(topicId) {
    return lock(() => mutateWatch(topicId, (next, id) => {
      const watch = next.watches[id];
      if (!watch) fail('NOT_FOUND');
      if (watch.state !== 'paused') return;
      if (next.tombstones[id]) {
        watch.state = 'revoked';
        watch.label = LABELS.revoked;
        watch.reason = 'user_revoked';
        watch.policyState = 'revoked';
        watch.revokedAt = next.tombstones[id].revokedAt;
        watch.tombstoneId = next.tombstones[id].id;
      } else if (watch.expiresAt && instant(watch.expiresAt) <= clock()) {
        watch.state = 'expired';
        watch.label = LABELS.expired;
        watch.reason = 'watch_expired';
        watch.policyState = 'decay';
      } else if (watch.selectedApproach === 'track_public' && watch.boundSource) {
        watch.state = 'tracked';
        watch.label = LABELS.tracked;
        watch.reason = 'user_resumed';
        watch.policyState = 'watch_public';
      } else {
        watch.state = 'suggested';
        watch.label = LABELS.suggested;
        watch.reason = 'user_resumed';
      }
      watch.updatedAt = iso(clock());
    }));
  }
  function enable(signal, enablement) {
    return consumeInterestSignal(signal, {userEnable: enablement, deadline: enablement?.deadline,
      signal: enablement?.signal});
  }

  function feedItemIdentity(item) {
    const record = item?.record;
    if (!plain(record) || !text(record.dedupeKey) || !text(record.contentRef)
      || !Number.isFinite(instant(record.occurredAt)) || !text(item.title)) return null;
    return {dedupeKey: record.dedupeKey, occurredAt: record.occurredAt, contentRef: record.contentRef,
      title: clip(item.title, 200), summary: typeof item.summary === 'string' ? clip(item.summary, 500) : ''};
  }
  function opaqueFeedRevision(validators, contentSha256) {
    if (text(validators?.etag) || text(validators?.lastModified)) {
      return digest({etag: validators.etag ?? null, lastModified: validators.lastModified ?? null});
    }
    return digest({body: contentSha256});
  }
  function readCollectResult(value) {
    if (!plain(value) || !Array.isArray(value.items) || !plain(value.collection) || !text(value.nextCursor)) return null;
    const collection = value.collection;
    if (!['fetched', 'unchanged'].includes(collection.state) || !identifier(collection.subscriptionId)
      || !Number.isFinite(instant(collection.fetchedAt)) || typeof value.hasMore !== 'boolean') return null;
    const validators = collection.validators;
    if (!plain(validators) || !Object.hasOwn(validators, 'etag') || !Object.hasOwn(validators, 'lastModified')) return null;
    if (validators.etag !== null && !text(validators.etag)) return null;
    if (validators.lastModified !== null && !text(validators.lastModified)) return null;
    if (collection.state === 'unchanged' && value.items.length > 0) return null;
    return value;
  }
  async function refreshSubscribedFeed(request = {}) {
    requireReady();
    if (typeof feedCollect !== 'function') {
      return {accepted: false, availability: 'unavailable', reason: 'source_provider_missing'};
    }
    const subscriptionId = request.subscriptionId ?? feedSubscriptionId;
    if (!identifier(subscriptionId)) fail('INVALID_ARGUMENT');
    if (feedReading) return {accepted: false, reason: 'feed_read_in_progress'};
    feedReading = true;
    const ticket = life;
    try {
      const grant = await grantStatus();
      if (grant === 'revoked') return {accepted: false, availability: 'unavailable', reason: 'authorization_required'};
      if (grant === 'unreadable') return {accepted: false, availability: 'unavailable', reason: 'grant_unreadable'};
      const cursor = document?.sources?.[subscriptionId]?.feedCursor;
      const query = {subscriptionId};
      if (text(cursor)) query.cursor = cursor;
      let result;
      try { result = await feedCollect(query, controller.signal); }
      catch (error) {
        if (ticket !== life || !running || controller.signal.aborted || error?.code === 'CANCELLED') {
          return {accepted: false, reason: 'stopped'};
        }
        if (['TIMEOUT', 'EXTERNAL_FAILURE', 'RATE_LIMITED'].includes(error?.code)) {
          return {accepted: false, availability: 'unavailable', reason: 'source_transient_failure', code: error.code};
        }
        if (error?.code === 'NOT_FOUND') {
          return consumeSourceUpdate({namespace, sourceId: subscriptionId, availability: 'withdrawn',
            fetchedAt: iso(clock()), reason: 'source_withdrawn', provider: 'feeds'});
        }
        return {accepted: false, availability: 'unavailable', reason: 'source_unavailable',
          code: text(error?.code) ? error.code : 'EXTERNAL_FAILURE'};
      }
      if (ticket !== life || !running || controller.signal.aborted) return {accepted: false, reason: 'stopped'};
      const collected = readCollectResult(result);
      if (!collected || collected.collection.subscriptionId !== subscriptionId) {
        return {accepted: false, availability: 'unavailable', reason: 'invalid_feed_result'};
      }
      if (instant(collected.collection.fetchedAt) > clock()) {
        return {accepted: false, availability: 'unavailable', reason: 'feed_clock_ahead'};
      }
      if (collected.hasMore) {
        await lock(() => {
          if (!running || !document || ticket !== life) return;
          const next = clone(document);
          const existing = next.sources[subscriptionId];
          if (existing) existing.feedCursor = collected.nextCursor;
          else next.sources[subscriptionId] = {sourceId: subscriptionId, observedAt: collected.collection.fetchedAt,
            availability: 'unavailable', revision: null, contentSha256: null, provider: 'feeds',
            feedCursor: collected.nextCursor, reason: 'feed_page_incomplete'};
          persist(next);
        });
        return {accepted: true, reason: 'feed_page_incomplete', provider: 'feeds', availability: 'unavailable'};
      }
      if (collected.collection.state === 'unchanged') {
        const head = document.sources[subscriptionId];
        if (!text(head?.revision) || !sha(head?.contentSha256)) {
          return {accepted: false, availability: 'unavailable', reason: 'source_body_not_read', provider: 'feeds'};
        }
        return consumeSourceUpdate({namespace, sourceId: subscriptionId, availability: 'available',
          revision: head.revision, contentSha256: head.contentSha256, fetchedAt: collected.collection.fetchedAt,
          provider: 'feeds', feedCursor: collected.nextCursor,
          ...(text(head.citation) ? {citation: {locator: head.citation}} : {}),
          check: {outcome: 'unchanged', checkedAt: collected.collection.fetchedAt, sourceId: subscriptionId,
            sourceRevision: head.revision, cachedContentSha256: head.contentSha256}});
      }
      const identities = [];
      for (const item of collected.items) {
        const identity = feedItemIdentity(item);
        if (!identity) return {accepted: false, availability: 'unavailable', reason: 'invalid_feed_result'};
        identities.push(identity);
      }
      identities.sort((left, right) => left.dedupeKey < right.dedupeKey ? -1 : left.dedupeKey > right.dedupeKey ? 1 : 0);
      const contentSha256 = digest(identities);
      const revision = opaqueFeedRevision(collected.collection.validators, contentSha256);
      const summary = identities.map(item => item.summary).filter(Boolean).join('\n');
      return consumeSourceUpdate({namespace, sourceId: subscriptionId, availability: 'available', revision,
        contentSha256, fetchedAt: collected.collection.fetchedAt, provider: 'feeds', feedCursor: collected.nextCursor,
        ...(text(identities[0]?.contentRef) ? {citation: {locator: identities[0].contentRef}} : {}),
        ...(summary ? {summary} : {})});
    } finally { feedReading = false; }
  }
  function registerFeedCheck(input) {
    if (!boundScheduler) return {accepted: false, reason: 'scheduler_missing'};
    let schedule;
    try { schedule = knowledgeWatchScheduleInput({namespace, runAt: input?.runAt, checkId: input?.checkId}); }
    catch (error) { return {accepted: false, reason: text(error?.code) ? error.code : 'INVALID_ARGUMENT'}; }
    try {
      const saved = boundScheduler.createSchedule(schedule);
      if (!plain(saved) || saved.scheduleId !== schedule.scheduleId) return {accepted: false, reason: 'scheduler_rejected'};
      registeredSchedule = true;
      return {accepted: true, schedule: clone(saved)};
    } catch (error) {
      return {accepted: false, reason: text(error?.code) ? error.code : 'scheduler_failed'};
    }
  }
  function cancelFeedChecks() {
    if (!boundScheduler) return {accepted: false, reason: 'scheduler_missing'};
    const conversationId = knowledgeWatchConversationId(namespace);
    let existing;
    try { existing = boundScheduler.listSchedules(conversationId); }
    catch (error) { return {accepted: false, reason: text(error?.code) ? error.code : 'scheduler_failed'}; }
    if (!Array.isArray(existing)) return {accepted: false, reason: 'scheduler_rejected'};
    const prefix = `knowledge-watch:${namespace}:`;
    if (existing.some(item => !text(item?.scheduleId) || !item.scheduleId.startsWith(prefix))) {
      return {accepted: false, reason: 'scheduler_conversation_not_exclusive'};
    }
    try {
      const saved = boundScheduler.reconcileSchedules(conversationId, []);
      registeredSchedule = false;
      return {accepted: true, schedules: Array.isArray(saved) ? clone(saved) : []};
    } catch (error) {
      return {accepted: false, reason: text(error?.code) ? error.code : 'scheduler_failed'};
    }
  }
  function restoreFeedChecks() {
    if (!boundScheduler) return {accepted: false, reason: 'scheduler_missing'};
    try {
      const saved = boundScheduler.listSchedules(knowledgeWatchConversationId(namespace));
      if (!Array.isArray(saved)) return {accepted: false, reason: 'scheduler_rejected'};
      return {accepted: true, schedules: clone(saved)};
    } catch (error) {
      return {accepted: false, reason: text(error?.code) ? error.code : 'scheduler_failed'};
    }
  }
  async function bindObservedRevision(topicId) {
    if (!identifier(topicId)) fail('INVALID_ARGUMENT');
    const prepared = await lock(() => {
      requireReady();
      if (document.tombstones[topicId]) return {accepted: false, reason: 'user_revoked'};
      const watch = document.watches[topicId];
      if (watch?.state === 'tracked' && watch.expiresAt && instant(watch.expiresAt) <= clock()) {
        return {accepted: false, reason: 'watch_expired'};
      }
      if (watch?.state !== 'tracked' || !watch.boundSource) return {accepted: false, reason: 'not_tracked'};
      if (!plain(watch.consumer) || watch.consumer.id !== topicId
        || !Number.isSafeInteger(watch.consumer.revision) || watch.consumer.revision < 1) {
        return {accepted: false, reason: 'reevaluation_consumer_missing'};
      }
      const binding = watch.boundSource;
      const head = document.sources[binding.sourceId];
      if (!head || head.availability !== 'available' || !text(head.revision) || !sha(head.contentSha256)
        || !text(head.citation) || !Number.isFinite(instant(head.observedAt))) {
        return {accepted: false, reason: 'observation_incomplete'};
      }
      if (head.revision === binding.revision && head.contentSha256 === binding.contentSha256) {
        return {accepted: false, reason: 'already_bound'};
      }
      if (instant(head.observedAt) < instant(binding.lastSuccessfulCheck)) {
        return {accepted: false, reason: 'observation_stale'};
      }
      const keys = document.reevaluations[bindingKey(binding)]?.submittedWorkKeys;
      if (!workPort || !Array.isArray(keys) || !keys.length || keys.some(key => !sha(key))) {
        return {accepted: false, reason: 'reevaluation_missing'};
      }
      const submissions = Object.fromEntries(keys.map(key => [key, clone(document.submissions[key] ?? null)]));
      if (Object.values(submissions).some(submission => submission?.state !== 'accepted'
        || !text(submission.taskId) || submission.sourceId !== binding.sourceId)) {
        return {accepted: false, reason: 'reevaluation_missing'};
      }
      return {accepted: true, proceed: true, keys: [...keys], binding: clone(binding),
        consumer: clone(watch.consumer ?? null), submissions,
        head: {sourceId: binding.sourceId, revision: head.revision, contentSha256: head.contentSha256,
          observedAt: head.observedAt, citation: head.citation}};
    });
    if (!prepared.proceed) return prepared;
    for (const workKey of prepared.keys) {
      let read;
      try { read = await workPort.read({namespace, idempotencyKey: workKey}); }
      catch { read = {state: 'unknown'}; }
      if (read?.state !== 'accepted' || read.taskState !== 'succeeded' || !text(read.taskId)) {
        return {accepted: false, reason: 'reevaluation_unconfirmed',
          taskState: text(read?.taskState) ? read.taskState : (text(read?.state) ? read.state : 'unknown')};
      }
      if (read.taskId !== prepared.submissions[workKey]?.taskId) {
        return {accepted: false, reason: 'reevaluation_task_mismatch', taskState: read.taskState};
      }
    }
    return lock(() => {
      requireReady();
      if (document.tombstones[topicId]) return {accepted: false, reason: 'user_revoked'};
      const watch = document.watches[topicId];
      if (watch?.state === 'expired') return {accepted: false, reason: 'watch_expired'};
      if (watch?.state !== 'tracked') return {accepted: false, reason: 'not_tracked'};
      if (watch.expiresAt && instant(watch.expiresAt) <= clock()) {
        return {accepted: false, reason: 'watch_expired'};
      }
      const binding = watch.boundSource;
      const head = binding ? document.sources[binding.sourceId] : null;
      if (!binding || binding.sourceId !== prepared.binding.sourceId
        || binding.revision !== prepared.binding.revision
        || binding.contentSha256 !== prepared.binding.contentSha256
        || binding.cacheVersion !== prepared.binding.cacheVersion
        || binding.lastSuccessfulCheck !== prepared.binding.lastSuccessfulCheck
        || binding.validUntil !== prepared.binding.validUntil
        || watch.consumer?.id !== prepared.consumer?.id
        || watch.consumer?.revision !== prepared.consumer?.revision
        || head?.revision !== prepared.head.revision || head?.contentSha256 !== prepared.head.contentSha256
        || head?.observedAt !== prepared.head.observedAt || head?.citation !== prepared.head.citation) {
        return {accepted: false, reason: 'observation_changed'};
      }
      // The host's current workPort contract only exposes generic task state and
      // identity. A succeeded task is not proof that it re-evaluated this consumer
      // against this observed source revision, regardless of which adapter read it.
      return {accepted: false, reason: 'reevaluation_result_unavailable', taskState: 'succeeded'};
    });
  }
  /** Confirms notification delivery by batch receipt; it does not mean the user read it. */
  function observeNotificationAcknowledgement(batch) {
    return lock(() => {
      requireReady();
      if (!plain(batch) || !text(batch.id) || batch.state !== 'delivered') {
        return {accepted: false, reason: 'acknowledgement_not_confirmed'};
      }
      const next = clone(document);
      let matched = 0;
      for (const notice of Object.values(next.notices)) {
        if (notice.receiptId === batch.id && notice.delivered !== true) {
          notice.delivered = true;
          notice.deliveryReason = 'acknowledged';
          matched += 1;
        }
      }
      if (!matched) return {accepted: false, reason: 'notice_not_found'};
      persist(next);
      return {accepted: true, matched};
    });
  }

  function start() {
    if (disposed) fail('DISPOSED');
    if (running) return snapshot();
    running = true;
    controller = new AbortController();
    if (health.status === 'ready') {
      try { expireDue(); } catch { /* expire persists only a ready document */ }
    }
    if (subscriptions) {
      unsubscribe = subscriptions.subscribe(event => {
        if (!running) return;
        const route = event?.type === 'source' ? consumeSourceUpdate(event)
          : event?.type === 'interest' ? consumeInterestSignal(event) : Promise.resolve();
        route.catch(() => {});
      });
      if (typeof unsubscribe !== 'function') {
        running = false;
        controller.abort();
        fail('INVALID_SUBSCRIPTION');
      }
      subscriptionActive = true;
    }
    return snapshot();
  }
  function stop() {
    if (disposed) return snapshot();
    life += 1;
    running = false;
    controller?.abort();
    if (typeof unsubscribe === 'function') unsubscribe();
    unsubscribe = null;
    subscriptionActive = false;
    if (registeredSchedule) cancelFeedChecks();
    return snapshot();
  }
  function dispose() {
    if (disposed) return snapshot();
    stop();
    disposed = true;
    subscriptions = null;
    return snapshot();
  }

  load();
  return Object.freeze({start, stop, dispose, snapshot, listPending, listWatches, dialogueProjection,
    consumeInterestSignal, consumeSourceUpdate, refreshSource, refreshSubscribedFeed,
    registerFeedCheck, cancelFeedChecks, restoreFeedChecks, observeNotificationAcknowledgement,
    bindObservedRevision,
    revoke, pause, resume, enable});
}
