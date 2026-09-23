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
}

export interface PendingImpactApplicationOptions {
  readonly coordination: CoordinationStorePort;
  readonly projection: FactProjectionStore;
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
      if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100) {
        throw new FactProjectionError('INVALID_ARGUMENT');
      }
      const batch = parseFactChangeBatch(await options.feed.read(request));
      const facts = [];
      for (const entry of batch.entries) {
        facts.push(await readFactForImpact(options.memory, entry.fact, request));
      }
      const projection = options.projection.project({
        consumerKey,
        memoryNamespace,
        batch,
        facts,
        deadline: request.deadline,
        signal: request.signal
      });
      const providerReceipt = await options.confirmation.confirm({
        batchToken: batch.batchToken,
        expectedCheckpoint: batch.baseCheckpoint,
        handled: batch.entries,
        deadline: request.deadline,
        signal: request.signal
      });
      if (providerReceipt.batchToken !== batch.batchToken) {
        throw new FactChangeFeedError('REVISION_CONFLICT');
      }
      text(providerReceipt.checkpoint);
      return {batch, projection, providerReceipt};
    }
  });
}

export function createPendingImpactApplication(
  options: PendingImpactApplicationOptions
): PendingImpactApplication {
  return Object.freeze({
    process: (request: MemoryReadContext & {readonly at: string; readonly limit: number}): readonly ImpactReport[] => {
      active(request);
      const pending = options.projection.readPending(request.limit);
      const reports: ImpactReport[] = [];
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
        reports.push(report);
      }
      return reports;
    }
  });
}
