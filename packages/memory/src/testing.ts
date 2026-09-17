import {randomUUID} from 'node:crypto';
import {MemoryQueryError} from './index.js';
import type {
  FactPage,
  FactRef,
  FactSensitivity,
  FactVersion,
  GetFactVersionRequest,
  ListCurrentFactsRequest,
  ListFactHistoryRequest,
  MemoryQueryPort,
  MemoryReadContext,
} from './index.js';

const canonicalUtc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const sensitivities: readonly FactSensitivity[] = ['public', 'private', 'restricted'];
const confirmations = ['external_observation', 'model_inference', 'user_confirmed'] as const;
const states = ['active', 'withdrawn'] as const;
const maxIdLength = 256;
const maxSummaryLength = 4096;
const maxSourceRefLength = 1024;
const maxTokenLength = 256;
const maxPageSize = 100;

interface StoredFact {
  readonly sequence: number;
  readonly fact: FactVersion;
}

interface NamespaceState {
  sequence: number;
  readonly facts: StoredFact[];
}

interface SnapshotRecord {
  readonly namespace: string;
  readonly scope: string;
  readonly mode: 'current' | 'history';
  readonly filter: string;
  readonly watermark: number;
}

interface CursorRecord {
  readonly snapshot: string;
  readonly offset: number;
}

function fail(code: ConstructorParameters<typeof MemoryQueryError>[0] = 'INVALID_ARGUMENT'): never {
  throw new MemoryQueryError(code);
}

function sanitizeInput<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof MemoryQueryError) throw error;
    return fail();
  }
}

function exactRecord(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail();
    const keys = Reflect.ownKeys(value);
    const allowed = new Set([...required, ...optional]);
    if (keys.some(key => typeof key !== 'string' || !allowed.has(key)
      || !Object.prototype.propertyIsEnumerable.call(value, key))
      || required.some(key => !Object.prototype.propertyIsEnumerable.call(value, key))) return fail();
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof MemoryQueryError) throw error;
    return fail();
  }
}

function boundedText(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) return fail();
  return value;
}

function parseTime(value: unknown): {text: string; milliseconds: number} {
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

function parseRef(value: unknown): FactRef {
  const record = exactRecord(value, ['id', 'revision']);
  const id = boundedText(record.id, maxIdLength);
  if (typeof record.revision !== 'number' || !Number.isSafeInteger(record.revision) || record.revision < 1) return fail();
  return {id, revision: record.revision};
}

function parseFact(value: unknown): FactVersion {
  try {
    const record = exactRecord(value,
      ['ref', 'summary', 'sourceRef', 'observedAt', 'validFrom', 'validUntil',
        'sensitivity', 'state', 'confirmation'], ['corrects']);
    const ref = parseRef(record.ref);
    const observedAt = parseTime(record.observedAt).text;
    const validFrom = parseTime(record.validFrom);
    const validUntil = parseTime(record.validUntil);
    if (validFrom.milliseconds >= validUntil.milliseconds
      || !sensitivities.includes(record.sensitivity as FactSensitivity)
      || !states.includes(record.state as typeof states[number])
      || !confirmations.includes(record.confirmation as typeof confirmations[number])) return fail();
    const result: FactVersion = {
      ref,
      summary: boundedText(record.summary, maxSummaryLength),
      sourceRef: boundedText(record.sourceRef, maxSourceRefLength),
      observedAt,
      validFrom: validFrom.text,
      validUntil: validUntil.text,
      sensitivity: record.sensitivity as FactSensitivity,
      state: record.state as FactVersion['state'],
      confirmation: record.confirmation as FactVersion['confirmation'],
    };
    if (record.corrects !== undefined) result.corrects = parseRef(record.corrects);
    return result;
  } catch (error) {
    if (error instanceof MemoryQueryError) throw error;
    return fail();
  }
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

function readAborted(signal: AbortSignal): boolean {
  try {
    if (typeof signal.aborted !== 'boolean') return fail();
    return signal.aborted;
  } catch (error) {
    if (error instanceof MemoryQueryError) throw error;
    return fail();
  }
}

function parseContext(record: Record<string, unknown>): MemoryReadContext & {expiresAt: number} {
  if (!isSignal(record.signal)) return fail();
  const deadline = parseTime(record.deadline);
  if (readAborted(record.signal)) return fail('CANCELLED');
  if (deadline.milliseconds <= Date.now()) return fail('TIMEOUT');
  return {deadline: deadline.text, signal: record.signal, expiresAt: deadline.milliseconds};
}

function checkpoint(context: MemoryReadContext & {expiresAt: number}): void {
  if (readAborted(context.signal)) return fail('CANCELLED');
  if (context.expiresAt <= Date.now()) return fail('TIMEOUT');
}

function optionalText(value: unknown, maximum: number): string | undefined {
  return value === undefined ? undefined : boundedText(value, maximum);
}

function parsePaging(record: Record<string, unknown>): {limit: number; snapshot?: string; cursor?: string} {
  if (typeof record.limit !== 'number' || !Number.isSafeInteger(record.limit)
    || record.limit < 1 || record.limit > maxPageSize) return fail();
  const snapshot = optionalText(record.snapshot, maxTokenLength);
  const cursor = optionalText(record.cursor, maxTokenLength);
  if (cursor !== undefined && snapshot === undefined) return fail();
  return {
    limit: record.limit,
    ...(snapshot === undefined ? {} : {snapshot}),
    ...(cursor === undefined ? {} : {cursor}),
  };
}

function parseCurrentRequest(value: unknown): ListCurrentFactsRequest & {expiresAt: number} {
  const record = exactRecord(value, ['at', 'limit', 'deadline', 'signal'],
    ['factId', 'sourceRef', 'snapshot', 'cursor']);
  const context = parseContext(record);
  const paging = parsePaging(record);
  const factId = optionalText(record.factId, maxIdLength);
  const sourceRef = optionalText(record.sourceRef, maxSourceRefLength);
  return {
    at: parseTime(record.at).text,
    limit: paging.limit,
    deadline: context.deadline,
    signal: context.signal,
    expiresAt: context.expiresAt,
    ...(factId === undefined ? {} : {factId}),
    ...(sourceRef === undefined ? {} : {sourceRef}),
    ...(paging.snapshot === undefined ? {} : {snapshot: paging.snapshot}),
    ...(paging.cursor === undefined ? {} : {cursor: paging.cursor}),
  };
}

function parseHistoryRequest(value: unknown): ListFactHistoryRequest & {expiresAt: number} {
  const record = exactRecord(value, ['factId', 'limit', 'deadline', 'signal'], ['snapshot', 'cursor']);
  const context = parseContext(record);
  const paging = parsePaging(record);
  return {
    factId: boundedText(record.factId, maxIdLength),
    limit: paging.limit,
    deadline: context.deadline,
    signal: context.signal,
    expiresAt: context.expiresAt,
    ...(paging.snapshot === undefined ? {} : {snapshot: paging.snapshot}),
    ...(paging.cursor === undefined ? {} : {cursor: paging.cursor}),
  };
}

function parseGetRequest(value: unknown): GetFactVersionRequest & {expiresAt: number} {
  const record = exactRecord(value, ['fact', 'deadline', 'signal']);
  const context = parseContext(record);
  return {fact: parseRef(record.fact), deadline: context.deadline, signal: context.signal, expiresAt: context.expiresAt};
}

function parseNamespace(value: unknown): string {
  return boundedText(value, maxIdLength);
}

function parseScope(value: unknown): {values: readonly FactSensitivity[]; key: string} {
  const record = exactRecord(value, ['allowedSensitivities']);
  if (!Array.isArray(record.allowedSensitivities) || record.allowedSensitivities.length === 0) return fail();
  const values = record.allowedSensitivities.map(value => {
    if (!sensitivities.includes(value as FactSensitivity)) return fail();
    return value as FactSensitivity;
  });
  if (new Set(values).size !== values.length) return fail();
  const sorted = [...values].sort();
  return {values: Object.freeze(sorted), key: JSON.stringify(sorted)};
}

function filterKey(value: object): string {
  return JSON.stringify(value);
}

function compareFacts(left: FactVersion, right: FactVersion): number {
  return left.ref.id.localeCompare(right.ref.id) || left.ref.revision - right.ref.revision;
}

/** Explicit in-memory fixture host. It is never selected by production composition. */
export class FakeMemoryHost {
  private readonly namespaces = new Map<string, NamespaceState>();
  private readonly snapshots = new Map<string, SnapshotRecord>();
  private readonly cursors = new Map<string, CursorRecord>();

  provision(namespace: string): void {
    const key = parseNamespace(namespace);
    if (!this.namespaces.has(key)) this.namespaces.set(key, {sequence: 0, facts: []});
  }

  append(namespace: string, value: FactVersion): FactVersion {
    const key = parseNamespace(namespace);
    const state = this.namespaces.get(key);
    if (state === undefined) return fail('NOT_FOUND');
    const fact = parseFact(value);
    const previous = state.facts.findLast(item => item.fact.ref.id === fact.ref.id)?.fact;
    if (fact.ref.revision !== (previous?.ref.revision ?? 0) + 1) return fail();
    if (previous === undefined) {
      if (fact.corrects !== undefined || fact.state === 'withdrawn') return fail();
    } else if (fact.corrects === undefined
      || fact.corrects.id !== previous.ref.id
      || fact.corrects.revision !== previous.ref.revision) return fail();
    state.sequence++;
    state.facts.push({sequence: state.sequence, fact: structuredClone(fact)});
    return structuredClone(fact);
  }

  bind(namespace: string, options: {allowedSensitivities: readonly FactSensitivity[]}): MemoryQueryPort {
    const key = parseNamespace(namespace);
    if (!this.namespaces.has(key)) return fail('NOT_FOUND');
    const scope = sanitizeInput(() => parseScope(options));
    const allowed = new Set(scope.values);

    const page = (mode: SnapshotRecord['mode'], filter: string, providedSnapshot: string | undefined,
      providedCursor: string | undefined, limit: number, select: (watermark: number) => FactVersion[]): FactPage => {
      let token = providedSnapshot;
      let record: SnapshotRecord;
      if (token === undefined) {
        token = `memory-snapshot-${randomUUID()}`;
        record = {namespace: key, scope: scope.key, mode, filter,
          watermark: this.namespaces.get(key)!.sequence};
        this.snapshots.set(token, record);
      } else {
        const existing = this.snapshots.get(token);
        if (existing === undefined || existing.namespace !== key || existing.scope !== scope.key
          || existing.mode !== mode || existing.filter !== filter) return fail();
        record = existing;
      }
      let offset = 0;
      if (providedCursor !== undefined) {
        const cursor = this.cursors.get(providedCursor);
        if (cursor === undefined || cursor.snapshot !== token) return fail();
        offset = cursor.offset;
      }
      const all = select(record.watermark).sort(compareFacts);
      if (offset > all.length) return fail();
      const facts = all.slice(offset, offset + limit).map(fact => structuredClone(fact));
      const nextOffset = offset + facts.length;
      if (nextOffset < all.length) {
        const nextCursor = `memory-cursor-${randomUUID()}`;
        this.cursors.set(nextCursor, {snapshot: token, offset: nextOffset});
        return {snapshot: token, facts, nextCursor};
      }
      return {snapshot: token, facts};
    };

    return Object.freeze({
      listCurrent: async (raw: ListCurrentFactsRequest): Promise<FactPage> => {
        const request = sanitizeInput(() => parseCurrentRequest(raw));
        await Promise.resolve();
        checkpoint(request);
        const filter = filterKey({at: request.at, factId: request.factId ?? null,
          sourceRef: request.sourceRef ?? null});
        const result = page('current', filter, request.snapshot, request.cursor, request.limit, watermark => {
          const latest = new Map<string, FactVersion>();
          for (const stored of this.namespaces.get(key)!.facts) {
            if (stored.sequence > watermark) break;
            latest.set(stored.fact.ref.id, stored.fact);
          }
          const at = Date.parse(request.at);
          return [...latest.values()].filter(fact => allowed.has(fact.sensitivity)
            && fact.state === 'active'
            && Date.parse(fact.validFrom) <= at && at < Date.parse(fact.validUntil)
            && (request.factId === undefined || fact.ref.id === request.factId)
            && (request.sourceRef === undefined || fact.sourceRef === request.sourceRef));
        });
        checkpoint(request);
        return structuredClone(result);
      },
      listHistory: async (raw: ListFactHistoryRequest): Promise<FactPage> => {
        const request = sanitizeInput(() => parseHistoryRequest(raw));
        await Promise.resolve();
        checkpoint(request);
        const filter = filterKey({factId: request.factId});
        const result = page('history', filter, request.snapshot, request.cursor, request.limit, watermark =>
          this.namespaces.get(key)!.facts
            .filter(stored => stored.sequence <= watermark && stored.fact.ref.id === request.factId
              && allowed.has(stored.fact.sensitivity))
            .map(stored => stored.fact));
        checkpoint(request);
        return structuredClone(result);
      },
      getVersion: async (raw: GetFactVersionRequest): Promise<FactVersion> => {
        const request = sanitizeInput(() => parseGetRequest(raw));
        await Promise.resolve();
        checkpoint(request);
        const stored = this.namespaces.get(key)!.facts.find(item =>
          item.fact.ref.id === request.fact.id && item.fact.ref.revision === request.fact.revision);
        if (stored === undefined || !allowed.has(stored.fact.sensitivity)) return fail('SCOPE_DENIED');
        const result = structuredClone(stored.fact);
        checkpoint(request);
        return result;
      },
    });
  }
}
