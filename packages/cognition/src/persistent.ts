import {currentNodes, GraphError} from '@personal-agent/goals';
import type {GraphSnapshot, NodeInput, NodeRef} from '@personal-agent/goals';
import type {CoordinationStorePort} from '@personal-agent/goals/store';
import {analyzeImpact, CognitionError, proposePlanRevision} from './impact.js';
import type {ImpactReport, PlanRevisionProposal} from './impact.js';

const requestKeys = ['expectedGraphRevision', 'plan', 'summary', 'reason', 'dependencies'] as const;
const nodeRefKeys = ['id', 'revision'] as const;

export interface StoredImpact {
  snapshot: GraphSnapshot;
  report: ImpactReport;
}

export interface StoredPlanRevisionRequest {
  expectedGraphRevision: number;
  plan: NodeRef;
  summary: string;
  reason: string;
  dependencies: NodeRef[];
}

export interface AppliedPlanRevision {
  kind: 'applied';
  proposal: PlanRevisionProposal;
  snapshot: GraphSnapshot;
  report: ImpactReport;
}

export interface ConflictedPlanRevision {
  kind: 'conflict';
  expectedGraphRevision: number;
  currentGraphRevision: number;
  snapshot: GraphSnapshot;
  report: ImpactReport;
}

export type StoredPlanRevisionResult = AppliedPlanRevision | ConflictedPlanRevision;

function conflict(snapshot: GraphSnapshot, at: string, expectedGraphRevision: number): ConflictedPlanRevision {
  const isolated = structuredClone(snapshot);
  return {kind: 'conflict', expectedGraphRevision, currentGraphRevision: isolated.revision,
    snapshot: isolated, report: analyzeImpact(isolated, at)};
}

function isRevisionConflict(error: unknown): error is CognitionError | GraphError {
  return (error instanceof CognitionError || error instanceof GraphError)
    && error.code === 'REVISION_CONFLICT';
}

function invalid(): never {
  throw new CognitionError('INVALID_ARGUMENT');
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key))) return invalid();
  return value as Record<string, unknown>;
}

function validateNodeRef(value: unknown): asserts value is NodeRef {
  const ref = exactObject(value, nodeRefKeys);
  if (typeof ref.id !== 'string' || !ref.id.trim()
    || typeof ref.revision !== 'number' || !Number.isSafeInteger(ref.revision) || ref.revision < 1) return invalid();
}

function validateRequest(request: unknown): asserts request is StoredPlanRevisionRequest {
  const input = exactObject(request, requestKeys);
  if (typeof input.expectedGraphRevision !== 'number'
    || !Number.isSafeInteger(input.expectedGraphRevision) || input.expectedGraphRevision < 0
    || typeof input.summary !== 'string' || !input.summary.trim()
    || typeof input.reason !== 'string' || !input.reason.trim()
    || !Array.isArray(input.dependencies)) return invalid();

  // Validate the plan shape before reading plan.id while checking dependencies.
  validateNodeRef(input.plan);
  const plan = input.plan;
  const dependencyIds = new Set<string>();
  for (const dependency of input.dependencies) {
    validateNodeRef(dependency);
    if (dependency.id === plan.id || dependencyIds.has(dependency.id)) return invalid();
    dependencyIds.add(dependency.id);
  }
}

/** Read a host-bound store and analyze exactly the returned durable snapshot. */
export function analyzeStoredImpact(store: CoordinationStorePort, at: string): StoredImpact {
  const snapshot = structuredClone(store.read());
  return {snapshot, report: analyzeImpact(snapshot, at)};
}

/**
 * Apply one explicit Plan revision. A conflict returns a fresh analysis and never
 * retries the write; the caller must review and submit a new request.
 */
export function commitStoredPlanRevision(
  store: CoordinationStorePort,
  at: string,
  request: StoredPlanRevisionRequest
): StoredPlanRevisionResult {
  validateRequest(request);
  let snapshot = structuredClone(store.read());
  let proposal: PlanRevisionProposal;
  try {
    proposal = proposePlanRevision(snapshot, at, {expectedGraphRevision: request.expectedGraphRevision,
      plan: request.plan, summary: request.summary, reason: request.reason});
  } catch (error) {
    if (isRevisionConflict(error)) {
      // A stale plan version is not a graph CAS conflict. Keep the same error
      // semantics as proposePlanRevision instead of returning equal revisions
      // that falsely suggest the graph changed.
      if (snapshot.revision === request.expectedGraphRevision) throw error;
      return conflict(store.read(), at, request.expectedGraphRevision);
    }
    throw error;
  }
  const plan = currentNodes(snapshot).find(node => node.id === proposal.plan.id)!;
  const {revision: _revision, graphRevision: _graphRevision, ...planInput} = plan;
  const input: NodeInput = {...planInput, summary: proposal.changes[0]!.after,
    reason: proposal.reason, dependencies: structuredClone(request.dependencies)};
  try {
    snapshot = structuredClone(store.append(request.expectedGraphRevision, input));
  } catch (error) {
    if (!isRevisionConflict(error)) throw error;
    return conflict(store.read(), at, request.expectedGraphRevision);
  }
  return {kind: 'applied', proposal: structuredClone(proposal), snapshot, report: analyzeImpact(snapshot, at)};
}
