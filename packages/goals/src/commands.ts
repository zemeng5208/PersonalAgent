import {appendVersion, currentNodes, GraphError, parseGraph} from './index.js';
import type {NodeInput, NodeRef, NodeVersion} from './index.js';
import type {CoordinationStorePort} from './store.js';

/** Provisional host-side commands. The host binds the store and authorizes the user. */
export type GoalInput = Omit<NodeInput, 'kind'>;
/** Exact old/new refs for an impact consumer; no independent event stream. */
export interface GoalResult<TPrevious extends NodeRef | null = NodeRef | null> {
  graphRevision: number;
  previous: TPrevious;
  goal: NodeVersion;
}
export interface GoalList { graphRevision: number; goals: NodeVersion[]; }
export interface GoalRead { graphRevision: number; goal: NodeVersion | null; }
const goalKeys = ['id', 'summary', 'sourceRef', 'validFrom', 'validUntil',
  'sensitivity', 'state', 'reason', 'dependencies'];

/** Includes withdrawn goals so callers can show the complete current state. */
export function listGoals(store: CoordinationStorePort, revision?: number): GoalList {
  const snapshot = parseGraph(store.read(revision));
  return {graphRevision: snapshot.revision,
    goals: currentNodes(snapshot).filter(node => node.kind === 'goal')};
}

/** Read one goal without returning unrelated graph nodes to the caller. */
export function getGoal(store: CoordinationStorePort, id: string, revision?: number): GoalRead {
  if (typeof id !== 'string' || !id.trim()) {
    throw new GraphError('INVALID_ARGUMENT', 'Invalid goal ID');
  }
  const list = listGoals(store, revision);
  return {graphRevision: list.graphRevision, goal: list.goals.find(goal => goal.id === id) ?? null};
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

function receipt<TPrevious extends NodeRef | null>(
  store: CoordinationStorePort, expectedGraphRevision: number,
  previous: TPrevious, input: GoalInput
): GoalResult<TPrevious> {
  const committed = parseGraph(store.append(expectedGraphRevision, {...input, kind: 'goal'}));
  const goal = committed.history.at(-1);
  if (!goal || goal.kind !== 'goal' || goal.id !== input.id
    || committed.revision !== expectedGraphRevision + 1
    || goal.revision !== (previous?.revision ?? 0) + 1) {
    throw new GraphError('INVALID_ARGUMENT', 'Goal store returned an invalid commit');
  }
  return {graphRevision: committed.revision, previous, goal};
}

/** New IDs only; a withdrawn ID remains reserved by its history. */
export function createGoal(store: CoordinationStorePort, expectedGraphRevision: number, input: GoalInput): GoalResult<null> {
  const snapshot = candidate(store, expectedGraphRevision, input);
  if (snapshot.history.some(node => node.id === input.id)) {
    throw new GraphError('REVISION_CONFLICT', 'Goal ID already exists');
  }
  return receipt(store, expectedGraphRevision, null, input);
}

/** Explicit full replacement, including source and reason, against two exact revisions. */
export function reviseGoal(
  store: CoordinationStorePort, expectedGraphRevision: number,
  expectedGoalRevision: number, input: GoalInput
): GoalResult<NodeRef> {
  const snapshot = candidate(store, expectedGraphRevision, input);
  const current = snapshot.history.findLast(node => node.id === input.id);
  if (!current || current.kind !== 'goal') throw new GraphError('INVALID_ARGUMENT', 'Goal does not exist');
  if (!Number.isSafeInteger(expectedGoalRevision) || expectedGoalRevision < 1) {
    throw new GraphError('INVALID_ARGUMENT', 'Invalid goal revision');
  }
  if (current.revision !== expectedGoalRevision) {
    throw new GraphError('REVISION_CONFLICT', 'Goal revision changed');
  }
  return receipt(store, expectedGraphRevision, {id: current.id, revision: current.revision}, input);
}
