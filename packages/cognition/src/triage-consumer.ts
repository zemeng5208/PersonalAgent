import {createHash} from 'node:crypto';
import type {LayaTriageMessage, LayaTriageResult} from './laya-triage.js';

export interface TriageDispatchInput {
  /** Trusted host scope. This function does not resolve a mailbox or grant access. */
  readonly namespace: string;
  readonly messages: readonly LayaTriageMessage[];
  readonly labels: Readonly<Record<string, string>>;
  readonly results: readonly LayaTriageResult[];
}

export interface TriageDispatchRef {
  readonly source: string;
  readonly messageId: string;
  readonly sourceRevision: string;
  readonly receipt: LayaTriageResult['receipt'];
  /** Stable input for the existing Runtime idempotency boundary. */
  readonly workKey: string;
}

export interface TriageDeferredRef extends TriageDispatchRef {
  readonly reason: 'invalid_response' | 'unavailable' | 'cancelled' | 'deadline' | 'insufficient_input';
  /** Preserve the classifier's host-impact route without dispatching unfinished work. */
  readonly requiredRoute: 'main_agent' | 'review';
}

export interface TriageDispatch {
  readonly groups: readonly {readonly label: string; readonly refs: readonly TriageDispatchRef[]}[];
  /** Source-backed reasoning belongs to AgentArts and the host, not this adapter. */
  readonly mainAgent: readonly TriageDispatchRef[];
  /** Machine re-evaluation; this is not a user approval request. */
  readonly review: readonly TriageDispatchRef[];
  /** Not classified; retain for retry or machine review in the existing host. */
  readonly deferred: readonly TriageDeferredRef[];
}

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
function invalid(): never { throw new Error('Invalid local triage dispatch'); }
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const probability = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const identity = (source: string, messageId: string): string => JSON.stringify([source, messageId]);
const compareRefs = (a: TriageDispatchRef, b: TriageDispatchRef): number =>
  a.source.localeCompare(b.source) || a.messageId.localeCompare(b.messageId)
  || a.sourceRevision.localeCompare(b.sourceRevision);

function validScores(value: unknown, labels: readonly string[]): value is NonNullable<LayaTriageResult['scores']> {
  if (!record(value) || typeof value.choice !== 'string' || !labels.includes(value.choice)
    || !record(value.probabilities) || Object.keys(value.probabilities).length !== labels.length
    || !probability(value.answerConfidence) || !probability(value.entropyConcentration)
    || !probability(value.margin)) return false;
  const probabilities = value.probabilities;
  const distribution = labels.map(label => probabilities[label]);
  if (!distribution.every(probability)) return false;
  const sorted = (distribution as number[]).sort((a, b) => b - a);
  return Math.abs(distribution.reduce((a, b) => a + b, 0) - 1) <= 0.005
    && Math.abs(probabilities[value.choice] as number - sorted[0]!) <= 0.0002
    && Math.abs(value.answerConfidence - sorted[0]!) <= 0.0002
    && Math.abs(value.margin - (sorted[0]! - sorted[1]!)) <= 0.0002;
}

/** Validate a same-call Laya result and prepare metadata only. No source read, write, or cloud call. */
export function prepareTriageDispatch(input: TriageDispatchInput): TriageDispatch {
  if (input === null || typeof input !== 'object' || Array.isArray(input)
    || typeof input.namespace !== 'string' || !input.namespace.trim()
    || !Array.isArray(input.messages)
    || !record(input.labels) || !Array.isArray(input.results)) invalid();
  const labels: Record<string, string> = {...input.labels};
  const keys = Object.keys(labels);
  if (keys.length < 2 || keys.length > 16 || keys.some(key =>
    !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key) || typeof labels[key] !== 'string'
    || !labels[key]!.trim() || labels[key]!.length > 500)) invalid();
  if (input.messages.length !== input.results.length) invalid();
  const criteriaDigest = hash(JSON.stringify(labels));
  const messages = new Map<string, LayaTriageMessage>();
  for (const message of input.messages) {
    if (message === null || typeof message !== 'object' || Array.isArray(message)
      || [message.source, message.messageId, message.sourceRevision].some(value =>
        typeof value !== 'string' || !value.trim() || value.length > 256)
      || typeof message.text !== 'string' || message.text.length > 4000
      || (message.highImpact !== undefined && typeof message.highImpact !== 'boolean')) invalid();
    const id = identity(message.source, message.messageId);
    if (messages.has(id)) invalid();
    messages.set(id, message);
  }

  const groups = new Map<string, TriageDispatchRef[]>();
  const mainAgent: TriageDispatchRef[] = [];
  const review: TriageDispatchRef[] = [];
  const deferred: TriageDeferredRef[] = [];
  const seen = new Set<string>();
  for (const result of input.results) {
    if (result === null || typeof result !== 'object' || Array.isArray(result)
      || typeof result.source !== 'string' || typeof result.messageId !== 'string') invalid();
    const id = identity(result.source, result.messageId);
    const message = messages.get(id);
    if (!message || seen.has(id) || result.sourceRevision !== message.sourceRevision) invalid();
    seen.add(id);
    const receipt = result.receipt;
    if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)
      || receipt.promptVersion !== 'mail-triage-v1' || receipt.model !== 'multilingual'
      || !Array.isArray(receipt.candidateLabels) || receipt.candidateLabels.length !== keys.length
      || !receipt.candidateLabels.every((label: unknown, index: number) => label === keys[index])
      || !digest(receipt.criteriaDigest) || receipt.criteriaDigest !== criteriaDigest
      || !digest(receipt.contextDigest) || receipt.contextDigest !== hash(message.text)
      || !digest(receipt.id) || receipt.id !== hash(JSON.stringify([
        message.source, message.messageId, message.sourceRevision, criteriaDigest, message.text,
      ])) || result.calibrated !== false
      || !['multi_question', 'multi_state'].includes(result.batching)) invalid();

    const failed = ['invalid_response', 'unavailable', 'cancelled', 'deadline', 'insufficient_input'].includes(result.reason);
    if (failed) {
      if (result.label !== null || result.abstained !== true
        || result.route !== (message.highImpact ? 'main_agent' : 'review')
        || result.scores !== undefined || result.impactScores !== undefined) invalid();
    } else {
      if (!validScores(result.scores, keys)
        || !validScores(result.impactScores, ['routine', 'high_impact'])
        || result.candidateLabel !== result.scores.choice) invalid();
      const highImpact = message.highImpact === true || result.impactScores.choice === 'high_impact'
        || result.candidateLabel === 'meeting';
      if (result.reason === 'classified') {
        if (highImpact || result.route !== 'group' || result.abstained !== false
          || result.label !== result.scores.choice) invalid();
      } else if (result.reason === 'uncertain') {
        if (highImpact || result.route !== 'review' || result.abstained !== true || result.label !== null) invalid();
      } else if (result.reason === 'unknown_category') {
        if (highImpact || result.route !== 'review' || result.abstained !== true || result.label !== null
          || result.candidateLabel !== 'other' || result.scores.choice !== 'other') invalid();
      } else if (result.reason === 'high_impact') {
        if (!highImpact || result.route !== 'main_agent'
          || (result.abstained === true ? result.label !== null
            : result.abstained !== false || result.label !== result.scores.choice)) invalid();
      } else invalid();
    }
    if (result.label !== null && (!keys.includes(result.label) || result.label === undefined)) invalid();
    const safeReceipt: LayaTriageResult['receipt'] = {
      id: receipt.id, promptVersion: 'mail-triage-v1', model: 'multilingual',
      candidateLabels: [...keys], criteriaDigest, contextDigest: receipt.contextDigest,
    };
    const ref: TriageDispatchRef = {source: message.source, messageId: message.messageId,
      sourceRevision: message.sourceRevision, receipt: safeReceipt,
      workKey: hash(JSON.stringify([input.namespace, receipt.id, result.route, result.label, result.reason]))};
    if (failed) deferred.push({...ref, reason: result.reason as TriageDeferredRef['reason'],
      requiredRoute: result.route as TriageDeferredRef['requiredRoute']});
    else if (result.route === 'main_agent') mainAgent.push(ref);
    else if (result.route === 'review') review.push(ref);
    else {
      const grouped = groups.get(result.label!);
      if (grouped) grouped.push(ref);
      else groups.set(result.label!, [ref]);
    }
  }
  if (seen.size !== messages.size) invalid();
  return {groups: [...groups].sort(([a], [b]) => a.localeCompare(b))
    .map(([label, refs]) => ({label, refs: refs.sort(compareRefs)})),
  mainAgent: mainAgent.sort(compareRefs), review: review.sort(compareRefs), deferred: deferred.sort(compareRefs)};
}
