import {randomUUID} from 'node:crypto';
import {FactChangeFeedError} from './feed.js';
import type {
  ConfirmFactChangeBatchRequest,
  FactChangeBatch,
  FactChangeEntry,
  FactChangeFeedPort,
  FactChangeReceipt,
  ReadFactChangesRequest,
} from './feed.js';
import type {FactSensitivity, FactVersion} from './index.js';

const canonicalUtc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const sensitivities: readonly FactSensitivity[] = ['public', 'private', 'restricted'];
const maxTextLength = 256;
const maxBatchSize = 100;

export interface FakeFeedStoredFact {
  readonly sequence: number;
  readonly eventId: string;
  readonly fact: FactVersion;
}

export interface FakeFeedNamespaceState {
  readonly sequence: number;
  readonly facts: readonly FakeFeedStoredFact[];
}

type NamespaceLookup = (namespace: string) => FakeFeedNamespaceState | undefined;

interface ParsedContext {
  readonly deadline: string;
  readonly signal: AbortSignal;
  readonly expiresAt: number;
}

interface Binding {
  readonly namespace: string;
  readonly consumerId: string;
  readonly scopeKey: string;
  readonly allowed: ReadonlySet<FactSensitivity>;
  valid: boolean;
  checkpoint: string;
  mode: 'bootstrap' | 'changes';
  bootstrapWatermark?: number;
  bootstrapWatermarkToken?: string;
  bootstrapEntries?: readonly FactChangeEntry[];
  bootstrapOffset: number;
  changesAfter: number;
  pending?: Delivery;
}

interface Confirmation {
  readonly expectedCheckpoint: string;
  readonly handledKey: string;
  readonly receipt: FactChangeReceipt;
}

interface Delivery {
  readonly binding: Binding;
  readonly batch: FactChangeBatch;
  readonly nextBootstrapOffset?: number;
  readonly nextChangesAfter?: number;
  confirmation?: Confirmation;
}

function fail(code: ConstructorParameters<typeof FactChangeFeedError>[0] = 'INVALID_ARGUMENT'): never {
  throw new FactChangeFeedError(code);
}

function sanitized<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof FactChangeFeedError) throw error;
    return fail();
  }
}

function exactRecord(value: unknown, required: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== required.length
    || keys.some(key => typeof key !== 'string' || !required.includes(key))) return fail();
  const result: Record<string, unknown> = {};
  for (const key of required) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return fail();
    result[key] = descriptor.value;
  }
  return result;
}

function boundedText(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxTextLength) return fail();
  return value;
}

function parseTime(value: unknown): {readonly text: string; readonly milliseconds: number} {
  if (typeof value !== 'string' || !canonicalUtc.test(value)) return fail();
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return fail();
  try {
    if (new Date(milliseconds).toISOString() !== value) return fail();
  } catch {
    return fail();
  }
  return {text: value, milliseconds};
}

function isSignal(value: unknown): value is AbortSignal {
  if (value === null || typeof value !== 'object') return false;
  try {
    const signal = value as {aborted: unknown; addEventListener: unknown; removeEventListener: unknown};
    return typeof signal.aborted === 'boolean'
      && typeof signal.addEventListener === 'function'
      && typeof signal.removeEventListener === 'function';
  } catch {
    return false;
  }
}

function aborted(signal: AbortSignal): boolean {
  try {
    if (typeof signal.aborted !== 'boolean') return fail();
    return signal.aborted;
  } catch (error) {
    if (error instanceof FactChangeFeedError) throw error;
    return fail();
  }
}

function parseContext(record: Record<string, unknown>): ParsedContext {
  if (!isSignal(record.signal)) return fail();
  const deadline = parseTime(record.deadline);
  if (aborted(record.signal)) return fail('CANCELLED');
  if (deadline.milliseconds <= Date.now()) return fail('TIMEOUT');
  return {deadline: deadline.text, signal: record.signal, expiresAt: deadline.milliseconds};
}

function checkpoint(context: ParsedContext): void {
  if (aborted(context.signal)) return fail('CANCELLED');
  if (context.expiresAt <= Date.now()) return fail('TIMEOUT');
}

function parseRead(value: unknown): ReadFactChangesRequest & ParsedContext {
  const record = exactRecord(value, ['limit', 'deadline', 'signal']);
  const context = parseContext(record);
  if (typeof record.limit !== 'number' || !Number.isSafeInteger(record.limit)
    || record.limit < 1 || record.limit > maxBatchSize) return fail();
  return {limit: record.limit, deadline: context.deadline, signal: context.signal, expiresAt: context.expiresAt};
}

function parseRef(value: unknown): {readonly id: string; readonly revision: number} {
  const record = exactRecord(value, ['id', 'revision']);
  const id = boundedText(record.id);
  if (typeof record.revision !== 'number' || !Number.isSafeInteger(record.revision)
    || record.revision < 1) return fail();
  return {id, revision: record.revision};
}

function exactArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) return fail();
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  const length: unknown = lengthDescriptor && 'value' in lengthDescriptor
    ? lengthDescriptor.value : undefined;
  if (typeof length !== 'number' || !Number.isSafeInteger(length)
    || length < 0 || length > maxBatchSize) return fail();
  const expected = new Set<string | symbol>(['length']);
  for (let index = 0; index < length; index++) expected.add(String(index));
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.size || keys.some(key => !expected.has(key))) return fail();
  const copy: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return fail();
    copy.push(descriptor.value);
  }
  return copy;
}

function parseEntries(value: unknown): readonly FactChangeEntry[] {
  const array = exactArray(value);
  const entries: FactChangeEntry[] = [];
  const events = new Set<string>();
  const facts = new Set<string>();
  for (const item of array) {
    const record = exactRecord(item, ['eventId', 'fact']);
    const eventId = boundedText(record.eventId);
    const fact = parseRef(record.fact);
    const factKey = JSON.stringify([fact.id, fact.revision]);
    if (events.has(eventId) || facts.has(factKey)) return fail();
    events.add(eventId);
    facts.add(factKey);
    entries.push({eventId, fact});
  }
  return entries;
}

function parseConfirm(value: unknown): ConfirmFactChangeBatchRequest & ParsedContext {
  const record = exactRecord(value, ['batchToken', 'expectedCheckpoint', 'handled', 'deadline', 'signal']);
  const context = parseContext(record);
  return {
    batchToken: boundedText(record.batchToken),
    expectedCheckpoint: boundedText(record.expectedCheckpoint),
    handled: parseEntries(record.handled),
    deadline: context.deadline,
    signal: context.signal,
    expiresAt: context.expiresAt,
  };
}

function parseNamespace(value: unknown): string {
  return boundedText(value);
}

function parseConsumer(value: unknown): string {
  return boundedText(value);
}

function parseScope(value: unknown): {readonly allowed: ReadonlySet<FactSensitivity>; readonly key: string} {
  const record = exactRecord(value, ['consumerId', 'allowedSensitivities']);
  parseConsumer(record.consumerId);
  const array = exactArray(record.allowedSensitivities);
  if (array.length === 0) return fail();
  const values = array.map(value => {
    if (!sensitivities.includes(value as FactSensitivity)) return fail();
    return value as FactSensitivity;
  });
  if (new Set(values).size !== values.length) return fail();
  const sorted = [...values].sort();
  return {allowed: new Set(sorted), key: JSON.stringify(sorted)};
}

function token(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function cloneEntry(entry: FactChangeEntry): FactChangeEntry {
  return {eventId: entry.eventId, fact: {id: entry.fact.id, revision: entry.fact.revision}};
}

function cloneBatch(batch: FactChangeBatch): FactChangeBatch {
  return {
    mode: batch.mode,
    batchToken: batch.batchToken,
    baseCheckpoint: batch.baseCheckpoint,
    watermark: batch.watermark,
    entries: batch.entries.map(cloneEntry),
    atWatermark: batch.atWatermark,
  };
}

function handledKey(entries: readonly FactChangeEntry[]): string {
  return JSON.stringify(entries.map(entry => [entry.eventId, entry.fact.id, entry.fact.revision]));
}

function bindingKey(namespace: string, consumerId: string): string {
  return JSON.stringify([namespace, consumerId]);
}

function compareEntries(left: FactChangeEntry, right: FactChangeEntry): number {
  if (left.fact.id < right.fact.id) return -1;
  if (left.fact.id > right.fact.id) return 1;
  return left.fact.revision - right.fact.revision;
}

/** In-memory delivery protocol fixture. It provides no persistence or projection durability. */
export class FakeFactChangeFeeds {
  private readonly bindings = new Map<string, Binding>();
  private readonly deliveries = new Map<string, Delivery>();

  constructor(private readonly lookup: NamespaceLookup) {}

  bind(namespaceValue: unknown, optionsValue: unknown): FactChangeFeedPort {
    return sanitized(() => {
      const namespace = parseNamespace(namespaceValue);
      if (this.lookup(namespace) === undefined) return fail('SCOPE_DENIED');
      const options = exactRecord(optionsValue, ['consumerId', 'allowedSensitivities']);
      const consumerId = parseConsumer(options.consumerId);
      const scope = parseScope(optionsValue);
      const key = bindingKey(namespace, consumerId);
      const current = this.bindings.get(key);
      let binding: Binding;
      if (current?.valid && current.scopeKey === scope.key) {
        binding = current;
      } else {
        if (current !== undefined) current.valid = false;
        binding = {
          namespace,
          consumerId,
          scopeKey: scope.key,
          allowed: scope.allowed,
          valid: true,
          checkpoint: token('memory-feed-checkpoint'),
          mode: 'bootstrap',
          bootstrapOffset: 0,
          changesAfter: 0,
        };
        this.bindings.set(key, binding);
      }

      return Object.freeze({
        read: async (raw: ReadFactChangesRequest): Promise<FactChangeBatch> => {
          const request = sanitized(() => parseRead(raw));
          await Promise.resolve();
          checkpoint(request);
          this.ensureCurrent(binding);
          if (binding.pending !== undefined) return cloneBatch(binding.pending.batch);

          const state = this.lookup(namespace);
          if (state === undefined) return fail('SCOPE_DENIED');
          let delivery: Delivery;
          if (binding.mode === 'bootstrap') {
            if (binding.bootstrapWatermark === undefined) {
              binding.bootstrapWatermark = state.sequence;
              binding.bootstrapWatermarkToken = token('memory-feed-watermark');
              const latest = new Map<string, FakeFeedStoredFact>();
              for (const stored of state.facts) {
                if (stored.sequence > binding.bootstrapWatermark) break;
                latest.set(stored.fact.ref.id, stored);
              }
              binding.bootstrapEntries = [...latest.values()]
                .filter(stored => binding.allowed.has(stored.fact.sensitivity))
                .map(stored => ({eventId: stored.eventId,
                  fact: {id: stored.fact.ref.id, revision: stored.fact.ref.revision}}))
                .sort(compareEntries);
            }
            const entries = binding.bootstrapEntries!;
            const selected = entries.slice(binding.bootstrapOffset, binding.bootstrapOffset + request.limit);
            const nextOffset = binding.bootstrapOffset + selected.length;
            const batch: FactChangeBatch = {
              mode: 'bootstrap',
              batchToken: token('memory-feed-batch'),
              baseCheckpoint: binding.checkpoint,
              watermark: binding.bootstrapWatermarkToken!,
              entries: selected.map(cloneEntry),
              atWatermark: nextOffset === entries.length,
            };
            delivery = {binding, batch, nextBootstrapOffset: nextOffset};
          } else {
            const watermark = state.sequence;
            const visible = state.facts.filter(stored => stored.sequence > binding.changesAfter
              && stored.sequence <= watermark && binding.allowed.has(stored.fact.sensitivity));
            const selected = visible.slice(0, request.limit);
            const atWatermark = selected.length === visible.length;
            const nextChangesAfter = atWatermark ? watermark : selected.at(-1)!.sequence;
            const batch: FactChangeBatch = {
              mode: 'changes',
              batchToken: token('memory-feed-batch'),
              baseCheckpoint: binding.checkpoint,
              watermark: token('memory-feed-watermark'),
              entries: selected.map(stored => ({eventId: stored.eventId,
                fact: {id: stored.fact.ref.id, revision: stored.fact.ref.revision}})),
              atWatermark,
            };
            delivery = {binding, batch, nextChangesAfter};
          }
          binding.pending = delivery;
          this.deliveries.set(delivery.batch.batchToken, delivery);
          checkpoint(request);
          return cloneBatch(delivery.batch);
        },
      });
    });
  }

  confirm(namespaceValue: unknown, consumerValue: unknown,
    requestValue: unknown): FactChangeReceipt {
    return sanitized(() => {
      const namespace = parseNamespace(namespaceValue);
      const consumerId = parseConsumer(consumerValue);
      const request = parseConfirm(requestValue);
      checkpoint(request);
      const delivery = this.deliveries.get(request.batchToken);
      if (delivery !== undefined && delivery.binding.namespace === namespace
        && delivery.binding.consumerId === consumerId && !delivery.binding.valid) return fail('REBUILD_REQUIRED');
      const binding = this.bindings.get(bindingKey(namespace, consumerId));
      if (binding === undefined) return fail('SCOPE_DENIED');
      this.ensureCurrent(binding);
      if (delivery === undefined || delivery.binding !== binding) return fail('SCOPE_DENIED');

      const suppliedHandled = handledKey(request.handled);
      const expectedHandled = handledKey(delivery.batch.entries);
      if (delivery.confirmation !== undefined) {
        if (request.expectedCheckpoint !== delivery.confirmation.expectedCheckpoint) return fail('REVISION_CONFLICT');
        if (suppliedHandled !== delivery.confirmation.handledKey) return fail();
        return structuredClone(delivery.confirmation.receipt);
      }
      if (binding.pending !== delivery) return fail('SCOPE_DENIED');
      if (request.expectedCheckpoint !== delivery.batch.baseCheckpoint
        || binding.checkpoint !== delivery.batch.baseCheckpoint) return fail('REVISION_CONFLICT');
      if (suppliedHandled !== expectedHandled) return fail();

      checkpoint(request);
      if (delivery.batch.mode === 'bootstrap') {
        binding.bootstrapOffset = delivery.nextBootstrapOffset!;
        if (delivery.batch.atWatermark) {
          binding.mode = 'changes';
          binding.changesAfter = binding.bootstrapWatermark!;
        }
      } else {
        binding.changesAfter = delivery.nextChangesAfter!;
      }
      delete binding.pending;
      binding.checkpoint = token('memory-feed-checkpoint');
      const receipt: FactChangeReceipt = {batchToken: delivery.batch.batchToken, checkpoint: binding.checkpoint};
      delivery.confirmation = {
        expectedCheckpoint: request.expectedCheckpoint,
        handledKey: suppliedHandled,
        receipt,
      };
      return structuredClone(receipt);
    });
  }

  appended(namespace: string, previous: FactVersion | undefined, next: FactVersion): void {
    if (previous === undefined) return;
    for (const binding of this.bindings.values()) {
      if (binding.valid && binding.namespace === namespace
        && binding.allowed.has(previous.sensitivity) && !binding.allowed.has(next.sensitivity)) {
        binding.valid = false;
      }
    }
  }

  private ensureCurrent(binding: Binding): void {
    const current = this.bindings.get(bindingKey(binding.namespace, binding.consumerId));
    if (!binding.valid || current !== binding) return fail('REBUILD_REQUIRED');
    if (this.lookup(binding.namespace) === undefined) return fail('SCOPE_DENIED');
  }
}
