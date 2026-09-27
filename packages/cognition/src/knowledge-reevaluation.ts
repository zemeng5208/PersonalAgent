import {createHash} from 'node:crypto';
import type {NodeRef} from '@personal-agent/goals';
import {decideKnowledgeFreshness} from './interest-policy.js';
import type {FreshnessDecision, FreshnessInput} from './interest-policy.js';

export interface KnowledgeDependency {
  readonly consumer: NodeRef;
  readonly sourceId: string;
  readonly sourceRevision: string;
  readonly contentSha256: string;
}
export interface KnowledgeReevaluationCheckpoint {
  readonly version: 1;
  readonly namespace: string;
  readonly source: {readonly id: string; readonly revision: string;
    readonly contentSha256: string; readonly cacheVersion: string};
  readonly observedAt: string;
  readonly status: FreshnessDecision['action'];
  readonly reason: string;
  /** Monotonic invalidation for this exact source revision and content hash. */
  readonly invalidation: 'content_changed' | 'source_withdrawn' | null;
  /** Keys whose original idempotent commands were durably submitted by the host. */
  readonly submittedWorkKeys: readonly string[];
}
export interface KnowledgeReevaluationInput {
  readonly namespace: string;
  readonly freshness: FreshnessInput;
  readonly dependencies: readonly KnowledgeDependency[];
  readonly checkpoint?: KnowledgeReevaluationCheckpoint;
}
export interface KnowledgeReevaluationWork {
  readonly action: 'RECHECK';
  readonly consumer: NodeRef;
  readonly source: {readonly id: string; readonly revision: string; readonly contentSha256: string};
  readonly workKey: string;
  /** True only when the host supplied a matching previously committed checkpoint. */
  readonly duplicate: boolean;
}
export interface KnowledgeReevaluationPlan {
  readonly knowledge: FreshnessDecision;
  readonly affected: readonly KnowledgeReevaluationWork[];
  /** Save only after every nonduplicate workKey is durably submitted under that exact command ID. */
  readonly checkpoint: KnowledgeReevaluationCheckpoint;
}

const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const hash = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function invalid(): never { throw Error('Invalid knowledge reevaluation input'); }
function object(v: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(v))
    || Reflect.ownKeys(v).some(key => typeof key !== 'string' || ![...keys, ...optional].includes(key))
    || keys.some(key => !Object.hasOwn(v, key))) return invalid();
  return v as Record<string, unknown>;
}
function instant(v: unknown): number {
  if (!text(v) || !Number.isFinite(Date.parse(v))) return invalid();
  return Date.parse(v);
}
function source(v: unknown): {id: string; revision: string; contentSha256: string; cacheVersion: string} {
  const value = object(v, ['id', 'revision', 'contentSha256', 'cacheVersion']);
  if (!text(value.id) || !text(value.revision) || !sha(value.contentSha256)
    || !text(value.cacheVersion)) return invalid();
  return value as {id: string; revision: string; contentSha256: string; cacheVersion: string};
}
function validate(v: unknown): asserts v is KnowledgeReevaluationInput {
  const input = object(v, ['namespace', 'freshness', 'dependencies'], ['checkpoint']);
  if (!text(input.namespace) || !Array.isArray(input.dependencies)) invalid();
  const fresh = object(input.freshness,
    ['at', 'maxAgeMs', 'requestedVersion', 'sourceState', 'cache'], ['check']);
  const at = instant(fresh.at);
  if (!Number.isFinite(fresh.maxAgeMs) || (fresh.maxAgeMs as number) <= 0
    || !text(fresh.requestedVersion)
    || !['available', 'unavailable', 'withdrawn'].includes(fresh.sourceState as string)) invalid();
  const cache = object(fresh.cache, ['version', 'sourceId', 'sourceRevision',
    'contentSha256', 'lastSuccessfulCheck', 'validUntil']);
  if (!text(cache.version) || !text(cache.sourceId) || !text(cache.sourceRevision)
    || !sha(cache.contentSha256) || instant(cache.lastSuccessfulCheck) > at) invalid();
  instant(cache.validUntil);
  if (fresh.check !== undefined) {
    const check = object(fresh.check, ['outcome', 'checkedAt', 'sourceId',
      'sourceRevision', 'cachedContentSha256']);
    if (!['changed', 'unchanged', 'failed'].includes(check.outcome as string)
      || check.sourceId !== cache.sourceId || check.sourceRevision !== cache.sourceRevision
      || check.cachedContentSha256 !== cache.contentSha256
      || instant(check.checkedAt) < instant(cache.lastSuccessfulCheck)
      || instant(check.checkedAt) > at) invalid();
  }
  for (const value of input.dependencies) {
    const dependency = object(value, ['consumer', 'sourceId', 'sourceRevision', 'contentSha256']);
    const consumer = object(dependency.consumer, ['id', 'revision']);
    if (!text(consumer.id) || !Number.isSafeInteger(consumer.revision)
      || (consumer.revision as number) < 1 || !text(dependency.sourceId)
      || !text(dependency.sourceRevision) || !sha(dependency.contentSha256)) invalid();
  }
  if (input.checkpoint !== undefined) {
    const checkpoint = object(input.checkpoint,
      ['version', 'namespace', 'source', 'observedAt', 'status', 'reason', 'invalidation', 'submittedWorkKeys']);
    const priorSource = source(checkpoint.source);
    if (checkpoint.version !== 1 || checkpoint.namespace !== input.namespace
      || priorSource.id !== cache.sourceId || instant(checkpoint.observedAt) > at
      || (priorSource.revision === cache.sourceRevision
        && priorSource.contentSha256 !== cache.contentSha256)
      || !['use_cache', 'refresh_required', 'last_verified_only', 'unavailable'].includes(checkpoint.status as string)
      || ![null, 'content_changed', 'source_withdrawn'].includes(checkpoint.invalidation as string | null)
      || !text(checkpoint.reason) || !Array.isArray(checkpoint.submittedWorkKeys)
      || checkpoint.submittedWorkKeys.some(key => !sha(key))
      || new Set(checkpoint.submittedWorkKeys).size !== checkpoint.submittedWorkKeys.length) invalid();
  }
}

/** Pure plan. No task, checkpoint, cache, graph or external state is written. */
export function planKnowledgeReevaluation(input: KnowledgeReevaluationInput): KnowledgeReevaluationPlan {
  const snapshot = structuredClone(input);
  validate(snapshot);
  const fresh = snapshot.freshness;
  const old = snapshot.checkpoint;
  const binding = {id: fresh.cache.sourceId, revision: fresh.cache.sourceRevision,
    contentSha256: fresh.cache.contentSha256, cacheVersion: fresh.cache.version};
  let knowledge = decideKnowledgeFreshness(fresh);
  // A later unchanged receipt for the same cached content cannot undo a
  // confirmed content change or withdrawal. New content identity is required.
  const sameContent = old?.source.revision === binding.revision
    && old.source.contentSha256 === binding.contentSha256;
  const invalidation = (sameContent && old?.invalidation === 'source_withdrawn')
    || knowledge.reason === 'source_withdrawn' ? 'source_withdrawn'
    : knowledge.reason === 'content_changed' ? 'content_changed'
    : sameContent ? old?.invalidation ?? null : null;
  if (invalidation === 'source_withdrawn' && sameContent) {
    knowledge = {...knowledge, action: 'unavailable', reason: 'source_withdrawn'};
  } else if (invalidation === 'content_changed' && knowledge.action === 'use_cache') {
    knowledge = {...knowledge,
      action: 'refresh_required', reason: 'content_changed'};
  }
  // Runtime owns permanent command idempotency. This receipt only remembers
  // submissions for the current content identity, not all historical sources.
  const priorKeys = new Set(sameContent ? old?.submittedWorkKeys ?? [] : []);
  const affected: KnowledgeReevaluationWork[] = [];
  if (knowledge.action !== 'use_cache') {
    const consumers = new Map<string, NodeRef>();
    for (const dependency of snapshot.dependencies) {
      if (dependency.sourceId !== binding.id || dependency.sourceRevision !== binding.revision
        || dependency.contentSha256 !== binding.contentSha256) continue;
      const consumer = dependency.consumer;
      consumers.set(JSON.stringify([consumer.id, consumer.revision]),
        {id: consumer.id, revision: consumer.revision});
    }
    for (const consumer of [...consumers.values()].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : a.revision - b.revision)) {
      const workKey = hash({namespace: snapshot.namespace, source: binding,
        requestedVersion: fresh.requestedVersion, consumer,
        action: knowledge.action, reason: knowledge.reason});
      affected.push({action: 'RECHECK', consumer,
        source: {id: binding.id, revision: binding.revision, contentSha256: binding.contentSha256},
        workKey, duplicate: priorKeys.has(workKey)});
    }
  }
  const checkpoint: KnowledgeReevaluationCheckpoint = {version: 1, namespace: snapshot.namespace,
    source: binding, observedAt: fresh.at, status: knowledge.action, reason: knowledge.reason,
    invalidation,
    submittedWorkKeys: [...new Set([...priorKeys, ...affected.map(item => item.workKey)])].sort()};
  return structuredClone({knowledge, affected, checkpoint});
}
