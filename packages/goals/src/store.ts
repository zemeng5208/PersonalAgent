import {appendVersion, createGraph, graphAt} from './index.js';
import type {GraphSnapshot, NodeInput} from './index.js';

/** Trusted hosts bind the namespace; consumers cannot select another. */
export interface CoordinationStorePort {
  read(revision?: number): GraphSnapshot;
  append(expectedRevision: number, input: NodeInput): GraphSnapshot;
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
  provision(namespace: string): CoordinationStorePort {
    const initial = createGraph(namespace);
    if (!this.graphs.has(namespace)) this.graphs.set(namespace, initial);
    return this.bind(namespace);
  }
  bind(namespace: string): CoordinationStorePort {
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
      }
    });
  }
}
