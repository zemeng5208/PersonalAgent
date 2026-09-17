import type {FactRef, MemoryReadContext} from './index.js';

/** Provisional in-process delivery contract; tokens reveal no log sequence. */
export interface FactChangeEntry {
  readonly eventId: string;
  readonly fact: FactRef;
}

export interface FactChangeBatch {
  readonly mode: 'bootstrap' | 'changes';
  readonly batchToken: string;
  readonly baseCheckpoint: string;
  readonly watermark: string;
  readonly entries: readonly FactChangeEntry[];
  readonly atWatermark: boolean;
}

export interface ReadFactChangesRequest extends MemoryReadContext {
  readonly limit: number;
}

/** Bound by the host to one namespace, consumer and exact visibility epoch. */
export interface FactChangeFeedPort {
  read(request: ReadFactChangesRequest): Promise<FactChangeBatch>;
}

/**
 * Only a trusted host may consume this command, after durable processing.
 * A reader is deliberately not given an ack method or an arbitrary sequence.
 * Fake confirmation tests protocol semantics, not durable projection evidence.
 */
export interface ConfirmFactChangeBatchRequest extends MemoryReadContext {
  readonly batchToken: string;
  readonly expectedCheckpoint: string;
  readonly handled: readonly FactChangeEntry[];
}

export interface FactChangeReceipt {
  readonly batchToken: string;
  readonly checkpoint: string;
}

export type FactChangeFeedErrorCode =
  | 'INVALID_ARGUMENT' | 'SCOPE_DENIED' | 'REBUILD_REQUIRED'
  | 'REVISION_CONFLICT' | 'TIMEOUT' | 'CANCELLED';

const messages: Record<FactChangeFeedErrorCode, string> = {
  INVALID_ARGUMENT: 'Invalid fact change request',
  SCOPE_DENIED: 'Fact change binding is unavailable',
  REBUILD_REQUIRED: 'Fact change view requires rebuilding',
  REVISION_CONFLICT: 'Fact change checkpoint conflict',
  TIMEOUT: 'Fact change deadline expired',
  CANCELLED: 'Fact change request cancelled',
};

export class FactChangeFeedError extends Error {
  constructor(readonly code: FactChangeFeedErrorCode) {
    super(messages[code]);
    this.name = 'FactChangeFeedError';
  }
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) throw new Error();
  const copy: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new Error();
    copy[key] = descriptor.value;
  }
  return copy;
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) throw new Error();
  return value;
}

/** Validate an external delivery without treating it as processing or ack. */
export function parseFactChangeBatch(value: unknown): FactChangeBatch {
  try {
    const batch = record(value, ['mode', 'batchToken', 'baseCheckpoint', 'watermark', 'entries', 'atWatermark']);
    if (batch.mode !== 'bootstrap' && batch.mode !== 'changes') throw new Error();
    if (typeof batch.atWatermark !== 'boolean' || !Array.isArray(batch.entries)) throw new Error();
    const lengthDescriptor = Object.getOwnPropertyDescriptor(batch.entries, 'length');
    const length: unknown = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : undefined;
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > 100) throw new Error();
    const arrayKeys = Reflect.ownKeys(batch.entries);
    if (arrayKeys.length !== length + 1 || arrayKeys.some(key =>
      key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length))) throw new Error();
    const events = new Set<string>();
    const facts = new Set<string>();
    const entries: FactChangeEntry[] = [];
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(batch.entries, String(index));
      if (!descriptor || !('value' in descriptor)) throw new Error();
      const entry = record(descriptor.value, ['eventId', 'fact']);
      const eventId = text(entry.eventId);
      const ref = record(entry.fact, ['id', 'revision']);
      const id = text(ref.id);
      if (typeof ref.revision !== 'number' || !Number.isSafeInteger(ref.revision) || ref.revision < 1) throw new Error();
      const identity = JSON.stringify([id, ref.revision]);
      if (events.has(eventId) || facts.has(identity)) throw new Error();
      events.add(eventId); facts.add(identity);
      entries.push({eventId, fact: {id, revision: ref.revision}});
    }
    return {mode: batch.mode, batchToken: text(batch.batchToken), baseCheckpoint: text(batch.baseCheckpoint),
      watermark: text(batch.watermark), entries, atWatermark: batch.atWatermark};
  } catch {
    throw new FactChangeFeedError('INVALID_ARGUMENT');
  }
}
