import {appendVersion, currentNodes, GraphError, parseGraph} from './index.js';
import type {NodeInput, NodeVersion} from './index.js';
import type {CoordinationStorePort} from './store.js';

/** Provisional host-side commands. The host binds the store and authorizes the user. */
export type GoalInput = Omit<NodeInput, 'kind'>;
export interface GoalResult { graphRevision: number; goal: NodeVersion; }
export interface GoalList { graphRevision: number; goals: NodeVersion[]; }
const goalKeys = ['id', 'summary', 'sourceRef', 'validFrom', 'validUntil',
  'sensitivity', 'state', 'reason', 'dependencies'];

/** Includes withdrawn goals so callers can show the complete current state. */
export function listGoals(store: CoordinationStorePort, revision?: number): GoalList {
  const snapshot = parseGraph(store.read(revision));
  return {graphRevision: snapshot.revision,
    goals: currentNodes(snapshot).filter(node => node.kind === 'goal')};
}

function candidate(store: CoordinationStorePort, expectedGraphRevision: number, input: GoalInput) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).length !== goalKeys.length
    || goalKeys.some(key => !Object.hasOwn(input, key))) {
    throw new GraphError('INVALID_ARGUMENT', 'Invalid goal input');
  }
  const snapshot = parseGraph(store.read());
  // The pure preflight checks the complete input and the graph revision. The
  // bound store still owns the commit-time CAS against a concurrent writer.
  appendVersion(snapshot, expectedGraphRevision, {...input, kind: 'goal'});
  return snapshot;
}

function receipt(store: CoordinationStorePort, expectedGraphRevision: number, input: GoalInput): GoalResult {
  const committed = parseGraph(store.append(expectedGraphRevision, {...input, kind: 'goal'}));
  const goal = committed.history.at(-1)!;
  return {graphRevision: committed.revision, goal};
}

/** New IDs only; a withdrawn ID remains reserved by its history. */
export function createGoal(store: CoordinationStorePort, expectedGraphRevision: number, input: GoalInput): GoalResult {
  const snapshot = candidate(store, expectedGraphRevision, input);
  if (snapshot.history.some(node => node.id === input.id)) {
    throw new GraphError('REVISION_CONFLICT', 'Goal ID already exists');
  }
  return receipt(store, expectedGraphRevision, input);
}

/** Explicit full replacement, including source and reason, against two exact revisions. */
export function reviseGoal(
  store: CoordinationStorePort, expectedGraphRevision: number,
  expectedGoalRevision: number, input: GoalInput
): GoalResult {
  const snapshot = candidate(store, expectedGraphRevision, input);
  const current = snapshot.history.findLast(node => node.id === input.id);
  if (!current || current.kind !== 'goal') throw new GraphError('INVALID_ARGUMENT', 'Goal does not exist');
  if (!Number.isSafeInteger(expectedGoalRevision) || expectedGoalRevision < 1) {
    throw new GraphError('INVALID_ARGUMENT', 'Invalid goal revision');
  }
  if (current.revision !== expectedGoalRevision) {
    throw new GraphError('REVISION_CONFLICT', 'Goal revision changed');
  }
  return receipt(store, expectedGraphRevision, input);
}
