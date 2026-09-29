import {createHash} from 'node:crypto';
import {buildInterestOptions, planKnowledgeReevaluation} from '@personal-agent/cognition';

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

/** Explicit fake. It never reports a fetched document or a successful network read. */
export function createUnavailableSourcePort(reason = 'source_provider_missing') {
  return Object.freeze({
    kind: 'fake',
    availability: 'unavailable',
    read() {
      return Promise.resolve({availability: 'unavailable', reason, provider: 'fake'});
    },
  });
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
  workPort = null,
  notificationPort = null,
  policyPort = null,
  knowledgeMaxAgeMs = 2 * 60 * 60 * 1000,
} = {}) {
  if (profile !== PROFILE || !identifier(namespace) || !identifier(checkpointTaskId)
    || typeof checkpoints?.loadCheckpoint !== 'function'
    || typeof checkpoints?.saveCheckpoint !== 'function'
    || typeof now !== 'function'
    || !Number.isFinite(knowledgeMaxAgeMs) || knowledgeMaxAgeMs <= 0) fail('INVALID_ARGUMENT');
  if (sourcePort && typeof sourcePort.read !== 'function') fail('INVALID_ARGUMENT');
  if (subscriptions && typeof subscriptions.subscribe !== 'function') fail('INVALID_ARGUMENT');
  if (interestDecider && typeof interestDecider.choose !== 'function') fail('INVALID_ARGUMENT');
  if (workPort && (typeof workPort.submit !== 'function' || typeof workPort.read !== 'function')) fail('INVALID_ARGUMENT');
  if (notificationPort && typeof notificationPort.send !== 'function') fail('INVALID_ARGUMENT');
  if (policyPort && typeof policyPort.evaluate !== 'function') fail('INVALID_ARGUMENT');

  const checkpointKey = knowledgeWatchCheckpointKey(namespace);
  const unavailablePort = sourcePort ?? createUnavailableSourcePort();
  let document = null;
  let health = {status: 'ready'};
  let running = false;
  let disposed = false;
  let unsubscribe = null;
  let controller = null;
  let chain = Promise.resolve();
  let subscriptionActive = false;

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
      source: sourcePort ? 'injected' : 'unavailable_fake',
      subscription: subscriptionActive,
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
  function snapshot() {
    const base = {namespace, running, disposed, health: clone(health), wiring: wiring(),
      checkpointKey, mountedInMain: false};
    if (!document) return {...base, watches: null, notices: null, submissions: null, sources: null};
    return {...base,
      watches: Object.values(document.watches).map(projectWatch)
        .sort((a, b) => a.topicId < b.topicId ? -1 : a.topicId > b.topicId ? 1 : 0),
      notices: Object.values(document.notices).map(clone),
      submissions: clone(document.submissions),
      sources: clone(document.sources)};
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
    const freshSelected = choice?.outcome === 'selected' && offered(built.options, choice.selected)
      ? choice.selected : null;
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
  async function submitKeys(keys, plans) {
    const accepted = new Set();
    const unknown = new Set();
    const works = new Map();
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
      if (verdict === 'unknown') { unknown.add(workKey); continue; }
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
    return {accepted, unknown};
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
    if (!running) {
      return {accepted: false, reason: 'stopped', notified: false,
        availability: event.availability, provider: event.provider ?? (sourcePort ? 'port' : 'fake')};
    }
    const next = clone(document);
    const notifiedIds = [];
    let blocked = false;
    for (const item of prepared.plans) {
      if (!prepared.skipWork) {
        const pending = item.plan.affected.filter(work => !work.duplicate
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
      if (event.availability === 'available' && !event.citation?.locator) continue;
      const id = digest({namespace, sourceId: event.sourceId, binding: item.group.binding.revision,
        content: item.group.binding.contentSha256, reason: item.plan.knowledge.reason,
        workKeys: fresh.map(work => work.workKey)});
      if (next.notices[id]) continue;
      next.notices[id] = {id, namespace, topicIds: [...topicIds], sourceId: event.sourceId,
        previous: {revision: item.group.binding.revision, contentSha256: item.group.binding.contentSha256},
        latest: {revision: event.revision ?? null, contentSha256: event.contentSha256 ?? null,
          fetchedAt: event.fetchedAt, availability: event.availability},
        citation: event.citation?.locator ?? null,
        knowledge: {action: item.plan.knowledge.action, reason: item.plan.knowledge.reason},
        summary: readableNotice(event, item.group.binding, item.plan.knowledge, topicIds),
        untrustedExcerpt: typeof event.summary === 'string' ? clip(event.summary.trim()) : null,
        createdAt: event.fetchedAt, delivered: false, deliveryReason: 'pending', revocable: true};
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
        contentSha256: event.contentSha256 ?? null, provider: event.provider ?? (sourcePort ? 'port' : 'fake'),
        citation: event.citation?.locator ?? null,
        untrustedExcerpt: typeof event.summary === 'string' ? clip(event.summary.trim()) : null};
    }
    persist(next);
    const provider = event.provider ?? (sourcePort ? 'port' : 'fake');
    return {accepted: !blocked, reason: blocked ? 'submission_unverified' : 'observed',
      duplicate: false, notified: notifiedIds.length > 0, noticeIds: notifiedIds,
      availability: event.availability, provider,
      submitted: submitted ? [...submitted.accepted] : []};
  }
  async function deliverPending() {
    if (!document) return;
    const pending = Object.values(document.notices).filter(notice => notice.delivered !== true
      && notice.deliveryReason !== 'citation_missing');
    for (const notice of pending) {
      if (!running || controller?.signal.aborted) return;
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
      try { receipt = await notificationPort.send(clone(notice)); }
      catch { receipt = null; }
      await lock(() => {
        if (!document?.notices[notice.id] || !running) return;
        const next = clone(document);
        const saved = next.notices[notice.id];
        if (receipt?.delivered === true && text(receipt.receiptId)) {
          saved.delivered = true;
          saved.receiptId = receipt.receiptId.trim();
          saved.deliveryReason = 'provider_receipt';
        } else {
          saved.delivered = false;
          saved.deliveryReason = receipt ? 'invalid_receipt' : 'notification_failed';
          delete saved.receiptId;
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

  async function consumeInterestSignal(raw, request = {}) {
    const signal = pickInterest(raw);
    const userEnable = request.userEnable ?? null;
    await lock(() => { requireReady(); });
    let choice = null;
    const preview = await lock(() => {
      requireReady();
      try { return buildInterestOptions(policyInput(signal, userEnable)); }
      catch { fail('INVALID_ARGUMENT'); }
    });
    if (preview.policy.state === 'watch_public' && interestDecider) {
      if (!text(request.deadline) || !(request.signal instanceof AbortSignal)) fail('INVALID_ARGUMENT');
      choice = await interestDecider.choose(policyInput(signal, userEnable),
        {deadline: request.deadline, signal: controller.signal});
      if (!running || controller.signal.aborted) return {accepted: false, reason: 'stopped'};
    }
    const result = await lock(() => commitInterest(signal, choice, userEnable));
    return result;
  }
  async function consumeSourceUpdate(raw) {
    const event = pickSource(raw);
    const prepared = await lock(() => prepareSource(event));
    if (!prepared.proceed) return prepared;
    const submitted = prepared.keys?.length ? await submitKeys(prepared.keys, prepared.plans) : null;
    const result = await lock(() => finalizeSource(prepared, submitted));
    await deliverPending();
    return result;
  }
  async function refreshSource(sourceId) {
    requireReady();
    if (!identifier(sourceId)) fail('INVALID_ARGUMENT');
    const reading = await unavailablePort.read({namespace, sourceId, signal: controller.signal});
    if (!running || controller.signal.aborted) return {accepted: false, reason: 'stopped'};
    const availability = reading?.availability === 'withdrawn' ? 'withdrawn'
      : reading?.availability === 'available' ? 'available' : 'unavailable';
    if (availability !== 'available') {
      return consumeSourceUpdate({namespace, sourceId, availability, fetchedAt: iso(clock()),
        reason: text(reading?.reason) ? reading.reason : 'source_unavailable',
        provider: reading?.provider ?? 'fake'});
    }
    return consumeSourceUpdate({...reading, namespace, sourceId, availability, provider: 'port'});
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
    running = false;
    controller?.abort();
    if (typeof unsubscribe === 'function') unsubscribe();
    unsubscribe = null;
    subscriptionActive = false;
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
  return Object.freeze({start, stop, dispose, snapshot, listPending, listWatches,
    consumeInterestSignal, consumeSourceUpdate, refreshSource, revoke, pause, resume, enable});
}
