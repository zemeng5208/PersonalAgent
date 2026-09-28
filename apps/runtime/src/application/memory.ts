import {
  FactChangeFeedError,
  parseFactChangeBatch,
  readFactForImpact
} from '@personal-agent/memory';
import type {
  ConfirmFactChangeBatchRequest,
  FactChangeBatch,
  FactChangeFeedPort,
  FactChangeReceipt,
  MemoryQueryPort,
  MemoryReadContext
} from '@personal-agent/memory';
import {analyzeImpact} from '@personal-agent/cognition';
import type {ImpactReport} from '@personal-agent/cognition';
import type {CoordinationStorePort} from '@personal-agent/goals/store';
import {FactProjectionError} from '../fact-projection-store.js';
import type {
  CompletedFactImpact,
  FactProjectionReceipt,
  FactProjectionStore
} from '../fact-projection-store.js';

export interface FactChangeConfirmationPort {
  confirm(request: ConfirmFactChangeBatchRequest): FactChangeReceipt | Promise<FactChangeReceipt>;
}

export interface MemoryProjectionApplication {
  consume(request: MemoryReadContext & {readonly limit: number}): Promise<MemoryProjectionResult>;
}

export interface MemoryProjectionResult {
  readonly batch: FactChangeBatch;
  readonly projection: FactProjectionReceipt;
  readonly providerReceipt: FactChangeReceipt;
}

export interface MemoryProjectionApplicationOptions {
  readonly consumerKey: string;
  readonly memoryNamespace: string;
  readonly feed: FactChangeFeedPort;
  readonly memory: MemoryQueryPort;
  readonly projection: FactProjectionStore;
  readonly confirmation: FactChangeConfirmationPort;
}

export interface PendingImpactApplication {
  process(request: MemoryReadContext & {readonly at: string; readonly limit: number}): readonly ImpactReport[];
  processReceipts(request: MemoryReadContext & {readonly at: string; readonly limit: number}): readonly CompletedFactImpact[];
}

export interface PendingImpactApplicationOptions {
  readonly coordination: CoordinationStorePort;
  readonly projection: FactProjectionStore;
  readonly scope?: {readonly consumerKey: string; readonly memoryNamespace: string};
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) {
    throw new FactProjectionError('INVALID_ARGUMENT');
  }
  return value;
}

function active(context: MemoryReadContext): void {
  if (!context.signal || typeof context.signal.aborted !== 'boolean') {
    throw new FactProjectionError('INVALID_ARGUMENT');
  }
  if (context.signal.aborted) throw new FactProjectionError('CANCELLED');
  if (typeof context.deadline !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(context.deadline)) {
    throw new FactProjectionError('INVALID_ARGUMENT');
  }
  const deadline = Date.parse(context.deadline);
  if (!Number.isFinite(deadline) || new Date(deadline).toISOString() !== context.deadline) {
    throw new FactProjectionError('INVALID_ARGUMENT');
  }
  if (Date.now() >= deadline) throw new FactProjectionError('TIMEOUT');
}

export function createMemoryProjectionApplication(
  options: MemoryProjectionApplicationOptions
): MemoryProjectionApplication {
  const consumerKey = text(options.consumerKey);
  const memoryNamespace = text(options.memoryNamespace);
  return Object.freeze({
    consume: async (request: MemoryReadContext & {readonly limit: number}): Promise<MemoryProjectionResult> => {
      active(request);
      if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100) {
        throw new FactProjectionError('INVALID_ARGUMENT');
      }
      let staged = options.projection.readStaged(consumerKey, memoryNamespace);
      if (!staged) {
        const batch = parseFactChangeBatch(await options.feed.read(request));
        const facts = [];
        for (const entry of batch.entries) {
          facts.push(await readFactForImpact(options.memory, entry.fact, request));
        }
        options.projection.stage({
          consumerKey, memoryNamespace, batch, facts, deadline: request.deadline, signal: request.signal
        });
        staged = {consumerKey, memoryNamespace, batch, facts};
      }
      const {batch, facts} = staged;
      let providerReceipt: FactChangeReceipt;
      try {
        providerReceipt = await options.confirmation.confirm({
          batchToken: batch.batchToken,
          expectedCheckpoint: batch.baseCheckpoint,
          handled: batch.entries,
          deadline: request.deadline,
          signal: request.signal
        });
      } catch (error) {
        if (error instanceof FactChangeFeedError
          && ['REBUILD_REQUIRED', 'SCOPE_DENIED', 'REVISION_CONFLICT'].includes(error.code)) {
          options.projection.discardStaged(consumerKey, memoryNamespace, batch.batchToken);
        }
        throw error;
      }
      if (providerReceipt.batchToken !== batch.batchToken) {
        throw new FactChangeFeedError('REVISION_CONFLICT');
      }
      text(providerReceipt.checkpoint);
      const projection = options.projection.project({
        consumerKey, memoryNamespace, batch, facts, deadline: request.deadline, signal: request.signal
      }, providerReceipt);
      return {batch, projection, providerReceipt};
    }
  });
}

export function createPendingImpactApplication(
  options: PendingImpactApplicationOptions
): PendingImpactApplication {
  const scope = options.scope === undefined ? undefined : {
    consumerKey: text(options.scope.consumerKey), memoryNamespace: text(options.scope.memoryNamespace),
  };
  const processReceipts = (request: MemoryReadContext & {readonly at: string; readonly limit: number}): readonly CompletedFactImpact[] => {
    active(request);
    const pending = options.projection.readPending(request.limit, scope);
    const receipts: CompletedFactImpact[] = [];
    for (const item of pending) {
      active(request);
      const report = analyzeImpact(options.coordination.read(item.graphRevision), request.at);
      options.projection.completeImpact({
        consumerKey: item.consumerKey,
        memoryNamespace: item.memoryNamespace,
        batchToken: item.batchToken,
        expectedGraphRevision: item.graphRevision,
        report,
        deadline: request.deadline,
        signal: request.signal
      });
      receipts.push({batchToken: item.batchToken, report});
    }
    return receipts;
  };
  return Object.freeze({
    process: (request: MemoryReadContext & {readonly at: string; readonly limit: number}): readonly ImpactReport[] =>
      processReceipts(request).map(item => item.report),
    processReceipts,
  });
}
