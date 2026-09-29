import type {DatabaseSync} from 'node:sqlite';
import {appendVersion, createGraph, graphAt, GraphError, parseGraph} from '@personal-agent/goals';
import type {GraphSnapshot, NodeInput} from '@personal-agent/goals';
import {appendVersions, CoordinationStoreError} from '@personal-agent/goals/store';
import type {AtomicCoordinationStorePort} from '@personal-agent/goals/store';

function storage<T>(work: () => T): T {
  try { return work(); } catch (error) {
    if (error instanceof GraphError || error instanceof CoordinationStoreError) throw error;
    throw new CoordinationStoreError('STORAGE_UNAVAILABLE');
  }
}

// Internal adapter; the trusted Runtime host owns database and namespace binding.
export function bindCoordinationStore(db: DatabaseSync, namespace: string, provision: boolean): AtomicCoordinationStorePort {
  const initial = createGraph(namespace);
  if (provision) storage(() => db.prepare(
    'INSERT OR IGNORE INTO coordination_graphs (namespace, snapshot_json) VALUES (?, ?)'
  ).run(namespace, JSON.stringify(initial)));
  const load = (): GraphSnapshot => {
    const row = db.prepare('SELECT snapshot_json FROM coordination_graphs WHERE namespace = ?').get(namespace);
    if (!row) throw new CoordinationStoreError('NOT_FOUND');
    try {
      const graph = parseGraph(JSON.parse(row.snapshot_json as string));
      if (graph.namespace !== namespace) throw new Error();
      return graph;
    } catch { throw new CoordinationStoreError('STORAGE_UNAVAILABLE'); }
  };
  const appendTransaction = (build: (snapshot: GraphSnapshot) => GraphSnapshot): GraphSnapshot => storage(() => {
    db.exec('BEGIN IMMEDIATE');
    try {
      // Lock covers both revision comparison and the single durable update.
      const next = build(load());
      db.prepare('UPDATE coordination_graphs SET snapshot_json = ? WHERE namespace = ?')
        .run(JSON.stringify(next), namespace);
      db.exec('COMMIT');
      return next;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  });
  return Object.freeze({
    read: (revision?: number) => storage(() => {
      const graph = load();
      return graphAt(graph, revision === undefined ? graph.revision : revision);
    }),
    append: (expectedRevision: number, input: NodeInput) =>
      appendTransaction(snapshot => appendVersion(snapshot, expectedRevision, input)),
    appendBatch: (expectedRevision: number, inputs: readonly NodeInput[]) =>
      appendTransaction(snapshot => appendVersions(snapshot, expectedRevision, inputs))
  });
}
