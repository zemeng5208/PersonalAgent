import {GraphError, parseGraph} from '@personal-agent/goals';
import type {GraphSnapshot} from '@personal-agent/goals';

/** Remove all versions of a node and every node that ever depended on it. */
export function eraseDependentGraphHistory(snapshot: GraphSnapshot, targetId: string): GraphSnapshot {
  const graph = parseGraph(snapshot);
  if (typeof targetId !== 'string' || !targetId.trim()) {
    throw new GraphError('INVALID_ARGUMENT', 'Invalid target node');
  }
  const removed = new Set([targetId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of graph.history) {
      if (!removed.has(node.id) && node.dependencies.some(ref => removed.has(ref.id))) {
        removed.add(node.id);
        changed = true;
      }
    }
  }
  const history = graph.history.filter(node => !removed.has(node.id))
    .map((node, index) => ({...node, graphRevision: index + 1}));
  return parseGraph({namespace: graph.namespace, revision: history.length, history});
}
