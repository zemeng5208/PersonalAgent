import type {DatabaseSync} from 'node:sqlite';
import {appendVersion, createGraph, graphAt, GraphError, parseGraph} from '@personal-agent/goals';
import type {GraphSnapshot, NodeInput} from '@personal-agent/goals';
import {CoordinationStoreError} from '@personal-agent/goals/store';
import type {CoordinationStorePort} from '@personal-agent/goals/store';

function storage<T>(work: () => T): T {
  try { return work(); } catch (error) {
    if (error instanceof GraphError || error instanceof CoordinationStoreError) throw error;
    throw new CoordinationStoreError('STORAGE_UNAVAILABLE');
  }
}

// Internal adapter; the trusted Runtime host owns database and namespace binding.
export function bindCoordinationStore(db: DatabaseSync, namespace: string, provision: boolean): CoordinationStorePort {
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
  return Object.freeze({
    read: (revision?: number) => storage(() => {
      const graph = load();
      return graphAt(graph, revision === undefined ? graph.revision : revision);
    }),
    append: (expectedRevision: number, input: NodeInput) => storage(() => {
      db.exec('BEGIN IMMEDIATE');
      try {
        // Lock covers both revision comparison and the durable update.
        const next = appendVersion(load(), expectedRevision, input);
        db.prepare('UPDATE coordination_graphs SET snapshot_json = ? WHERE namespace = ?')
          .run(JSON.stringify(next), namespace);
        db.exec('COMMIT');
        return next;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    })
  });
}
