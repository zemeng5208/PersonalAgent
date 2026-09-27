import type {MemoryReadContext} from '@personal-agent/memory';
import type {SqliteMemoryHost} from '@personal-agent/memory/sqlite';
import type {TaskRuntime} from '../index.js';
import {FactProjectionError} from '../fact-projection-store.js';
import type {CompletedFactImpact, FactImpactReceipt} from '../fact-projection-store.js';
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
    confirmation: {confirm: request => memory.confirmFeedBatch(memoryNamespace, consumerKey, request)},
  });
  const impacts = createPendingImpactApplication({
    coordination: runtime.bindCoordinationStore(graphNamespace), projection,
    scope: {consumerKey, memoryNamespace},
  });
  return Object.freeze({
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
