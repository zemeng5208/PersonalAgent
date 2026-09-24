import {appendVersion, createGraph, graphAt, GraphError, parseGraph} from './index.js';
import type {GraphSnapshot, NodeInput} from './index.js';

/** Trusted hosts bind the namespace; consumers cannot select another. */
export interface CoordinationStorePort {
  read(revision?: number): GraphSnapshot;
  append(expectedRevision: number, input: NodeInput): GraphSnapshot;
}
/** Additive provisional extension. One CAS protects the entire ordered batch. */
export interface AtomicCoordinationStorePort extends CoordinationStorePort {
  appendBatch(expectedRevision: number, inputs: readonly NodeInput[]): GraphSnapshot;
}

/** Pure preflight; neither the source snapshot nor any durable store is changed. */
export function appendVersions(
  snapshot: GraphSnapshot, expectedRevision: number, inputs: readonly NodeInput[]
): GraphSnapshot {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0
    || !Array.isArray(inputs) || inputs.length === 0) {
    throw new GraphError('INVALID_ARGUMENT', 'Invalid graph batch');
  }
  let next = parseGraph(snapshot);
  if (next.revision !== expectedRevision) {
    throw new GraphError('REVISION_CONFLICT', 'Goal graph revision changed');
  }
  for (const input of inputs) next = appendVersion(next, next.revision, input);
  return next;
}
export class CoordinationStoreError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'STORAGE_UNAVAILABLE') {
    super(code === 'NOT_FOUND' ? 'Goal graph not provisioned' : 'Goal graph storage unavailable');
    this.name = 'CoordinationStoreError';
  }
}
/** In-memory only. Share this host between consumers to exercise revision conflicts. */
export class FakeCoordinationStoreHost {
  private readonly graphs = new Map<string, GraphSnapshot>();
  provision(namespace: string): AtomicCoordinationStorePort {
    const initial = createGraph(namespace);
    if (!this.graphs.has(namespace)) this.graphs.set(namespace, initial);
    return this.bind(namespace);
  }
  bind(namespace: string): AtomicCoordinationStorePort {
    createGraph(namespace);
    const read = (): GraphSnapshot => {
      const graph = this.graphs.get(namespace);
      if (!graph) throw new CoordinationStoreError('NOT_FOUND');
      return graph;
    };
    return Object.freeze({
      read: (revision?: number) => {
        const graph = read();
        return graphAt(graph, revision === undefined ? graph.revision : revision);
      },
      append: (expectedRevision: number, input: NodeInput) => {
        const next = appendVersion(read(), expectedRevision, input);
        this.graphs.set(namespace, next);
        return structuredClone(next);
      },
      appendBatch: (expectedRevision: number, inputs: readonly NodeInput[]) => {
        const next = appendVersions(read(), expectedRevision, inputs);
        this.graphs.set(namespace, next);
        return structuredClone(next);
      }
    });
  }
}
