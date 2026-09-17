import {GraphError, parseGraph} from '@personal-agent/goals';
import type {GraphSnapshot, NodeInput, NodeVersion} from '@personal-agent/goals';
import type {AtomicCoordinationStorePort} from '@personal-agent/goals/store';
import {analyzeImpact} from './impact.js';
import {FactProjectionError} from './fact-projection.js';
import type {StoredImpact} from './persistent.js';

function identity(node: NodeVersion): string {
  return JSON.stringify([node.id, node.kind, node.revision, node.graphRevision,
    node.summary, node.sourceRef, node.validFrom, node.validUntil, node.sensitivity,
    node.state, node.reason, node.dependencies.map(ref => [ref.id, ref.revision])]);
}

function sameHistory(left: GraphSnapshot, right: GraphSnapshot): boolean {
  return left.namespace === right.namespace && left.revision === right.revision
    && left.history.every((node, index) => identity(node) === identity(right.history[index]!));
}

function integrity(): never { throw new FactProjectionError(); }

/**
 * Trusted-host graph-only commit of a previously reviewed pure projection.
 * No feed confirmation, task execution, semantic repair or write retry occurs.
 */
export function commitFactProjection(
  store: AtomicCoordinationStorePort,
  baseline: GraphSnapshot,
  projected: GraphSnapshot,
  at: string,
): StoredImpact {
  if (!store || typeof store.read !== 'function' || typeof store.appendBatch !== 'function') integrity();
  const before = parseGraph(baseline);
  const candidate = parseGraph(projected);
  // Validate the evaluation time and the complete candidate before any write.
  analyzeImpact(candidate, at);
  if (candidate.namespace !== before.namespace || candidate.revision < before.revision
    || !before.history.every((node, index) => identity(node) === identity(candidate.history[index]!))) integrity();
  const additions = candidate.history.slice(before.history.length);
  if (additions.length > 100 || additions.some(node =>
    node.kind !== 'fact' || node.reason !== 'fact projection' || node.dependencies.length !== 0)) integrity();

  const current = parseGraph(store.read());
  if (current.namespace !== before.namespace) integrity();
  if (current.revision !== before.revision) {
    throw new GraphError('REVISION_CONFLICT', 'Goal graph revision changed');
  }
  if (!sameHistory(current, before)) integrity();
  if (additions.length === 0) return {snapshot: current, report: analyzeImpact(current, at)};

  const inputs: NodeInput[] = additions.map(({revision: _revision, graphRevision: _graphRevision, ...input}) => input);
  // One atomic CAS; never fall back to a loop of individual append calls.
  const committed = parseGraph(store.appendBatch(before.revision, inputs));
  if (!sameHistory(committed, candidate)) integrity();
  return {snapshot: committed, report: analyzeImpact(committed, at)};
}
