import type {MemoryReadContext} from '@personal-agent/memory';
import type {SqliteMemoryHost} from '@personal-agent/memory/sqlite';
import type {TaskRuntime} from '../index.js';
import {FactProjectionError} from '../fact-projection-store.js';
import type {CompletedFactImpact, FactErasurePreflight, FactImpactReceipt} from '../fact-projection-store.js';
import {createMemoryProjectionApplication, createPendingImpactApplication} from './memory.js';
import type {MemoryProjectionResult} from './memory.js';

export interface SqliteFactProjectionHostOptions {
  /** Trusted host-owned stores; each retains its own migration and database file. */
  readonly memory: SqliteMemoryHost;
  readonly runtime: TaskRuntime;
  readonly memoryNamespace: string;
  readonly graphNamespace: string;
  readonly consumerKey: string;
}

export interface SqliteFactProjectionHost {
  /** Trusted, graph-scoped read only evidence after Memory has staged the erasure. */
  preflightErasure(factId: string, request: MemoryReadContext): Promise<FactErasurePreflight>;
  /** Host-only recovery after an authorized Memory erasure intent; no user completion claim. */
  resumeFactErasure(request: MemoryReadContext & {readonly factId: string;
    readonly expectedRevision: number; readonly operationId: string;
    readonly expectedGraphRevision: number}): Promise<void>;
  /** One durable feed batch. The provider receipt and graph projection are restart-safe. */
  consume(request: MemoryReadContext & {readonly limit: number}): Promise<MemoryProjectionResult>;
  /** Bounded catch-up for a trusted source trigger or startup recovery. */
  drain(request: MemoryReadContext & {readonly limit: number; readonly maxBatches: number}): Promise<{
    readonly batches: number;
    readonly atWatermark: boolean;
  }>;
  /** Analysis remains a separate local phase; it never grants write or cloud access. */
  processImpacts(request: MemoryReadContext & {readonly at: string; readonly limit: number}): readonly CompletedFactImpact[];
  /** Exact durable receipt for a batch this consumer owns; undefined while pending. */
  readCompletedImpact(batchToken: string): CompletedFactImpact | undefined;
  /** Stable scoped cursor for recovery after project or complete commits before returning. */
  listImpactReceipts(request: {readonly afterGraphRevision: number; readonly limit: number}): readonly FactImpactReceipt[];
}

/**
 * Bind the existing SQLite feed, exact public query, durable projection and
 * host-only confirmation to one fixed namespace and consumer. Call only from
 * the trusted Competition composition after choosing the source and scope.
 */
export function createSqliteFactProjectionHost(options: SqliteFactProjectionHostOptions): SqliteFactProjectionHost {
  const {memory, runtime, memoryNamespace, graphNamespace, consumerKey} = options;
  if (!memoryNamespace?.trim() || !graphNamespace?.trim() || !consumerKey?.trim()) {
    throw new FactProjectionError('INVALID_ARGUMENT');
  }
  const feed = memory.bindFeed(memoryNamespace, {consumerId: consumerKey, allowedSensitivities: ['public']});
  const query = memory.bind(memoryNamespace, {allowedSensitivities: ['public']});
  const projection = runtime.provisionFactProjectionStore(graphNamespace);
  const app = createMemoryProjectionApplication({
    consumerKey,
    memoryNamespace,
    feed,
    memory: query,
    projection,
    confirmation: {
      confirm: request => memory.confirmFeedBatch(memoryNamespace, consumerKey, request),
      readBatch: request => memory.readFeedDelivery(memoryNamespace, consumerKey, request),
    },
  });
  const impacts = createPendingImpactApplication({
    coordination: runtime.bindCoordinationStore(graphNamespace), projection,
    scope: {consumerKey, memoryNamespace},
  });
  return Object.freeze({
    preflightErasure: (factId: string, request: MemoryReadContext) => projection.preflightErasure({
      memoryNamespace, factId, ...request,
      readDelivery: (consumer, batchToken, context) => {
        if (consumer !== consumerKey) throw new FactProjectionError('INTEGRITY_CONFLICT');
        return memory.readFeedDelivery(memoryNamespace, consumer, {batchToken, ...context});
      },
      readVersion: (fact, context) => query.getVersion({fact, ...context}),
    }),
    resumeFactErasure: async (request: MemoryReadContext & {readonly factId: string;
      readonly expectedRevision: number; readonly operationId: string;
      readonly expectedGraphRevision: number}) => {
      await projection.commitErasure({memoryNamespace, factId: request.factId,
        operationId: request.operationId, expectedGraphRevision: request.expectedGraphRevision,
        deadline: request.deadline, signal: request.signal,
        readDelivery: (consumer, batchToken, context) => {
          if (consumer !== consumerKey) throw new FactProjectionError('INTEGRITY_CONFLICT');
          return memory.readFeedDelivery(memoryNamespace, consumer, {batchToken, ...context});
        },
        readVersion: (fact, context) => query.getVersion({fact, ...context}),
      });
      const receipt = projection.readErasureReceipt(memoryNamespace, request.factId);
      if (!receipt || receipt.operationId !== request.operationId
        || receipt.expectedGraphRevision !== request.expectedGraphRevision) {
        throw new FactProjectionError('INTEGRITY_CONFLICT');
      }
      memory.completeFactErasure(memoryNamespace, {factId: request.factId,
        expectedRevision: request.expectedRevision, operationId: request.operationId,
        runtimeReceipt: receipt, deadline: request.deadline, signal: request.signal});
    },
    consume: (request: MemoryReadContext & {readonly limit: number}) => app.consume(request),
    drain: async (request: MemoryReadContext & {readonly limit: number; readonly maxBatches: number}) => {
      if (!Number.isSafeInteger(request.maxBatches) || request.maxBatches < 1 || request.maxBatches > 100) {
        throw new FactProjectionError('INVALID_ARGUMENT');
      }
      for (let batches = 1; batches <= request.maxBatches; batches++) {
        const result = await app.consume({limit: request.limit, deadline: request.deadline, signal: request.signal});
        if (result.batch.atWatermark) return {batches, atWatermark: true};
      }
      return {batches: request.maxBatches, atWatermark: false};
    },
    processImpacts: (request: MemoryReadContext & {readonly at: string; readonly limit: number}) =>
      impacts.processReceipts(request),
    readCompletedImpact: (batchToken: string) => projection.readCompletedImpact({
      consumerKey, memoryNamespace, batchToken,
    }),
    listImpactReceipts: (request: {readonly afterGraphRevision: number; readonly limit: number}) =>
      projection.listImpactReceipts({consumerKey, memoryNamespace, ...request}),
  });
}
