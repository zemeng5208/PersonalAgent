import {currentNodes, isEffective} from '@personal-agent/goals';
import type {GraphSnapshot, NodeRef, NodeVersion} from '@personal-agent/goals';
import {analyzeImpact, CognitionError} from './impact.js';
import {previewRepairSnapshot} from './repair.js';
import type {StoredRepairChange, StoredRepairPreview, StoredRepairRequest} from './repair.js';

export interface MinimalRepairSelection {
  expectedGraphRevision: number;
  /** Current RECHECK refs selected by a trusted impact scope. Maximum 100. */
  targets: NodeRef[];
}

export type MinimalRepairResult =
  | {kind: 'candidate'; request: StoredRepairRequest; preview: StoredRepairPreview;
      semanticReviewRequired: true; remaining: NodeRef[]}
  | {kind: 'recheck'; reason: 'no_safe_dependency_rebind'; remaining: NodeRef[]};

const invalid = (): never => { throw new CognitionError('INVALID_ARGUMENT'); };
const conflict = (): never => { throw new CognitionError('REVISION_CONFLICT'); };
const notApplicable = (): never => { throw new CognitionError('NOT_APPLICABLE'); };
const ref = (node: NodeRef): NodeRef => ({id: node.id, revision: node.revision});

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Reflect.ownKeys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key))) return invalid();
  return value as Record<string, unknown>;
}

function selection(value: unknown): MinimalRepairSelection {
  const raw = exact(value, ['expectedGraphRevision', 'targets']);
  if (!Number.isSafeInteger(raw.expectedGraphRevision)
    || (raw.expectedGraphRevision as number) < 0
    || !Array.isArray(raw.targets) || raw.targets.length === 0 || raw.targets.length > 100) {
    return invalid();
  }
  const seen = new Set<string>();
  const targets = raw.targets.map(value => {
    const node = exact(value, ['id', 'revision']);
    if (typeof node.id !== 'string' || !node.id.trim()
      || !Number.isSafeInteger(node.revision) || (node.revision as number) < 1
      || seen.has(node.id)) return invalid();
    seen.add(node.id);
    return {id: node.id, revision: node.revision as number};
  });
  return {expectedGraphRevision: raw.expectedGraphRevision as number, targets};
}

/**
 * Build a read-only, structural dependency candidate for a trusted impact scope.
 * It changes only superseded direct refs (or refs to earlier candidates), and
 * preserves every node's summary and reason. The caller must review semantics
 * and revalidate the graph before any separate commit or execution.
 */
export function buildMinimalRepairCandidate(
  snapshot: GraphSnapshot, at: string, input: MinimalRepairSelection
): MinimalRepairResult {
  const selected = selection(input);
  const report = analyzeImpact(snapshot, at);
  if (report.graphRevision !== selected.expectedGraphRevision) return conflict();

  const nodes = new Map(currentNodes(snapshot).map(node => [node.id, node]));
  const items = new Map(report.items.map(item => [item.node.id, item]));
  const selectedIds = new Set(selected.targets.map(target => target.id));
  for (const target of selected.targets) {
    const node = nodes.get(target.id);
    if (!node) return notApplicable();
    if (node.revision !== target.revision) return conflict();
    if (node.kind === 'fact' || node.state !== 'active'
      || items.get(node.id)?.action !== 'RECHECK') return notApplicable();
  }

  // A current ID graph can contain a cycle even though exact version refs do
  // not. Kahn ordering leaves such nodes (and their dependants) for RECHECK.
  const pending = new Set(selectedIds);
  const ordered: NodeVersion[] = [];
  while (pending.size) {
    const ready = [...pending].filter(id => nodes.get(id)!.dependencies.every(dep =>
      !pending.has(dep.id))).sort();
    if (!ready.length) break;
    for (const id of ready) {
      pending.delete(id);
      ordered.push(nodes.get(id)!);
    }
  }

  const repaired = new Map<string, number>();
  const changes: StoredRepairChange[] = [];
  for (const node of ordered) {
    if (!isEffective(node, at)) continue;
    let blocked = false;
    const dependencies = node.dependencies.map(dep => {
      const head = nodes.get(dep.id)!;
      const newRevision = repaired.get(dep.id);
      if (!isEffective(head, at)
        || (items.get(head.id)?.action === 'RECHECK' && newRevision === undefined)) {
        blocked = true;
        return ref(dep);
      }
      // Never create a new dependency identity. A new candidate revision is
      // usable only after that dependency appeared earlier in this batch.
      return {id: dep.id, revision: newRevision ?? head.revision};
    });
    if (blocked || dependencies.every((dep, index) =>
      dep.revision === node.dependencies[index]!.revision)) continue;
    changes.push({node: ref(node), summary: node.summary, reason: node.reason, dependencies});
    repaired.set(node.id, node.revision + 1);
  }

  if (!changes.length) return {kind: 'recheck', reason: 'no_safe_dependency_rebind',
    remaining: selected.targets.map(ref).sort((a, b) => a.id.localeCompare(b.id))};
  const request: StoredRepairRequest = {expectedGraphRevision: selected.expectedGraphRevision, changes};
  const preview = previewRepairSnapshot(snapshot, at, request);
  const remaining = preview.after.report.items.filter(item =>
    selectedIds.has(item.node.id) && item.action === 'RECHECK').map(item => ref(item.node));
  return structuredClone({kind: 'candidate' as const, request, preview,
    semanticReviewRequired: true as const, remaining});
}
