import {appendVersion, currentNodes, parseGraph} from '@personal-agent/goals';
import type {GraphSnapshot, NodeInput, NodeVersion} from '@personal-agent/goals';
import {
  FactChangeFeedError,
  MemoryQueryError,
  parseFactChangeBatch,
} from '@personal-agent/memory';
import type {
  FactChangeBatch,
  FactRef,
  FactVersion,
  MemoryQueryPort,
  MemoryReadContext,
} from '@personal-agent/memory';
import {analyzeImpact} from './impact.js';
import type {StoredImpact} from './persistent.js';

const projectionReason = 'fact projection';
const canonicalUtc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const maximumTimerDelay = 2_147_483_647;

export class FactProjectionError extends Error {
  readonly code = 'INTEGRITY_ERROR' as const;

  constructor() {
    super('Fact projection integrity mismatch');
    this.name = 'FactProjectionError';
  }
}

function integrity(): never {
  throw new FactProjectionError();
}

function rebuild(): never {
  throw new FactChangeFeedError('REBUILD_REQUIRED');
}

function checkpoint(context: MemoryReadContext): void {
  try {
    if (!context || typeof context !== 'object' || !context.signal
      || typeof context.signal.aborted !== 'boolean'
      || typeof context.signal.addEventListener !== 'function'
      || typeof context.signal.removeEventListener !== 'function'
      || typeof context.deadline !== 'string'
      || !canonicalUtc.test(context.deadline)) {
      throw new MemoryQueryError('INVALID_ARGUMENT');
    }
    const deadline = Date.parse(context.deadline);
    if (!Number.isFinite(deadline) || new Date(deadline).toISOString() !== context.deadline) {
      throw new MemoryQueryError('INVALID_ARGUMENT');
    }
    if (context.signal.aborted) throw new MemoryQueryError('CANCELLED');
    if (deadline <= Date.now()) throw new MemoryQueryError('TIMEOUT');
  } catch (error) {
    if (error instanceof MemoryQueryError) throw error;
    throw new MemoryQueryError('INVALID_ARGUMENT');
  }
}

function exactRecord(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) integrity();
    const keys = Reflect.ownKeys(value);
    const allowed = new Set([...required, ...optional]);
    if (keys.some(key => typeof key !== 'string' || !allowed.has(key))
      || required.some(key => !keys.includes(key))) integrity();
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) integrity();
      result[key as string] = descriptor.value;
    }
    return result;
  } catch (error) {
    if (error instanceof FactProjectionError) throw error;
    return integrity();
  }
}

function boundedText(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) return integrity();
  return value;
}

function timestamp(value: unknown): {text: string; milliseconds: number} {
  if (typeof value !== 'string' || !canonicalUtc.test(value)) return integrity();
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return integrity();
  try {
    if (new Date(milliseconds).toISOString() !== value) return integrity();
  } catch {
    return integrity();
  }
  return {text: value, milliseconds};
}

function factRef(value: unknown): FactRef {
  const record = exactRecord(value, ['id', 'revision']);
  const id = boundedText(record.id, 256);
  if (typeof record.revision !== 'number' || !Number.isSafeInteger(record.revision)
    || record.revision < 1) return integrity();
  return {id, revision: record.revision};
}

function validateFactVersion(value: unknown, expected: FactRef): FactVersion {
  const record = exactRecord(value,
    ['ref', 'summary', 'sourceRef', 'observedAt', 'validFrom', 'validUntil',
      'sensitivity', 'state', 'confirmation'], ['corrects']);
  const ref = factRef(record.ref);
  const observedAt = timestamp(record.observedAt).text;
  const validFrom = timestamp(record.validFrom);
  const validUntil = timestamp(record.validUntil);
  if (ref.id !== expected.id || ref.revision !== expected.revision
    || validFrom.milliseconds >= validUntil.milliseconds
    || !['public', 'private', 'restricted'].includes(record.sensitivity as string)
    || !['active', 'withdrawn'].includes(record.state as string)
    || !['external_observation', 'model_inference', 'user_confirmed'].includes(record.confirmation as string)) {
    return integrity();
  }
  return {
    ref,
    summary: boundedText(record.summary, 4096),
    sourceRef: boundedText(record.sourceRef, 1024),
    observedAt,
    validFrom: validFrom.text,
    validUntil: validUntil.text,
    sensitivity: record.sensitivity as FactVersion['sensitivity'],
    state: record.state as FactVersion['state'],
    confirmation: record.confirmation as FactVersion['confirmation'],
    ...(record.corrects === undefined ? {} : {corrects: factRef(record.corrects)}),
  };
}

async function readFactWithGate(
  memory: MemoryQueryPort,
  expected: FactRef,
  context: MemoryReadContext,
): Promise<FactVersion> {
  checkpoint(context);
  const deadline = Date.parse(context.deadline);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let rejectGate: ((reason: MemoryQueryError) => void) | undefined;
  const onAbort = (): void => rejectGate?.(new MemoryQueryError('CANCELLED'));
  const armDeadline = (): void => {
    if (stopped) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      rejectGate?.(new MemoryQueryError('TIMEOUT'));
      return;
    }
    timer = setTimeout(armDeadline, Math.min(remaining, maximumTimerDelay));
  };
  const gate = new Promise<never>((_resolve, reject) => {
    rejectGate = reject;
    context.signal.addEventListener('abort', onAbort, {once: true});
    if (context.signal.aborted) onAbort();
    else armDeadline();
  });
  const read = Promise.resolve().then(() => {
    // The caller can abort after this async function yields but before the
    // provider microtask starts. Do not begin a new underlying read then.
    checkpoint(context);
    return memory.getVersion({
      fact: structuredClone(expected),
      deadline: context.deadline,
      signal: context.signal,
    });
  });
  // A gate may win while the provider ignores cancellation. Always observe a
  // later rejection, but never route a late result back into projection state.
  void read.catch(() => undefined);
  try {
    const value: unknown = await Promise.race([read, gate]);
    return validateFactVersion(value, expected);
  } finally {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    context.signal.removeEventListener('abort', onAbort);
  }
}

function inputFor(fact: FactVersion): NodeInput {
  return {
    id: fact.ref.id,
    kind: 'fact',
    summary: fact.summary,
    sourceRef: fact.sourceRef,
    validFrom: fact.validFrom,
    validUntil: fact.validUntil,
    sensitivity: fact.sensitivity,
    state: fact.state,
    reason: projectionReason,
    dependencies: [],
  };
}

function hasExpectedCorrection(fact: FactVersion): boolean {
  if (fact.ref.revision === 1) return fact.corrects === undefined;
  return fact.corrects?.id === fact.ref.id
    && fact.corrects.revision === fact.ref.revision - 1;
}

function matchesProjection(node: NodeVersion, input: NodeInput): boolean {
  return node.id === input.id
    && node.kind === 'fact'
    && node.summary === input.summary
    && node.sourceRef === input.sourceRef
    && node.validFrom === input.validFrom
    && node.validUntil === input.validUntil
    && node.sensitivity === input.sensitivity
    && node.state === input.state
    && node.reason === input.reason
    && node.dependencies.length === 0;
}

/**
 * Build an isolated graph candidate from one already-delivered fact batch.
 * This preview never persists, confirms the feed, rebinds graph dependencies,
 * schedules work, or treats Memory observation metadata as graph-owned data.
 */
export async function previewFactProjection(
  snapshot: GraphSnapshot,
  batch: FactChangeBatch,
  memory: MemoryQueryPort,
  context: MemoryReadContext,
  at: string,
): Promise<StoredImpact> {
  checkpoint(context);
  const delivery = parseFactChangeBatch(batch);
  let candidate = parseGraph(snapshot);
  // Validate explicit evaluation time before invoking the external read port.
  analyzeImpact(candidate, at);

  for (const entry of delivery.entries) {
    checkpoint(context);
    const fact = await readFactWithGate(memory, entry.fact, context);
    checkpoint(context);

    const latest = currentNodes(candidate).find(node => node.id === fact.ref.id);
    const exact = candidate.history.find(node =>
      node.id === fact.ref.id && node.revision === fact.ref.revision);
    const input = inputFor(fact);

    if (exact) {
      if (!hasExpectedCorrection(fact) || !matchesProjection(exact, input)) integrity();
      continue;
    }
    if (latest && latest.kind !== 'fact') integrity();
    if (!latest) {
      if (fact.ref.revision !== 1) rebuild();
      if (!hasExpectedCorrection(fact)) integrity();
    } else {
      if (fact.ref.revision !== latest.revision + 1) rebuild();
      if (!hasExpectedCorrection(fact)
        || fact.corrects!.id !== latest.id
        || fact.corrects!.revision !== latest.revision) integrity();
    }

    candidate = appendVersion(candidate, candidate.revision, input);
    const appended = candidate.history.at(-1)!;
    if (appended.id !== fact.ref.id || appended.revision !== fact.ref.revision) integrity();
  }

  checkpoint(context);
  const isolated = structuredClone(candidate);
  return {snapshot: isolated, report: analyzeImpact(isolated, at)};
}
