import {currentNodes, GraphError} from '@personal-agent/goals';
import type {GraphSnapshot, NodeInput, NodeRef} from '@personal-agent/goals';
import {appendVersions} from '@personal-agent/goals/store';
import type {AtomicCoordinationStorePort, CoordinationStorePort} from '@personal-agent/goals/store';
import {analyzeImpact, CognitionError} from './impact.js';
import type {ImpactReport} from './impact.js';
import type {StoredImpact} from './persistent.js';

const requestKeys = ['expectedGraphRevision', 'changes'] as const;
const changeKeys = ['node', 'summary', 'reason', 'dependencies'] as const;
const nodeRefKeys = ['id', 'revision'] as const;

export interface StoredRepairChange {
  node: NodeRef;
  summary: string;
  reason: string;
  dependencies: NodeRef[];
}

export interface StoredRepairRequest {
  expectedGraphRevision: number;
  changes: StoredRepairChange[];
}

export interface StoredRepairPreview {
  before: StoredImpact;
  inputs: NodeInput[];
  after: StoredImpact;
}

export interface AppliedStoredRepair {
  kind: 'applied';
  preview: StoredRepairPreview;
  snapshot: GraphSnapshot;
  report: ImpactReport;
}

export interface ConflictedStoredRepair {
  kind: 'conflict';
  expectedGraphRevision: number;
  currentGraphRevision: number;
  snapshot: GraphSnapshot;
  report: ImpactReport;
}

export type StoredRepairResult = AppliedStoredRepair | ConflictedStoredRepair;

function invalid(): never {
  throw new CognitionError('INVALID_ARGUMENT');
}

function notApplicable(): never {
  throw new CognitionError('NOT_APPLICABLE');
}

function revisionConflict(): never {
  throw new CognitionError('REVISION_CONFLICT');
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Reflect.ownKeys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key))) return invalid();
  return value as Record<string, unknown>;
}

function validateNodeRef(value: unknown): asserts value is NodeRef {
  const ref = exactObject(value, nodeRefKeys);
  if (typeof ref.id !== 'string' || !ref.id.trim()
    || typeof ref.revision !== 'number' || !Number.isSafeInteger(ref.revision) || ref.revision < 1) {
    return invalid();
  }
}

function validateDependencies(value: unknown, nodeId: string): asserts value is NodeRef[] {
  if (!Array.isArray(value)) return invalid();
  const seen = new Set<string>();
  for (const dependency of value) {
    validateNodeRef(dependency);
    if (dependency.id === nodeId || seen.has(dependency.id)) return invalid();
    seen.add(dependency.id);
  }
}

function validateRequest(request: unknown): asserts request is StoredRepairRequest {
  const input = exactObject(request, requestKeys);
  if (typeof input.expectedGraphRevision !== 'number'
    || !Number.isSafeInteger(input.expectedGraphRevision) || input.expectedGraphRevision < 0
    || !Array.isArray(input.changes) || input.changes.length === 0) return invalid();

  const targets = new Set<string>();
  for (const rawChange of input.changes) {
    const change = exactObject(rawChange, changeKeys);
    validateNodeRef(change.node);
    const node = change.node;
    if (typeof change.summary !== 'string' || !change.summary.trim()
      || typeof change.reason !== 'string' || !change.reason.trim()) return invalid();
    validateDependencies(change.dependencies, node.id);
    if (targets.has(node.id)) return invalid();
    targets.add(node.id);
  }
}

function validateAt(at: unknown): asserts at is string {
  if (typeof at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(at)) {
    return invalid();
  }
  const parsed = Date.parse(at);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== at) return invalid();
}

function requireReadableStore(store: unknown): asserts store is CoordinationStorePort {
  if (!store || typeof store !== 'object'
    || typeof (store as {read?: unknown}).read !== 'function') return notApplicable();
}

function requireAtomicStore(store: unknown): asserts store is AtomicCoordinationStorePort {
  if (!store || typeof store !== 'object'
    || typeof (store as {read?: unknown}).read !== 'function'
    || typeof (store as {appendBatch?: unknown}).appendBatch !== 'function') return notApplicable();
}

function sameDependencies(left: readonly NodeRef[], right: readonly NodeRef[]): boolean {
  return left.length === right.length
    && left.every((ref, index) => ref.id === right[index]!.id && ref.revision === right[index]!.revision);
}

function isolatedImpact(snapshot: GraphSnapshot, at: string): StoredImpact {
  const isolated = structuredClone(snapshot);
  const report = analyzeImpact(isolated, at);
  return {snapshot: structuredClone(isolated), report: structuredClone(report)};
}

function isolatedPreview(preview: StoredRepairPreview): StoredRepairPreview {
  return structuredClone(preview);
}

function isRevisionConflict(error: unknown): boolean {
  return (error instanceof CognitionError || error instanceof GraphError)
    && error.code === 'REVISION_CONFLICT';
}

function freshConflict(
  store: CoordinationStorePort,
  at: string,
  expectedGraphRevision: number
): ConflictedStoredRepair {
  const snapshot = structuredClone(store.read());
  const report = analyzeImpact(snapshot, at);
  return {
    kind: 'conflict',
    expectedGraphRevision,
    currentGraphRevision: snapshot.revision,
    snapshot: structuredClone(snapshot),
    report: structuredClone(report)
  };
}

function buildPreview(
  snapshot: GraphSnapshot,
  at: string,
  request: StoredRepairRequest
): StoredRepairPreview {
  const before = isolatedImpact(snapshot, at);
  if (before.snapshot.revision !== request.expectedGraphRevision) return revisionConflict();

  const nodes = new Map(currentNodes(before.snapshot).map(node => [node.id, node]));
  const items = new Map(before.report.items.map(item => [item.node.id, item]));
  const inputs: NodeInput[] = [];

  for (const change of request.changes) {
    const node = nodes.get(change.node.id);
    if (!node || node.kind === 'fact' || node.state !== 'active') return notApplicable();
    if (node.revision !== change.node.revision) return revisionConflict();

    const item = items.get(node.id);
    if (!item || item.node.revision !== node.revision || item.action !== 'RECHECK') return notApplicable();
    if (node.summary === change.summary && sameDependencies(node.dependencies, change.dependencies)) {
      return notApplicable();
    }

    inputs.push({
      id: node.id,
      kind: node.kind,
      summary: change.summary,
      sourceRef: node.sourceRef,
      validFrom: node.validFrom,
      validUntil: node.validUntil,
      sensitivity: node.sensitivity,
      state: node.state,
      reason: change.reason,
      dependencies: structuredClone(change.dependencies)
    });
  }

  // appendVersions validates dependency existence and applies the explicitly
  // ordered candidates on an isolated graph. Future references therefore fail
  // naturally instead of being silently reordered or rebound.
  const afterSnapshot = structuredClone(appendVersions(
    before.snapshot, request.expectedGraphRevision, inputs
  ));
  return {
    before: isolatedImpact(before.snapshot, at),
    inputs: structuredClone(inputs),
    after: isolatedImpact(afterSnapshot, at)
  };
}

/** Internal snapshot entry for scoped, read-only previews. */
export function previewRepairSnapshot(
  snapshot: GraphSnapshot,
  at: string,
  request: StoredRepairRequest
): StoredRepairPreview {
  validateRequest(request);
  validateAt(at);
  return isolatedPreview(buildPreview(structuredClone(snapshot), at, request));
}

/**
 * Validate and preview a complete, explicit repair chain without writing the
 * host-bound store. This is a candidate only; it does not approve semantics,
 * rebind automatically, change task state, or execute any action.
 */
export function previewStoredRepair(
  store: CoordinationStorePort,
  at: string,
  request: StoredRepairRequest
): StoredRepairPreview {
  validateRequest(request);
  validateAt(at);
  requireReadableStore(store);
  const snapshot = structuredClone(store.read());
  return isolatedPreview(buildPreview(snapshot, at, request));
}

/**
 * Atomically commit the same explicit repair chain after a fresh preview. A
 * graph CAS conflict returns one fresh analysis and never retries. A stale
 * node reference with an otherwise matching graph remains REVISION_CONFLICT.
 */
export function commitStoredRepair(
  store: AtomicCoordinationStorePort,
  at: string,
  request: StoredRepairRequest
): StoredRepairResult {
  validateRequest(request);
  validateAt(at);
  requireAtomicStore(store);

  const snapshot = structuredClone(store.read());
  if (snapshot.revision !== request.expectedGraphRevision) {
    return freshConflict(store, at, request.expectedGraphRevision);
  }

  const preview = buildPreview(snapshot, at, request);
  let committed: GraphSnapshot;
  try {
    committed = structuredClone(store.appendBatch(
      request.expectedGraphRevision, structuredClone(preview.inputs)
    ));
  } catch (error) {
    if (!isRevisionConflict(error)) throw error;
    return freshConflict(store, at, request.expectedGraphRevision);
  }

  const report = analyzeImpact(committed, at);
  return {
    kind: 'applied',
    preview: isolatedPreview(preview),
    snapshot: structuredClone(committed),
    report: structuredClone(report)
  };
}
