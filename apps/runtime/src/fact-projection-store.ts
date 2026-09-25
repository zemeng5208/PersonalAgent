import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {appendVersions, CoordinationStoreError} from '@personal-agent/goals/store';
import {GraphError, parseGraph} from '@personal-agent/goals';
import type {GraphSnapshot, NodeInput, NodeRef} from '@personal-agent/goals';
import {parseFactChangeBatch} from '@personal-agent/memory';
import type {FactChangeBatch, FactChangeReceipt, FactRef, FactVersion, MemoryReadContext} from '@personal-agent/memory';
import type {ImpactReport} from '@personal-agent/cognition';

export interface FactProjectionRequest extends MemoryReadContext {
  readonly consumerKey: string;
  readonly memoryNamespace: string;
  readonly batch: FactChangeBatch;
  readonly facts: readonly FactVersion[];
}

export interface FactProjectionLink {
  readonly eventId: string;
  readonly fact: FactRef;
  readonly node: NodeRef;
}

export interface FactProjectionReceipt {
  readonly batchToken: string;
  readonly graphRevision: number;
  readonly links: readonly FactProjectionLink[];
}

export interface PendingFactImpact extends FactProjectionReceipt {
  readonly consumerKey: string;
  readonly memoryNamespace: string;
}

export interface CompletedFactImpact {
  readonly batchToken: string;
  readonly report: ImpactReport;
}

export type StagedFactProjection = Pick<FactProjectionRequest,
  'consumerKey' | 'memoryNamespace' | 'batch' | 'facts'>;

export interface FactProjectionStore {
  stage(request: FactProjectionRequest): void;
  readStaged(consumerKey: string, memoryNamespace: string): StagedFactProjection | undefined;
  discardStaged(consumerKey: string, memoryNamespace: string, batchToken: string): void;
  project(request: FactProjectionRequest, providerReceipt: FactChangeReceipt): FactProjectionReceipt;
  readPending(limit?: number, scope?: {readonly consumerKey: string; readonly memoryNamespace: string}): readonly PendingFactImpact[];
  readCompletedImpact(scope: {readonly consumerKey: string; readonly memoryNamespace: string;
    readonly batchToken: string}): CompletedFactImpact | undefined;
  completeImpact(request: CompleteFactImpactRequest): void;
}

export interface CompleteFactImpactRequest extends MemoryReadContext {
  readonly consumerKey: string;
  readonly memoryNamespace: string;
  readonly batchToken: string;
  readonly expectedGraphRevision: number;
  readonly report: ImpactReport;
}

export class FactProjectionError extends Error {
  constructor(readonly code: 'INVALID_ARGUMENT' | 'INTEGRITY_CONFLICT' | 'NOT_FOUND' | 'TIMEOUT' | 'CANCELLED' | 'STORAGE_UNAVAILABLE') {
    super(code === 'INTEGRITY_CONFLICT' ? 'Fact projection identity conflict' : 'Fact projection ' + code.toLowerCase());
    this.name = 'FactProjectionError';
  }
}

interface ProjectionInput {
  readonly consumerKey: string;
  readonly memoryNamespace: string;
  readonly batch: FactChangeBatch;
  readonly facts: readonly FactVersion[];
  readonly deadline: string;
  readonly signal: AbortSignal;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const record = value as Record<string, unknown>;
  return '{' + Object.keys(record).sort()
    .map(key => JSON.stringify(key) + ':' + canonical(record[key])).join(',') + '}';
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function text(value: unknown, maximum = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new FactProjectionError('INVALID_ARGUMENT');
  return value;
}

function instant(value: unknown): {readonly text: string; readonly milliseconds: number} {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new FactProjectionError('INVALID_ARGUMENT');
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new FactProjectionError('INVALID_ARGUMENT');
  }
  return {text: value, milliseconds};
}

function ref(value: unknown): FactRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FactProjectionError('INVALID_ARGUMENT');
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).length !== 2 || !Object.hasOwn(raw, 'id') || !Object.hasOwn(raw, 'revision')
    || !Number.isSafeInteger(raw.revision) || (raw.revision as number) < 1) {
    throw new FactProjectionError('INVALID_ARGUMENT');
  }
  return {id: text(raw.id), revision: raw.revision as number};
}

function parseFact(value: unknown): FactVersion {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FactProjectionError('INVALID_ARGUMENT');
  const raw = value as Record<string, unknown>;
  const required = ['ref', 'summary', 'sourceRef', 'observedAt', 'validFrom', 'validUntil',
    'sensitivity', 'state', 'confirmation'];
  const keys = Object.keys(raw);
  if (required.some(key => !Object.hasOwn(raw, key))
    || keys.some(key => !required.includes(key) && key !== 'corrects')
    || keys.length !== required.length + (Object.hasOwn(raw, 'corrects') ? 1 : 0)
    || !['public', 'private', 'restricted'].includes(raw.sensitivity as string)
    || !['active', 'withdrawn'].includes(raw.state as string)
    || !['external_observation', 'model_inference', 'user_confirmed'].includes(raw.confirmation as string)) {
    throw new FactProjectionError('INVALID_ARGUMENT');
  }
  const observedAt = instant(raw.observedAt);
  const validFrom = instant(raw.validFrom);
  const validUntil = instant(raw.validUntil);
  if (validFrom.milliseconds >= validUntil.milliseconds) throw new FactProjectionError('INVALID_ARGUMENT');
  const parsed: FactVersion = {
    ref: ref(raw.ref),
    summary: text(raw.summary, 4096),
    sourceRef: text(raw.sourceRef, 1024),
    observedAt: observedAt.text,
    validFrom: validFrom.text,
    validUntil: validUntil.text,
    sensitivity: raw.sensitivity as FactVersion['sensitivity'],
    state: raw.state as FactVersion['state'],
    confirmation: raw.confirmation as FactVersion['confirmation']
  };
  if (raw.corrects !== undefined) parsed.corrects = ref(raw.corrects);
  return parsed;
}

function checkpoint(context: MemoryReadContext): void {
  if (context.signal.aborted) throw new FactProjectionError('CANCELLED');
  const deadline = instant(context.deadline).milliseconds;
  if (Date.now() >= deadline) throw new FactProjectionError('TIMEOUT');
}

function factKey(value: FactRef): string {
  return JSON.stringify([value.id, value.revision]);
}

function validateRequest(request: FactProjectionRequest): ProjectionInput {
  if (!request || typeof request !== 'object') throw new FactProjectionError('INVALID_ARGUMENT');
  if (!request.signal || typeof request.signal.aborted !== 'boolean') {
    throw new FactProjectionError('INVALID_ARGUMENT');
  }
  const context = {deadline: text(request.deadline), signal: request.signal};
  checkpoint(context);
  const batch = parseFactChangeBatch(request.batch);
  if (!Array.isArray(request.facts) || request.facts.length !== batch.entries.length) {
    throw new FactProjectionError('INVALID_ARGUMENT');
  }
  const facts = request.facts.map(parseFact);
  const byRef = new Map(facts.map(fact => [factKey(fact.ref), fact]));
  if (byRef.size !== facts.length || batch.entries.some(entry => !byRef.has(factKey(entry.fact)))) {
    throw new FactProjectionError('INVALID_ARGUMENT');
  }
  return {
    consumerKey: text(request.consumerKey),
    memoryNamespace: text(request.memoryNamespace),
    batch,
    facts: batch.entries.map(entry => byRef.get(factKey(entry.fact))!),
    ...context
  };
}

function nodeId(namespace: string, factId: string): string {
  return 'memory-fact:' + createHash('sha256').update(JSON.stringify([namespace, factId])).digest('base64url');
}

function nodeInput(namespace: string, fact: FactVersion): NodeInput {
  return {
    id: nodeId(namespace, fact.ref.id),
    kind: 'fact',
    summary: fact.summary,
    sourceRef: fact.sourceRef,
    validFrom: fact.validFrom,
    validUntil: fact.validUntil,
    sensitivity: fact.sensitivity,
    state: fact.state,
    reason: 'Projected from immutable Memory fact ' + fact.ref.id + '@' + fact.ref.revision,
    dependencies: []
  };
}

function storage<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof FactProjectionError || error instanceof GraphError
      || error instanceof CoordinationStoreError) throw error;
    throw new FactProjectionError('STORAGE_UNAVAILABLE');
  }
}

function loadGraph(db: DatabaseSync, namespace: string): GraphSnapshot {
  const row = db.prepare('SELECT snapshot_json FROM coordination_graphs WHERE namespace = ?').get(namespace);
  if (!row) throw new CoordinationStoreError('NOT_FOUND');
  try {
    const graph = parseGraph(JSON.parse(row.snapshot_json as string));
    if (graph.namespace !== namespace) throw new Error();
    return graph;
  } catch {
    throw new CoordinationStoreError('STORAGE_UNAVAILABLE');
  }
}

function parseLinks(value: unknown): readonly FactProjectionLink[] {
  if (!Array.isArray(value)) throw new Error();
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error();
    const raw = item as Record<string, unknown>;
    if (Object.keys(raw).length !== 3) throw new Error();
    return {eventId: text(raw.eventId), fact: ref(raw.fact), node: ref(raw.node)};
  });
}

function receipt(row: Record<string, unknown>): FactProjectionReceipt {
  return {
    batchToken: row.batch_token as string,
    graphRevision: row.graph_revision as number,
    links: parseLinks(JSON.parse(row.links_json as string))
  };
}

interface NewProjection {
  readonly entry: FactChangeBatch['entries'][number];
  readonly fact: FactVersion;
  readonly contentHash: string;
}

/** Runtime-owned adapter. The caller receives no database or general transaction callback. */
export function bindFactProjectionStore(db: DatabaseSync, graphNamespace: string): FactProjectionStore {
  const namespace = text(graphNamespace);
  return Object.freeze({
    stage: (request: FactProjectionRequest): void => {
      const input = validateRequest(request);
      const handledKey = digest({batch: input.batch, facts: input.facts});
      storage(() => {
        checkpoint(input);
        db.exec('BEGIN IMMEDIATE');
        try {
          checkpoint(input);
          loadGraph(db, namespace);
          const completed = db.prepare([
            'SELECT handled_key FROM coordination_projection_receipts',
            'WHERE graph_namespace = ? AND memory_namespace = ? AND consumer_key = ? AND batch_token = ?'
          ].join(' ')).get(namespace, input.memoryNamespace, input.consumerKey,
            input.batch.batchToken) as Record<string, unknown> | undefined;
          if (completed) {
            if (completed.handled_key !== handledKey) throw new FactProjectionError('INTEGRITY_CONFLICT');
          } else {
            const existing = db.prepare([
              'SELECT batch_token, handled_key FROM coordination_projection_staging',
              'WHERE graph_namespace = ? AND memory_namespace = ? AND consumer_key = ?'
            ].join(' ')).all(namespace, input.memoryNamespace, input.consumerKey) as Record<string, unknown>[];
            if (existing.length > 1 || (existing.length === 1
              && (existing[0]!.batch_token !== input.batch.batchToken
                || existing[0]!.handled_key !== handledKey))) {
              throw new FactProjectionError('INTEGRITY_CONFLICT');
            }
            if (!existing.length) db.prepare([
              'INSERT INTO coordination_projection_staging',
              '(graph_namespace, memory_namespace, consumer_key, batch_token, handled_key, payload_json, staged_at)',
              'VALUES (?, ?, ?, ?, ?, ?, ?)'
            ].join(' ')).run(namespace, input.memoryNamespace, input.consumerKey,
              input.batch.batchToken, handledKey,
              JSON.stringify({batch: input.batch, facts: input.facts}), new Date().toISOString());
          }
          checkpoint(input);
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      });
    },
    readStaged: (consumerKey: string, memoryNamespace: string): StagedFactProjection | undefined => storage(() => {
      const consumer = text(consumerKey);
      const memory = text(memoryNamespace);
      const rows = db.prepare([
        'SELECT batch_token, handled_key, payload_json FROM coordination_projection_staging',
        'WHERE graph_namespace = ? AND memory_namespace = ? AND consumer_key = ?'
      ].join(' ')).all(namespace, memory, consumer) as Record<string, unknown>[];
      if (!rows.length) return undefined;
      if (rows.length !== 1) throw new FactProjectionError('INTEGRITY_CONFLICT');
      const payload = JSON.parse(rows[0]!.payload_json as string) as {batch: FactChangeBatch; facts: FactVersion[]};
      const batch = parseFactChangeBatch(payload.batch);
      const facts = payload.facts.map(parseFact);
      if (batch.batchToken !== rows[0]!.batch_token
        || digest({batch, facts}) !== rows[0]!.handled_key) throw new FactProjectionError('INTEGRITY_CONFLICT');
      return {consumerKey: consumer, memoryNamespace: memory, batch, facts};
    }),
    discardStaged: (consumerKey: string, memoryNamespace: string, batchToken: string): void => storage(() => {
      db.prepare([
        'DELETE FROM coordination_projection_staging',
        'WHERE graph_namespace = ? AND memory_namespace = ? AND consumer_key = ? AND batch_token = ?'
      ].join(' ')).run(namespace, text(memoryNamespace), text(consumerKey), text(batchToken));
    }),
    project: (request: FactProjectionRequest, providerReceipt: FactChangeReceipt): FactProjectionReceipt => {
      const input = validateRequest(request);
      const handledKey = digest({batch: input.batch, facts: input.facts});
      if (!providerReceipt || providerReceipt.batchToken !== input.batch.batchToken) {
        throw new FactProjectionError('INVALID_ARGUMENT');
      }
      text(providerReceipt.checkpoint);
      return storage(() => {
        checkpoint(input);
        db.exec('BEGIN IMMEDIATE');
        try {
          checkpoint(input);
          const existingReceipt = db.prepare([
            'SELECT batch_token, handled_key, graph_revision, links_json',
            'FROM coordination_projection_receipts',
            'WHERE graph_namespace = ? AND memory_namespace = ? AND consumer_key = ? AND batch_token = ?'
          ].join(' ')).get(namespace, input.memoryNamespace, input.consumerKey,
            input.batch.batchToken) as Record<string, unknown> | undefined;
          if (existingReceipt) {
            if (existingReceipt.handled_key !== handledKey) throw new FactProjectionError('INTEGRITY_CONFLICT');
            const result = receipt(existingReceipt);
            checkpoint(input);
            db.exec('COMMIT');
            return result;
          }

          const staged = db.prepare([
            'SELECT handled_key, payload_json FROM coordination_projection_staging',
            'WHERE graph_namespace = ? AND memory_namespace = ? AND consumer_key = ? AND batch_token = ?'
          ].join(' ')).get(namespace, input.memoryNamespace, input.consumerKey,
            input.batch.batchToken) as Record<string, unknown> | undefined;
          if (!staged) throw new FactProjectionError('NOT_FOUND');
          if (staged.handled_key !== handledKey
            || digest(JSON.parse(staged.payload_json as string)) !== handledKey) {
            throw new FactProjectionError('INTEGRITY_CONFLICT');
          }

          const graph = loadGraph(db, namespace);
          const links = new Map<string, FactProjectionLink>();
          const pending: NewProjection[] = [];
          for (let index = 0; index < input.batch.entries.length; index++) {
            const entry = input.batch.entries[index]!;
            const fact = input.facts[index]!;
            const contentHash = digest(fact);
            const mapped = db.prepare([
              'SELECT event_id, content_hash, node_id, node_revision, graph_revision',
              'FROM coordination_fact_projections',
              'WHERE graph_namespace = ? AND memory_namespace = ? AND fact_id = ? AND fact_revision = ?'
            ].join(' ')).get(namespace, input.memoryNamespace, fact.ref.id, fact.ref.revision) as Record<string, unknown> | undefined;
            if (mapped) {
              if (mapped.event_id !== entry.eventId || mapped.content_hash !== contentHash) {
                throw new FactProjectionError('INTEGRITY_CONFLICT');
              }
              if (!graph.history.some(node => node.id === mapped.node_id
                && node.revision === mapped.node_revision
                && node.graphRevision === mapped.graph_revision)) {
                throw new FactProjectionError('INTEGRITY_CONFLICT');
              }
              links.set(factKey(fact.ref), {
                eventId: entry.eventId,
                fact: structuredClone(fact.ref),
                node: {id: mapped.node_id as string, revision: mapped.node_revision as number}
              });
              continue;
            }
            const event = db.prepare([
              'SELECT fact_id, fact_revision FROM coordination_fact_projections',
              'WHERE graph_namespace = ? AND memory_namespace = ? AND event_id = ?'
            ].join(' ')).get(namespace, input.memoryNamespace, entry.eventId) as Record<string, unknown> | undefined;
            if (event && (event.fact_id !== fact.ref.id || event.fact_revision !== fact.ref.revision)) {
              throw new FactProjectionError('INTEGRITY_CONFLICT');
            }
            pending.push({entry, fact, contentHash});
          }

          const next = pending.length
            ? appendVersions(graph, graph.revision, pending.map(item => nodeInput(input.memoryNamespace, item.fact)))
            : graph;
          const appended = next.history.slice(graph.history.length);
          for (let index = 0; index < pending.length; index++) {
            const item = pending[index]!;
            const node = appended[index]!;
            db.prepare([
              'INSERT INTO coordination_fact_projections',
              '(graph_namespace, memory_namespace, fact_id, fact_revision, event_id, content_hash,',
              'node_id, node_revision, graph_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
            ].join(' ')).run(namespace, input.memoryNamespace, item.fact.ref.id, item.fact.ref.revision,
              item.entry.eventId, item.contentHash, node.id, node.revision, node.graphRevision);
            links.set(factKey(item.fact.ref), {
              eventId: item.entry.eventId,
              fact: structuredClone(item.fact.ref),
              node: {id: node.id, revision: node.revision}
            });
          }
          if (pending.length) {
            db.prepare('UPDATE coordination_graphs SET snapshot_json = ? WHERE namespace = ?')
              .run(JSON.stringify(next), namespace);
          }

          const orderedLinks = input.batch.entries.map(entry => links.get(factKey(entry.fact))!);
          const linksJson = JSON.stringify(orderedLinks);
          const now = new Date().toISOString();
          db.prepare([
            'INSERT INTO coordination_projection_receipts',
            '(graph_namespace, memory_namespace, consumer_key, batch_token, base_checkpoint, watermark, handled_key,',
            'graph_revision, links_json, committed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
          ].join(' ')).run(namespace, input.memoryNamespace, input.consumerKey,
            input.batch.batchToken, input.batch.baseCheckpoint,
            input.batch.watermark, handledKey, next.revision, linksJson, now);
          if (pending.length) {
            const pendingLinks = pending.map(item => links.get(factKey(item.fact.ref))!);
            db.prepare([
              'INSERT INTO coordination_pending_impacts',
              '(graph_namespace, memory_namespace, consumer_key, batch_token, graph_revision, links_json, created_at)',
              'VALUES (?, ?, ?, ?, ?, ?, ?)'
            ].join(' ')).run(namespace, input.memoryNamespace, input.consumerKey, input.batch.batchToken,
              next.revision, JSON.stringify(pendingLinks), now);
          }
          db.prepare([
            'DELETE FROM coordination_projection_staging',
            'WHERE graph_namespace = ? AND memory_namespace = ? AND consumer_key = ? AND batch_token = ?'
          ].join(' ')).run(namespace, input.memoryNamespace, input.consumerKey, input.batch.batchToken);
          checkpoint(input);
          db.exec('COMMIT');
          return {batchToken: input.batch.batchToken, graphRevision: next.revision, links: orderedLinks};
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      });
    },
    readPending: (limit = 100, scope?: {readonly consumerKey: string; readonly memoryNamespace: string}): readonly PendingFactImpact[] => storage(() => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new FactProjectionError('INVALID_ARGUMENT');
      const consumer = scope === undefined ? undefined : text(scope.consumerKey);
      const memory = scope === undefined ? undefined : text(scope.memoryNamespace);
      loadGraph(db, namespace);
      const rows = db.prepare([
        'SELECT memory_namespace, consumer_key, batch_token, graph_revision, links_json',
        'FROM coordination_pending_impacts',
        'WHERE graph_namespace = ? AND handled_at IS NULL',
        ...(scope === undefined ? [] : ['AND consumer_key = ? AND memory_namespace = ?']),
        'ORDER BY created_at, batch_token LIMIT ?'
      ].join(' ')).all(...(scope === undefined ? [namespace, limit] : [namespace, consumer!, memory!, limit])) as Record<string, unknown>[];
      return rows.map(row => ({
        memoryNamespace: row.memory_namespace as string,
        consumerKey: row.consumer_key as string,
        batchToken: row.batch_token as string,
        graphRevision: row.graph_revision as number,
        links: parseLinks(JSON.parse(row.links_json as string))
      }));
    }),
    readCompletedImpact: (scope: {readonly consumerKey: string; readonly memoryNamespace: string;
      readonly batchToken: string}): CompletedFactImpact | undefined => storage(() => {
      const consumer = text(scope.consumerKey);
      const memory = text(scope.memoryNamespace);
      const batchToken = text(scope.batchToken);
      const row = db.prepare([
        'SELECT graph_revision, handled_at, report_json FROM coordination_pending_impacts',
        'WHERE graph_namespace = ? AND memory_namespace = ? AND consumer_key = ? AND batch_token = ?'
      ].join(' ')).get(namespace, memory, consumer, batchToken) as Record<string, unknown> | undefined;
      if (!row) throw new FactProjectionError('NOT_FOUND');
      if (row.handled_at === null) return undefined;
      const report = JSON.parse(row.report_json as string) as ImpactReport;
      if (report.namespace !== namespace || report.graphRevision !== row.graph_revision
        || !Array.isArray(report.items)) throw new FactProjectionError('STORAGE_UNAVAILABLE');
      return {batchToken, report: structuredClone(report)};
    }),
    completeImpact: (request: CompleteFactImpactRequest): void => storage(() => {
      const context = {deadline: text(request.deadline), signal: request.signal};
      if (!context.signal || typeof context.signal.aborted !== 'boolean'
        || !Number.isSafeInteger(request.expectedGraphRevision) || request.expectedGraphRevision < 1
        || !request.report || typeof request.report !== 'object'
        || request.report.namespace !== namespace
        || request.report.graphRevision !== request.expectedGraphRevision
        || !Array.isArray(request.report.items)) throw new FactProjectionError('INVALID_ARGUMENT');
      const consumerKey = text(request.consumerKey);
      const memoryNamespace = text(request.memoryNamespace);
      const batchToken = text(request.batchToken);
      const reportJson = canonical(request.report);
      checkpoint(context);
      db.exec('BEGIN IMMEDIATE');
      try {
        checkpoint(context);
        const row = db.prepare([
          'SELECT graph_revision, handled_at, report_json FROM coordination_pending_impacts',
          'WHERE graph_namespace = ? AND memory_namespace = ? AND consumer_key = ? AND batch_token = ?'
        ].join(' ')).get(namespace, memoryNamespace, consumerKey,
          batchToken) as Record<string, unknown> | undefined;
        if (!row) throw new FactProjectionError('NOT_FOUND');
        if (row.graph_revision !== request.expectedGraphRevision) {
          throw new FactProjectionError('INTEGRITY_CONFLICT');
        }
        if (row.handled_at !== null) {
          if (row.report_json !== reportJson) throw new FactProjectionError('INTEGRITY_CONFLICT');
          checkpoint(context);
          db.exec('COMMIT');
          return;
        }
        db.prepare([
          'UPDATE coordination_pending_impacts SET handled_at = ?, report_json = ?',
          'WHERE graph_namespace = ? AND memory_namespace = ? AND consumer_key = ?',
          'AND batch_token = ? AND handled_at IS NULL'
        ].join(' ')).run(new Date().toISOString(), reportJson, namespace,
          memoryNamespace, consumerKey, batchToken);
        checkpoint(context);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    })
  });
}
