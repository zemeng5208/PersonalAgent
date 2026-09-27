/** Pure host advisory policy. It neither grants permission nor starts a watcher. */
export type InterestState = 'candidate' | 'watch_public' | 'abstain' | 'decay' | 'revoked';
export interface InterestEvidence {
  readonly id: string;
  readonly topicId: string;
  readonly sourceId: string;
  readonly sourceRevision: string;
  readonly occurredAt: string;
  readonly interactionId: string;
  readonly kind: 'question' | 'followup' | 'bookmark' | 'active_goal';
  /** Exact identity or a host-verified semantic relation; keywords alone are insufficient. */
  readonly match: 'exact' | 'semantic' | 'keyword';
  readonly relatedEvidenceId?: string;
}
export interface InterestEvidenceRef {
  readonly id: string;
  readonly topicId: string;
  readonly sourceId: string;
  readonly sourceRevision: string;
}
export interface InterestPolicyInput {
  readonly topicId: string;
  readonly at: string;
  readonly evidenceMaxAgeMs: number;
  readonly watchDurationMs: number;
  readonly evidence: readonly InterestEvidence[];
  /** Host-verified source identity; transport must independently enforce URL/DNS rules on every fetch. */
  readonly source?: {readonly id: string; readonly revision: string; readonly visibility: 'public' | 'private';
    readonly risk: 'low' | 'high'; readonly transportVerified: boolean; readonly verificationExpiresAt: string};
  readonly scope: {readonly state: 'granted' | 'none' | 'revoked'; readonly id: string;
    readonly revision: number; readonly publicLowRiskTracking: boolean; readonly expiresAt: string};
  readonly previous?: {readonly state: InterestState};
  readonly tombstone?: {readonly id: string; readonly topicId: string; readonly revokedAt: string};
  /** Only a new, explicit user action may supersede a tombstone; model output cannot supply this. */
  readonly explicitEnable?: {readonly id: string; readonly topicId: string; readonly occurredAt: string};
  readonly classification?: {readonly label: 'sustained' | 'incidental' | 'uncertain'; readonly abstained: boolean;
    readonly evidence: readonly InterestEvidenceRef[]; readonly calibrated: false};
}
export interface InterestPolicyDecision {
  readonly state: InterestState;
  readonly topicId: string;
  readonly reason: string;
  readonly evidence: readonly InterestEvidenceRef[];
  readonly source?: {readonly id: string; readonly revision: string};
  readonly scopeRevision: number;
  readonly expiresAt?: string;
  readonly classificationCalibrated: false;
}
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
function time(v: string): number {
  const value = Date.parse(v);
  if (!Number.isFinite(value)) throw Error('Invalid interest policy timestamp');
  return value;
}
function duration(v: number): void {
  if (!Number.isFinite(v) || v <= 0) throw Error('Invalid interest policy duration');
}
const reference = (e: InterestEvidence): InterestEvidenceRef => ({id:e.id,topicId:e.topicId,sourceId:e.sourceId,sourceRevision:e.sourceRevision});
const identity = (e: InterestEvidenceRef): string => JSON.stringify([e.id,e.topicId,e.sourceId,e.sourceRevision]);

export function decideInterest(input: InterestPolicyInput): InterestPolicyDecision {
  const now = time(input.at);
  duration(input.evidenceMaxAgeMs); duration(input.watchDurationMs);
  if (!text(input.topicId) || !text(input.scope.id) || !Number.isSafeInteger(input.scope.revision) || input.scope.revision < 1) throw Error('Invalid interest policy scope');
  const scopeExpiry = time(input.scope.expiresAt);
  const refs: InterestEvidenceRef[] = [];
  const result = (state: InterestState, reason: string, expiresAt?: number): InterestPolicyDecision => ({state,topicId:input.topicId,reason,
    evidence:refs.map(ref => ({...ref})),scopeRevision:input.scope.revision,classificationCalibrated:false,
    ...(input.source ? {source:{id:input.source.id,revision:input.source.revision}} : {}),
    ...(expiresAt === undefined ? {} : {expiresAt:new Date(expiresAt).toISOString()})});
  const enable = input.explicitEnable;
  const explicitlyEnabled = Boolean(enable && text(enable.id) && enable.topicId === input.topicId
    && time(enable.occurredAt) <= now && now-time(enable.occurredAt) <= input.evidenceMaxAgeMs);
  if (input.previous?.state === 'revoked' && !input.tombstone) return result('revoked','revocation_history_required');
  if (input.tombstone) {
    if (input.tombstone.topicId !== input.topicId || !text(input.tombstone.id) || time(input.tombstone.revokedAt) > now) throw Error('Invalid interest revocation');
    if (!explicitlyEnabled || enable!.id === input.tombstone.id || time(enable!.occurredAt) <= time(input.tombstone.revokedAt)) return result('revoked','user_revoked');
  }
  if (input.scope.state === 'revoked') return result('revoked','scope_revoked');
  if (input.scope.state !== 'granted' || !input.scope.publicLowRiskTracking || scopeExpiry <= now) return result('abstain','tracking_scope_unavailable');
  const seen = new Map<string, InterestEvidence>();
  for (const e of input.evidence) {
    if (![e.id,e.topicId,e.sourceId,e.sourceRevision,e.interactionId].every(text)
      || !['question','followup','bookmark','active_goal'].includes(e.kind) || !['exact','semantic','keyword'].includes(e.match)) throw Error('Invalid interest evidence');
    const occurred = time(e.occurredAt);
    if (e.topicId !== input.topicId || e.match === 'keyword' || occurred > now || now-occurred > input.evidenceMaxAgeMs) continue;
    const prior = seen.get(e.id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(e)) throw Error('Conflicting interest evidence');
    seen.set(e.id,e);
  }
  const evidence = [...seen.values()];
  refs.push(...evidence.map(reference));
  if (!evidence.length && !explicitlyEnabled) return result(input.previous?.state === 'watch_public' ? 'decay' : 'abstain','no_current_topic_evidence');
  const source = input.source;
  if (!source || !text(source.id) || !text(source.revision) || source.visibility !== 'public' || source.risk !== 'low'
    || source.transportVerified !== true || time(source.verificationExpiresAt) <= now) return result('abstain','public_source_not_verified');
  const latest = Math.max(...evidence.map(e => time(e.occurredAt)),explicitlyEnabled ? time(enable!.occurredAt) : -Infinity);
  const expiry = Math.min(now+input.watchDurationMs,latest+input.evidenceMaxAgeMs,scopeExpiry,time(source.verificationExpiresAt));
  if (explicitlyEnabled) return result('watch_public','explicit_user_enable',expiry);
  const hint = input.classification;
  const bound = hint?.calibrated === false && hint.evidence.length === refs.length
    && new Set(hint.evidence.map(identity)).size === refs.length
    && hint.evidence.every(ref => refs.some(candidate => identity(candidate) === identity(ref)));
  if (hint && (!bound || hint.abstained || hint.label !== 'sustained')) return result('abstain','classification_uncertain_or_unbound');
  const question = evidence.some(e => e.kind === 'question');
  const linkedFollowup = evidence.some(e => e.kind === 'followup' && e.relatedEvidenceId && evidence.some(parent =>
    parent.id === e.relatedEvidenceId && parent.id !== e.id && time(parent.occurredAt) <= time(e.occurredAt)
    && ['question','followup'].includes(parent.kind)));
  const bookmark = evidence.some(e => e.kind === 'bookmark');
  const goal = evidence.some(e => e.kind === 'active_goal');
  const contextualPattern = (question && linkedFollowup) || (bookmark && (question || goal)) || (goal && question);
  const repeatedWithSemanticJudgment = bound && hint?.label === 'sustained'
    && new Set(evidence.filter(e => e.kind === 'question').map(e => e.interactionId)).size > 1;
  if (!contextualPattern && !repeatedWithSemanticJudgment) return result('candidate','insufficient_contextual_evidence',expiry);
  return result('watch_public',repeatedWithSemanticJudgment ? 'bound_classification_and_repeated_interest' : 'topic_linked_behavior',expiry);
}

export interface FreshnessInput {
  readonly at: string;
  readonly maxAgeMs: number;
  readonly requestedVersion: string;
  readonly sourceState: 'available' | 'unavailable' | 'withdrawn';
  readonly cache: {readonly version: string; readonly sourceId: string; readonly sourceRevision: string;
    readonly contentSha256: string; readonly lastSuccessfulCheck: string; readonly validUntil: string};
  /** Receipt from the trusted fetch/readback path, never a model assertion or raw ETag. */
  readonly check?: {readonly outcome: 'changed' | 'unchanged' | 'failed'; readonly checkedAt: string;
    readonly sourceId: string; readonly sourceRevision: string; readonly cachedContentSha256: string};
}
export interface FreshnessDecision {
  readonly action: 'use_cache' | 'refresh_required' | 'last_verified_only' | 'unavailable';
  readonly reason: string;
  readonly matchVersion: boolean;
  readonly lastSuccessfulCheck: string;
  readonly sourceId: string;
  readonly sourceRevision: string;
  readonly contentSha256: string;
}
export function decideKnowledgeFreshness(input: FreshnessInput): FreshnessDecision {
  const now = time(input.at), cache = input.cache;
  duration(input.maxAgeMs);
  const last = time(cache.lastSuccessfulCheck), validUntil = time(cache.validUntil);
  if (![input.requestedVersion,cache.version,cache.sourceId,cache.sourceRevision].every(text)
    || !/^[a-f0-9]{64}$/.test(cache.contentSha256) || last > now) throw Error('Invalid freshness source');
  const matchVersion = input.requestedVersion === cache.version;
  const result = (action: FreshnessDecision['action'], reason: string, checkedAt = cache.lastSuccessfulCheck): FreshnessDecision =>
    ({action,reason,matchVersion,lastSuccessfulCheck:checkedAt,sourceId:cache.sourceId,sourceRevision:cache.sourceRevision,contentSha256:cache.contentSha256});
  if (input.sourceState === 'withdrawn') return result('unavailable','source_withdrawn');
  if (!matchVersion) return result('refresh_required','version_mismatch');
  if (input.sourceState !== 'available') return result('last_verified_only','source_unavailable');
  let checkedAt = cache.lastSuccessfulCheck;
  if (input.check) {
    const check = input.check, checked = time(check.checkedAt);
    if (check.sourceId !== cache.sourceId || check.sourceRevision !== cache.sourceRevision
      || check.cachedContentSha256 !== cache.contentSha256 || checked < last || checked > now) return result('last_verified_only','unbound_check');
    if (check.outcome === 'changed') return result('refresh_required','content_changed');
    if (check.outcome === 'failed') return result('last_verified_only','verification_failed');
    if (check.outcome !== 'unchanged') return result('last_verified_only','invalid_check');
    checkedAt = check.checkedAt;
  }
  // A conditional HTTP response cannot renew the fact's own validity window.
  if (validUntil <= now || now-time(checkedAt) > input.maxAgeMs) return result('last_verified_only','verification_expired',checkedAt);
  return result('use_cache','bound_current_version',checkedAt);
}
