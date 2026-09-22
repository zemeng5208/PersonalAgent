import {randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {openStorage, type Migration} from '@personal-agent/storage';
import {FactChangeFeedError, MemoryQueryError} from './index.js';
import type {
  ConfirmFactChangeBatchRequest,
  FactChangeBatch,
  FactChangeEntry,
  FactChangeFeedPort,
  FactChangeReceipt,
  FactPage,
  FactRef,
  FactSensitivity,
  FactVersion,
  GetFactVersionRequest,
  ListCurrentFactsRequest,
  ListFactHistoryRequest,
  MemoryQueryPort,
  MemoryReadContext,
  ReadFactChangesRequest,
} from './index.js';

const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SENSITIVITIES: readonly FactSensitivity[] = ['public', 'private', 'restricted'];
const CONFIRMATIONS = ['external_observation', 'model_inference', 'user_confirmed'] as const;
const STATES = ['active', 'withdrawn'] as const;
const MAX_ID = 256;
const MAX_SUMMARY = 4096;
const MAX_SOURCE = 1024;
const MAX_PAGE = 100;

const MIGRATIONS: readonly Migration[] = [{
  version: 1,
  sql: `
    CREATE TABLE memory_namespaces (
      namespace TEXT PRIMARY KEY,
      sequence INTEGER NOT NULL CHECK (sequence >= 0)
    ) STRICT;
    CREATE TABLE memory_facts (
      namespace TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence >= 1),
      event_id TEXT NOT NULL,
      fact_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      sensitivity TEXT NOT NULL CHECK (sensitivity IN ('public', 'private', 'restricted')),
      state TEXT NOT NULL CHECK (state IN ('active', 'withdrawn')),
      source_ref TEXT NOT NULL,
      valid_from_ms INTEGER NOT NULL,
      valid_until_ms INTEGER NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (namespace, fact_id, revision),
      UNIQUE (namespace, sequence),
      UNIQUE (namespace, event_id),
      FOREIGN KEY (namespace) REFERENCES memory_namespaces(namespace)
    ) STRICT;
    CREATE INDEX memory_facts_current_idx ON memory_facts(namespace, fact_id, revision DESC);
    CREATE INDEX memory_facts_changes_idx ON memory_facts(namespace, sequence);
    CREATE TABLE memory_query_snapshots (
      token TEXT PRIMARY KEY,
      namespace TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('current', 'history')),
      filter_key TEXT NOT NULL,
      watermark INTEGER NOT NULL,
      FOREIGN KEY (namespace) REFERENCES memory_namespaces(namespace)
    ) STRICT;
    CREATE TABLE memory_query_cursors (
      token TEXT PRIMARY KEY,
      snapshot_token TEXT NOT NULL,
      offset INTEGER NOT NULL CHECK (offset >= 0),
      FOREIGN KEY (snapshot_token) REFERENCES memory_query_snapshots(token) ON DELETE CASCADE
    ) STRICT;
    CREATE TABLE memory_feed_bindings (
      namespace TEXT NOT NULL,
      consumer_id TEXT NOT NULL,
      binding_id TEXT NOT NULL UNIQUE,
      scope_key TEXT NOT NULL,
      allowed_json TEXT NOT NULL,
      valid INTEGER NOT NULL CHECK (valid IN (0, 1)),
      checkpoint TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('bootstrap', 'changes')),
      bootstrap_watermark INTEGER,
      bootstrap_watermark_token TEXT,
      bootstrap_entries_json TEXT,
      bootstrap_offset INTEGER NOT NULL CHECK (bootstrap_offset >= 0),
      changes_after INTEGER NOT NULL CHECK (changes_after >= 0),
      pending_batch_token TEXT,
      PRIMARY KEY (namespace, consumer_id),
      FOREIGN KEY (namespace) REFERENCES memory_namespaces(namespace)
    ) STRICT;
    CREATE TABLE memory_feed_deliveries (
      batch_token TEXT PRIMARY KEY,
      namespace TEXT NOT NULL,
      consumer_id TEXT NOT NULL,
      binding_id TEXT NOT NULL,
      batch_json TEXT NOT NULL,
      next_bootstrap_offset INTEGER,
      next_changes_after INTEGER,
      confirmed INTEGER NOT NULL CHECK (confirmed IN (0, 1)),
      confirmed_expected_checkpoint TEXT,
      confirmed_handled_key TEXT,
      receipt_checkpoint TEXT
    ) STRICT;
  `,
}];

type Row = Record<string, unknown>;
type Context = MemoryReadContext & {readonly expiresAt: number};

function queryFail(code: ConstructorParameters<typeof MemoryQueryError>[0] = 'INVALID_ARGUMENT'): never {
  throw new MemoryQueryError(code);
}

function feedFail(code: ConstructorParameters<typeof FactChangeFeedError>[0] = 'INVALID_ARGUMENT'): never {
  throw new FactChangeFeedError(code);
}

function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error();
  const keys = Reflect.ownKeys(value);
  const allowed = new Set([...required, ...optional]);
  if (keys.some(key => typeof key !== 'string' || !allowed.has(key)
    || !Object.prototype.propertyIsEnumerable.call(value, key))
    || required.some(key => !Object.prototype.propertyIsEnumerable.call(value, key))) throw new Error();
  return value as Record<string, unknown>;
}

function text(value: unknown, maximum = MAX_ID): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new Error();
  return value;
}

function time(value: unknown): {readonly text: string; readonly milliseconds: number} {
  if (typeof value !== 'string' || !UTC.test(value)) throw new Error();
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) throw new Error();
  return {text: value, milliseconds};
}

function ref(value: unknown): FactRef {
  const record = exact(value, ['id', 'revision']);
  if (typeof record.revision !== 'number' || !Number.isSafeInteger(record.revision) || record.revision < 1) throw new Error();
  return {id: text(record.id), revision: record.revision};
}

function fact(value: unknown): FactVersion {
  const record = exact(value,
    ['ref', 'summary', 'sourceRef', 'observedAt', 'validFrom', 'validUntil', 'sensitivity', 'state', 'confirmation'],
    ['corrects']);
  const validFrom = time(record.validFrom);
  const validUntil = time(record.validUntil);
  if (validFrom.milliseconds >= validUntil.milliseconds
    || !SENSITIVITIES.includes(record.sensitivity as FactSensitivity)
    || !STATES.includes(record.state as typeof STATES[number])
    || !CONFIRMATIONS.includes(record.confirmation as typeof CONFIRMATIONS[number])) throw new Error();
  const parsed: FactVersion = {
    ref: ref(record.ref),
    summary: text(record.summary, MAX_SUMMARY),
    sourceRef: text(record.sourceRef, MAX_SOURCE),
    observedAt: time(record.observedAt).text,
    validFrom: validFrom.text,
    validUntil: validUntil.text,
    sensitivity: record.sensitivity as FactSensitivity,
    state: record.state as FactVersion['state'],
    confirmation: record.confirmation as FactVersion['confirmation'],
  };
  if (record.corrects !== undefined) parsed.corrects = ref(record.corrects);
  return parsed;
}

function context(record: Record<string, unknown>, fail: typeof queryFail | typeof feedFail): Context {
  try {
    if (record.signal === null || typeof record.signal !== 'object') return fail();
    const signal = record.signal as AbortSignal;
    if (typeof signal.aborted !== 'boolean'
      || typeof signal.addEventListener !== 'function'
      || typeof signal.removeEventListener !== 'function') return fail();
    const deadline = time(record.deadline);
    if (signal.aborted) return fail('CANCELLED' as never);
    if (deadline.milliseconds <= Date.now()) return fail('TIMEOUT' as never);
    return {deadline: deadline.text, signal, expiresAt: deadline.milliseconds};
  } catch (error) {
    if (error instanceof MemoryQueryError || error instanceof FactChangeFeedError) throw error;
    return fail();
  }
}

function active(value: Context, fail: typeof queryFail | typeof feedFail): void {
  if (value.signal.aborted) return fail('CANCELLED' as never);
  if (value.expiresAt <= Date.now()) return fail('TIMEOUT' as never);
}

function scope(value: unknown, withConsumer: boolean): {
  readonly values: readonly FactSensitivity[];
  readonly key: string;
  readonly consumerId?: string;
} {
  const record = exact(value, withConsumer ? ['consumerId', 'allowedSensitivities'] : ['allowedSensitivities']);
  if (!Array.isArray(record.allowedSensitivities) || record.allowedSensitivities.length === 0) throw new Error();
  const values = record.allowedSensitivities.map(item => {
    if (!SENSITIVITIES.includes(item as FactSensitivity)) throw new Error();
    return item as FactSensitivity;
  });
  if (new Set(values).size !== values.length) throw new Error();
  const sorted = Object.freeze([...values].sort());
  const consumerId = withConsumer ? text(record.consumerId) : undefined;
  return {values: sorted, key: JSON.stringify(sorted), ...(consumerId === undefined ? {} : {consumerId})};
}

interface PageOptions {
  readonly limit: number;
  readonly snapshot?: string;
  readonly cursor?: string;
}

function parsePage(record: Record<string, unknown>): PageOptions {
  if (typeof record.limit !== 'number' || !Number.isSafeInteger(record.limit)
    || record.limit < 1 || record.limit > MAX_PAGE) throw new Error();
  const snapshot = record.snapshot === undefined ? undefined : text(record.snapshot);
  const cursor = record.cursor === undefined ? undefined : text(record.cursor);
  if (cursor !== undefined && snapshot === undefined) throw new Error();
  return {
    limit: record.limit,
    ...(snapshot === undefined ? {} : {snapshot}),
    ...(cursor === undefined ? {} : {cursor}),
  };
}

function rowText(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`Invalid database value: ${key}`);
  return value;
}

function rowNumber(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`Invalid database value: ${key}`);
  return value;
}

function optionalNumber(row: Row, key: string): number | undefined {
  return row[key] === null || row[key] === undefined ? undefined : rowNumber(row, key);
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function token(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function transaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function cloneEntry(entry: FactChangeEntry): FactChangeEntry {
  return {eventId: entry.eventId, fact: {id: entry.fact.id, revision: entry.fact.revision}};
}

function cloneBatch(batch: FactChangeBatch): FactChangeBatch {
  return {...batch, entries: batch.entries.map(cloneEntry)};
}

function handledKey(entries: readonly FactChangeEntry[]): string {
  return JSON.stringify(entries.map(entry => [entry.eventId, entry.fact.id, entry.fact.revision]));
}

export class SqliteMemoryHost {
  constructor(private readonly db: DatabaseSync) {}

  close(): void {
    this.db.close();
  }

  provision(namespaceValue: unknown): void {
    try {
      const namespace = text(namespaceValue);
      this.db.prepare('INSERT OR IGNORE INTO memory_namespaces(namespace, sequence) VALUES (?, 0)').run(namespace);
    } catch {
      return queryFail();
    }
  }

  append(namespaceValue: unknown, value: unknown): FactVersion {
    try {
      const namespace = text(namespaceValue);
      const next = fact(value);
      return transaction(this.db, () => {
        const namespaceRow = this.db.prepare('SELECT sequence FROM memory_namespaces WHERE namespace = ?')
          .get(namespace) as Row | undefined;
        if (namespaceRow === undefined) return queryFail('NOT_FOUND');
        const previousRow = this.db.prepare(
          'SELECT payload FROM memory_facts WHERE namespace = ? AND fact_id = ? ORDER BY revision DESC LIMIT 1',
        ).get(namespace, next.ref.id) as Row | undefined;
        const previous = previousRow === undefined ? undefined : fact(parseJson(rowText(previousRow, 'payload')));
        if (next.ref.revision !== (previous?.ref.revision ?? 0) + 1) return queryFail();
        if (previous === undefined) {
          if (next.corrects !== undefined || next.state === 'withdrawn') return queryFail();
        } else if (next.corrects === undefined
          || next.corrects.id !== previous.ref.id
          || next.corrects.revision !== previous.ref.revision) return queryFail();

        const sequence = rowNumber(namespaceRow, 'sequence') + 1;
        this.db.prepare(`INSERT INTO memory_facts(
          namespace, sequence, event_id, fact_id, revision, sensitivity, state,
          source_ref, valid_from_ms, valid_until_ms, payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          namespace, sequence, token('memory-feed-event'), next.ref.id, next.ref.revision,
          next.sensitivity, next.state, next.sourceRef, Date.parse(next.validFrom),
          Date.parse(next.validUntil), JSON.stringify(next),
        );
        this.db.prepare('UPDATE memory_namespaces SET sequence = ? WHERE namespace = ?').run(sequence, namespace);
        if (previous !== undefined && previous.sensitivity !== next.sensitivity) {
          const bindings = this.db.prepare(
            'SELECT consumer_id, allowed_json FROM memory_feed_bindings WHERE namespace = ? AND valid = 1',
          ).all(namespace) as Row[];
          for (const binding of bindings) {
            const allowed = new Set(parseJson<FactSensitivity[]>(rowText(binding, 'allowed_json')));
            if (allowed.has(previous.sensitivity) && !allowed.has(next.sensitivity)) {
              this.db.prepare('UPDATE memory_feed_bindings SET valid = 0 WHERE namespace = ? AND consumer_id = ?')
                .run(namespace, rowText(binding, 'consumer_id'));
            }
          }
        }
        return structuredClone(next);
      });
    } catch (error) {
      if (error instanceof MemoryQueryError) throw error;
      return queryFail();
    }
  }

  bind(namespaceValue: unknown, optionsValue: unknown): MemoryQueryPort {
    let namespace: string;
    let allowed: ReturnType<typeof scope>;
    try {
      namespace = text(namespaceValue);
      allowed = scope(optionsValue, false);
      if (this.db.prepare('SELECT 1 FROM memory_namespaces WHERE namespace = ?').get(namespace) === undefined) {
        return queryFail('NOT_FOUND');
      }
    } catch (error) {
      if (error instanceof MemoryQueryError) throw error;
      return queryFail();
    }

    return Object.freeze({
      listCurrent: async (raw: ListCurrentFactsRequest): Promise<FactPage> => {
        try {
          const record = exact(raw, ['at', 'limit', 'deadline', 'signal'],
            ['factId', 'sourceRef', 'snapshot', 'cursor']);
          const operation = context(record, queryFail);
          const at = time(record.at);
          const factId = record.factId === undefined ? undefined : text(record.factId);
          const sourceRef = record.sourceRef === undefined ? undefined : text(record.sourceRef, MAX_SOURCE);
          const page = parsePage(record);
          await Promise.resolve();
          active(operation, queryFail);
          const result = this.queryPage(namespace, allowed, 'current',
            JSON.stringify({at: at.text, factId: factId ?? null, sourceRef: sourceRef ?? null}),
            page, {
              at: at.milliseconds,
              ...(factId === undefined ? {} : {factId}),
              ...(sourceRef === undefined ? {} : {sourceRef}),
            });
          active(operation, queryFail);
          return structuredClone(result);
        } catch (error) {
          if (error instanceof MemoryQueryError) throw error;
          return queryFail();
        }
      },
      listHistory: async (raw: ListFactHistoryRequest): Promise<FactPage> => {
        try {
          const record = exact(raw, ['factId', 'limit', 'deadline', 'signal'], ['snapshot', 'cursor']);
          const operation = context(record, queryFail);
          const factId = text(record.factId);
          const page = parsePage(record);
          await Promise.resolve();
          active(operation, queryFail);
          const result = this.queryPage(namespace, allowed, 'history',
            JSON.stringify({factId}), page, {factId});
          active(operation, queryFail);
          return structuredClone(result);
        } catch (error) {
          if (error instanceof MemoryQueryError) throw error;
          return queryFail();
        }
      },
      getVersion: async (raw: GetFactVersionRequest): Promise<FactVersion> => {
        try {
          const record = exact(raw, ['fact', 'deadline', 'signal']);
          const operation = context(record, queryFail);
          const requested = ref(record.fact);
          await Promise.resolve();
          active(operation, queryFail);
          const row = this.db.prepare(
            'SELECT payload, sensitivity FROM memory_facts WHERE namespace = ? AND fact_id = ? AND revision = ?',
          ).get(namespace, requested.id, requested.revision) as Row | undefined;
          if (row === undefined || !allowed.values.includes(rowText(row, 'sensitivity') as FactSensitivity)) {
            return queryFail('SCOPE_DENIED');
          }
          const result = fact(parseJson(rowText(row, 'payload')));
          active(operation, queryFail);
          return structuredClone(result);
        } catch (error) {
          if (error instanceof MemoryQueryError) throw error;
          return queryFail();
        }
      },
    });
  }

  bindFeed(namespaceValue: unknown, optionsValue: unknown): FactChangeFeedPort {
    let namespace: string;
    let allowed: ReturnType<typeof scope>;
    let bindingId: string;
    try {
      namespace = text(namespaceValue);
      allowed = scope(optionsValue, true);
      if (this.db.prepare('SELECT 1 FROM memory_namespaces WHERE namespace = ?').get(namespace) === undefined) {
        return feedFail('SCOPE_DENIED');
      }
      bindingId = transaction(this.db, () => {
        const current = this.db.prepare(
          'SELECT binding_id, scope_key, valid FROM memory_feed_bindings WHERE namespace = ? AND consumer_id = ?',
        ).get(namespace, allowed.consumerId!) as Row | undefined;
        if (current !== undefined && rowNumber(current, 'valid') === 1
          && rowText(current, 'scope_key') === allowed.key) return rowText(current, 'binding_id');
        const nextBinding = token('memory-feed-binding');
        this.db.prepare(`INSERT INTO memory_feed_bindings(
          namespace, consumer_id, binding_id, scope_key, allowed_json, valid, checkpoint, mode,
          bootstrap_watermark, bootstrap_watermark_token, bootstrap_entries_json,
          bootstrap_offset, changes_after, pending_batch_token
        ) VALUES (?, ?, ?, ?, ?, 1, ?, 'bootstrap', NULL, NULL, NULL, 0, 0, NULL)
        ON CONFLICT(namespace, consumer_id) DO UPDATE SET
          binding_id = excluded.binding_id, scope_key = excluded.scope_key,
          allowed_json = excluded.allowed_json, valid = 1, checkpoint = excluded.checkpoint,
          mode = 'bootstrap', bootstrap_watermark = NULL, bootstrap_watermark_token = NULL,
          bootstrap_entries_json = NULL, bootstrap_offset = 0, changes_after = 0,
          pending_batch_token = NULL`).run(
          namespace, allowed.consumerId!, nextBinding, allowed.key,
          JSON.stringify(allowed.values), token('memory-feed-checkpoint'),
        );
        return nextBinding;
      });
    } catch (error) {
      if (error instanceof FactChangeFeedError) throw error;
      return feedFail();
    }

    return Object.freeze({
      read: async (raw: ReadFactChangesRequest): Promise<FactChangeBatch> => {
        try {
          const record = exact(raw, ['limit', 'deadline', 'signal']);
          const operation = context(record, feedFail);
          if (typeof record.limit !== 'number' || !Number.isSafeInteger(record.limit)
            || record.limit < 1 || record.limit > MAX_PAGE) return feedFail();
          await Promise.resolve();
          active(operation, feedFail);
          const batch = transaction(this.db, () => this.readFeedBatch(
            namespace, allowed.consumerId!, bindingId, allowed.values, record.limit as number,
          ));
          active(operation, feedFail);
          return cloneBatch(batch);
        } catch (error) {
          if (error instanceof FactChangeFeedError) throw error;
          return feedFail();
        }
      },
    });
  }

  confirmFeedBatch(namespaceValue: unknown, consumerValue: unknown, requestValue: unknown): FactChangeReceipt {
    try {
      const namespace = text(namespaceValue);
      const consumerId = text(consumerValue);
      const record = exact(requestValue, ['batchToken', 'expectedCheckpoint', 'handled', 'deadline', 'signal']);
      const operation = context(record, feedFail);
      const batchToken = text(record.batchToken);
      const expectedCheckpoint = text(record.expectedCheckpoint);
      const handled = parseHandled(record.handled);
      active(operation, feedFail);
      return transaction(this.db, () => {
        const delivery = this.db.prepare('SELECT * FROM memory_feed_deliveries WHERE batch_token = ?')
          .get(batchToken) as Row | undefined;
        if (delivery === undefined || rowText(delivery, 'namespace') !== namespace
          || rowText(delivery, 'consumer_id') !== consumerId) return feedFail('SCOPE_DENIED');
        const binding = this.db.prepare(
          'SELECT * FROM memory_feed_bindings WHERE namespace = ? AND consumer_id = ?',
        ).get(namespace, consumerId) as Row | undefined;
        if (binding === undefined) return feedFail('SCOPE_DENIED');
        if (rowNumber(binding, 'valid') !== 1
          || rowText(binding, 'binding_id') !== rowText(delivery, 'binding_id')) return feedFail('REBUILD_REQUIRED');

        const suppliedHandled = handledKey(handled);
        const batch = parseJson<FactChangeBatch>(rowText(delivery, 'batch_json'));
        if (rowNumber(delivery, 'confirmed') === 1) {
          if (expectedCheckpoint !== rowText(delivery, 'confirmed_expected_checkpoint')) {
            return feedFail('REVISION_CONFLICT');
          }
          if (suppliedHandled !== rowText(delivery, 'confirmed_handled_key')) return feedFail();
          return {batchToken, checkpoint: rowText(delivery, 'receipt_checkpoint')};
        }
        if (binding.pending_batch_token !== batchToken) return feedFail('SCOPE_DENIED');
        if (expectedCheckpoint !== batch.baseCheckpoint
          || rowText(binding, 'checkpoint') !== batch.baseCheckpoint) return feedFail('REVISION_CONFLICT');
        if (suppliedHandled !== handledKey(batch.entries)) return feedFail();

        const nextCheckpoint = token('memory-feed-checkpoint');
        if (batch.mode === 'bootstrap') {
          const nextOffset = optionalNumber(delivery, 'next_bootstrap_offset');
          if (nextOffset === undefined) throw new Error('Missing bootstrap offset');
          if (batch.atWatermark) {
            this.db.prepare(`UPDATE memory_feed_bindings SET bootstrap_offset = ?, mode = 'changes',
              changes_after = bootstrap_watermark, checkpoint = ?, pending_batch_token = NULL
              WHERE namespace = ? AND consumer_id = ?`).run(nextOffset, nextCheckpoint, namespace, consumerId);
          } else {
            this.db.prepare(`UPDATE memory_feed_bindings SET bootstrap_offset = ?, checkpoint = ?,
              pending_batch_token = NULL WHERE namespace = ? AND consumer_id = ?`)
              .run(nextOffset, nextCheckpoint, namespace, consumerId);
          }
        } else {
          const nextPosition = optionalNumber(delivery, 'next_changes_after');
          if (nextPosition === undefined) throw new Error('Missing changes position');
          this.db.prepare(`UPDATE memory_feed_bindings SET changes_after = ?, checkpoint = ?,
            pending_batch_token = NULL WHERE namespace = ? AND consumer_id = ?`)
            .run(nextPosition, nextCheckpoint, namespace, consumerId);
        }
        this.db.prepare(`UPDATE memory_feed_deliveries SET confirmed = 1,
          confirmed_expected_checkpoint = ?, confirmed_handled_key = ?, receipt_checkpoint = ?
          WHERE batch_token = ?`).run(expectedCheckpoint, suppliedHandled, nextCheckpoint, batchToken);
        return {batchToken, checkpoint: nextCheckpoint};
      });
    } catch (error) {
      if (error instanceof FactChangeFeedError) throw error;
      return feedFail();
    }
  }

  private queryPage(
    namespace: string,
    allowed: ReturnType<typeof scope>,
    mode: 'current' | 'history',
    filterKey: string,
    page: PageOptions,
    criteria: {readonly at?: number; readonly factId?: string; readonly sourceRef?: string},
  ): FactPage {
    let snapshot = page.snapshot;
    let watermark: number;
    if (snapshot === undefined) {
      const namespaceRow = this.db.prepare('SELECT sequence FROM memory_namespaces WHERE namespace = ?')
        .get(namespace) as Row | undefined;
      if (namespaceRow === undefined) return queryFail('NOT_FOUND');
      watermark = rowNumber(namespaceRow, 'sequence');
      snapshot = token('memory-snapshot');
      this.db.prepare(`INSERT INTO memory_query_snapshots(
        token, namespace, scope_key, mode, filter_key, watermark
      ) VALUES (?, ?, ?, ?, ?, ?)`).run(
        snapshot, namespace, allowed.key, mode, filterKey, watermark,
      );
    } else {
      const snapshotRow = this.db.prepare('SELECT * FROM memory_query_snapshots WHERE token = ?')
        .get(snapshot) as Row | undefined;
      if (snapshotRow === undefined
        || rowText(snapshotRow, 'namespace') !== namespace
        || rowText(snapshotRow, 'scope_key') !== allowed.key
        || rowText(snapshotRow, 'mode') !== mode
        || rowText(snapshotRow, 'filter_key') !== filterKey) return queryFail();
      watermark = rowNumber(snapshotRow, 'watermark');
    }

    let offset = 0;
    if (page.cursor !== undefined) {
      const cursorRow = this.db.prepare(
        'SELECT snapshot_token, offset FROM memory_query_cursors WHERE token = ?',
      ).get(page.cursor) as Row | undefined;
      if (cursorRow === undefined || rowText(cursorRow, 'snapshot_token') !== snapshot) return queryFail();
      offset = rowNumber(cursorRow, 'offset');
    }

    const placeholders = allowed.values.map(() => '?').join(', ');
    let rows: Row[];
    if (mode === 'current') {
      const clauses = [
        'f.namespace = ?',
        'f.sequence <= ?',
        `f.sensitivity IN (${placeholders})`,
        "f.state = 'active'",
        'f.valid_from_ms <= ?',
        '? < f.valid_until_ms',
      ];
      const parameters: (string | number)[] = [
        namespace, watermark, ...allowed.values, criteria.at!, criteria.at!,
      ];
      if (criteria.factId !== undefined) { clauses.push('f.fact_id = ?'); parameters.push(criteria.factId); }
      if (criteria.sourceRef !== undefined) { clauses.push('f.source_ref = ?'); parameters.push(criteria.sourceRef); }
      rows = this.db.prepare(`SELECT f.payload FROM memory_facts f
        JOIN (
          SELECT fact_id, MAX(revision) revision FROM memory_facts
          WHERE namespace = ? AND sequence <= ? GROUP BY fact_id
        ) latest ON latest.fact_id = f.fact_id AND latest.revision = f.revision
        WHERE ${clauses.join(' AND ')}
        ORDER BY f.fact_id, f.revision LIMIT ? OFFSET ?`).all(
        namespace, watermark, ...parameters, page.limit + 1, offset,
      ) as Row[];
    } else {
      rows = this.db.prepare(`SELECT payload FROM memory_facts
        WHERE namespace = ? AND sequence <= ? AND fact_id = ?
          AND sensitivity IN (${placeholders})
        ORDER BY fact_id, revision LIMIT ? OFFSET ?`).all(
        namespace, watermark, criteria.factId!, ...allowed.values, page.limit + 1, offset,
      ) as Row[];
    }

    const hasMore = rows.length > page.limit;
    const facts = rows.slice(0, page.limit).map(row => fact(parseJson(rowText(row, 'payload'))));
    if (!hasMore) return {snapshot, facts};
    const nextCursor = token('memory-cursor');
    this.db.prepare('INSERT INTO memory_query_cursors(token, snapshot_token, offset) VALUES (?, ?, ?)')
      .run(nextCursor, snapshot, offset + facts.length);
    return {snapshot, facts, nextCursor};
  }

  private readFeedBatch(
    namespace: string,
    consumerId: string,
    bindingId: string,
    allowed: readonly FactSensitivity[],
    limit: number,
  ): FactChangeBatch {
    const binding = this.db.prepare(
      'SELECT * FROM memory_feed_bindings WHERE namespace = ? AND consumer_id = ?',
    ).get(namespace, consumerId) as Row | undefined;
    if (binding === undefined) return feedFail('SCOPE_DENIED');
    if (rowNumber(binding, 'valid') !== 1 || rowText(binding, 'binding_id') !== bindingId) {
      return feedFail('REBUILD_REQUIRED');
    }
    if (typeof binding.pending_batch_token === 'string') {
      const pending = this.db.prepare('SELECT batch_json FROM memory_feed_deliveries WHERE batch_token = ?')
        .get(binding.pending_batch_token) as Row | undefined;
      if (pending === undefined) throw new Error('Missing pending delivery');
      return parseJson<FactChangeBatch>(rowText(pending, 'batch_json'));
    }

    const mode = rowText(binding, 'mode') as FactChangeBatch['mode'];
    let batch: FactChangeBatch;
    let nextBootstrapOffset: number | undefined;
    let nextChangesAfter: number | undefined;
    if (mode === 'bootstrap') {
      let watermark = optionalNumber(binding, 'bootstrap_watermark');
      let watermarkToken = typeof binding.bootstrap_watermark_token === 'string'
        ? binding.bootstrap_watermark_token : undefined;
      let entries = typeof binding.bootstrap_entries_json === 'string'
        ? parseJson<FactChangeEntry[]>(binding.bootstrap_entries_json) : undefined;
      if (watermark === undefined) {
        const namespaceRow = this.db.prepare('SELECT sequence FROM memory_namespaces WHERE namespace = ?')
          .get(namespace) as Row;
        watermark = rowNumber(namespaceRow, 'sequence');
        watermarkToken = token('memory-feed-watermark');
        const placeholders = allowed.map(() => '?').join(', ');
        const rows = this.db.prepare(`SELECT f.event_id, f.fact_id, f.revision FROM memory_facts f
          JOIN (
            SELECT fact_id, MAX(revision) revision FROM memory_facts
            WHERE namespace = ? AND sequence <= ? GROUP BY fact_id
          ) latest ON latest.fact_id = f.fact_id AND latest.revision = f.revision
          WHERE f.namespace = ? AND f.sequence <= ? AND f.sensitivity IN (${placeholders})
          ORDER BY f.fact_id, f.revision`).all(
          namespace, watermark, namespace, watermark, ...allowed,
        ) as Row[];
        entries = rows.map(row => ({
          eventId: rowText(row, 'event_id'),
          fact: {id: rowText(row, 'fact_id'), revision: rowNumber(row, 'revision')},
        }));
        this.db.prepare(`UPDATE memory_feed_bindings SET bootstrap_watermark = ?,
          bootstrap_watermark_token = ?, bootstrap_entries_json = ?
          WHERE namespace = ? AND consumer_id = ?`).run(
          watermark, watermarkToken, JSON.stringify(entries), namespace, consumerId,
        );
      }
      const offset = rowNumber(binding, 'bootstrap_offset');
      const selected = entries!.slice(offset, offset + limit);
      nextBootstrapOffset = offset + selected.length;
      batch = {
        mode,
        batchToken: token('memory-feed-batch'),
        baseCheckpoint: rowText(binding, 'checkpoint'),
        watermark: watermarkToken!,
        entries: selected.map(cloneEntry),
        atWatermark: nextBootstrapOffset === entries!.length,
      };
    } else {
      const namespaceRow = this.db.prepare('SELECT sequence FROM memory_namespaces WHERE namespace = ?')
        .get(namespace) as Row;
      const watermark = rowNumber(namespaceRow, 'sequence');
      const changesAfter = rowNumber(binding, 'changes_after');
      const placeholders = allowed.map(() => '?').join(', ');
      const rows = this.db.prepare(`SELECT sequence, event_id, fact_id, revision FROM memory_facts
        WHERE namespace = ? AND sequence > ? AND sequence <= ? AND sensitivity IN (${placeholders})
        ORDER BY sequence LIMIT ?`).all(
        namespace, changesAfter, watermark, ...allowed, limit + 1,
      ) as Row[];
      const selected = rows.slice(0, limit);
      const atWatermark = rows.length <= limit;
      nextChangesAfter = atWatermark ? watermark : rowNumber(selected.at(-1)!, 'sequence');
      batch = {
        mode,
        batchToken: token('memory-feed-batch'),
        baseCheckpoint: rowText(binding, 'checkpoint'),
        watermark: token('memory-feed-watermark'),
        entries: selected.map(row => ({
          eventId: rowText(row, 'event_id'),
          fact: {id: rowText(row, 'fact_id'), revision: rowNumber(row, 'revision')},
        })),
        atWatermark,
      };
    }

    this.db.prepare(`INSERT INTO memory_feed_deliveries(
      batch_token, namespace, consumer_id, binding_id, batch_json,
      next_bootstrap_offset, next_changes_after, confirmed,
      confirmed_expected_checkpoint, confirmed_handled_key, receipt_checkpoint
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL)`).run(
      batch.batchToken,
      namespace,
      consumerId,
      bindingId,
      JSON.stringify(batch),
      nextBootstrapOffset ?? null,
      nextChangesAfter ?? null,
    );
    this.db.prepare(
      'UPDATE memory_feed_bindings SET pending_batch_token = ? WHERE namespace = ? AND consumer_id = ?',
    ).run(batch.batchToken, namespace, consumerId);
    return batch;
  }
}

function parseHandled(value: unknown): readonly FactChangeEntry[] {
  if (!Array.isArray(value) || value.length > MAX_PAGE
    || Reflect.ownKeys(value).length !== value.length + 1) throw new Error();
  const events = new Set<string>();
  const facts = new Set<string>();
  return value.map(item => {
    const record = exact(item, ['eventId', 'fact']);
    const eventId = text(record.eventId);
    const parsedRef = ref(record.fact);
    const factKey = JSON.stringify([parsedRef.id, parsedRef.revision]);
    if (events.has(eventId) || facts.has(factKey)) throw new Error();
    events.add(eventId);
    facts.add(factKey);
    return {eventId, fact: parsedRef};
  });
}

export function openSqliteMemoryHost(path: string): SqliteMemoryHost {
  return new SqliteMemoryHost(openStorage(path, MIGRATIONS));
}
