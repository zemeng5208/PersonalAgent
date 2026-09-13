import {parseGraph, isEffective} from '@personal-agent/goals';
import type {GraphSnapshot, NodeRef, NodeVersion} from '@personal-agent/goals';

/** Local provisional domain output, not a Runtime/Memory wire protocol. */
export interface ImpactCause {
  reference: NodeRef;
  currentRevision: number;
  reason: 'superseded' | 'withdrawn' | 'not_effective';
}
export interface ImpactItem {
  node: NodeRef;
  kind: 'goal' | 'decision' | 'plan';
  action: 'KEEP' | 'RECHECK';
  reason: 'unaffected' | 'inactive' | 'dependency_or_validity_changed';
  causes: ImpactCause[];
}
export interface ImpactReport {
  namespace: string;
  graphRevision: number;
  evaluatedAt: string;
  items: ImpactItem[];
}
export class CognitionError extends Error {
  constructor(readonly code: 'INVALID_ARGUMENT' | 'REVISION_CONFLICT' | 'NOT_APPLICABLE') {
    super(`Cognition request rejected: ${code}`);
  }
}
const ref = (n: NodeRef): NodeRef => ({id: n.id, revision: n.revision});
const key = (n: NodeRef): string => JSON.stringify([n.id, n.revision]);
function unique(causes: ImpactCause[]): ImpactCause[] {
  const entries = new Map(causes.map(c => [JSON.stringify([c.reference.id, c.reference.revision, c.reason]), c]));
  return [...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, c]) => c);
}
function time(value: string): void {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new CognitionError('INVALID_ARGUMENT');
  }
}

/** Full replay, including unresolved older changes and time-only expiry. No writes. */
export function analyzeImpact(snapshot: GraphSnapshot, at: string): ImpactReport {
  time(at);
  const graph = parseGraph(snapshot);
  const latest = new Map<string, NodeVersion>();
  for (const n of graph.history) latest.set(n.id, n);
  const causesByVersion = new Map<string, ImpactCause[]>();
  // Append order is topological for exact version references, even if IDs recur.
  for (const n of graph.history) {
    const current = latest.get(n.id)!;
    const causes: ImpactCause[] = [];
    if (current.revision !== n.revision) causes.push({reference: ref(n), currentRevision: current.revision, reason: 'superseded'});
    if (n.state === 'withdrawn') causes.push({reference: ref(n), currentRevision: current.revision, reason: 'withdrawn'});
    else if (!isEffective(n, at)) causes.push({reference: ref(n), currentRevision: current.revision, reason: 'not_effective'});
    for (const dep of n.dependencies) causes.push(...causesByVersion.get(key(dep))!);
    causesByVersion.set(key(n), unique(causes));
  }
  const items: ImpactItem[] = [];
  for (const n of latest.values()) {
    if (n.kind === 'fact') continue;
    const causes = causesByVersion.get(key(n))!;
    const inactive = n.state === 'withdrawn';
    items.push({node: ref(n), kind: n.kind, action: !inactive && causes.length ? 'RECHECK' : 'KEEP',
      reason: inactive ? 'inactive' : causes.length ? 'dependency_or_validity_changed' : 'unaffected',
      causes: inactive ? [] : causes});
  }
  return {namespace: graph.namespace, graphRevision: graph.revision, evaluatedAt: at, items: structuredClone(items)};
}

export interface PlanRevisionRequest {
  expectedGraphRevision: number;
  plan: NodeRef;
  summary: string;
  reason: string;
}
export interface PlanRevisionProposal {
  namespace: string;
  graphRevision: number;
  evaluatedAt: string;
  plan: NodeRef;
  action: 'REVISE';
  reason: string;
  causes: ImpactCause[];
  changes: {field: 'summary'; before: string; after: string}[];
}
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) {
    throw new CognitionError('INVALID_ARGUMENT');
  }
}

/** Validate an explicit summary-only candidate. REVISE is a proposal, not a repaired graph. */
export function proposePlanRevision(snapshot: GraphSnapshot, at: string, request: PlanRevisionRequest): PlanRevisionProposal {
  exact(request, ['expectedGraphRevision', 'plan', 'summary', 'reason']);
  exact(request.plan, ['id', 'revision']);
  if (!Number.isSafeInteger(request.expectedGraphRevision) || request.expectedGraphRevision < 0
    || typeof request.plan.id !== 'string' || !request.plan.id.trim()
    || !Number.isSafeInteger(request.plan.revision) || request.plan.revision < 1
    || typeof request.summary !== 'string' || !request.summary.trim()
    || typeof request.reason !== 'string' || !request.reason.trim()) throw new CognitionError('INVALID_ARGUMENT');
  const graph = parseGraph(snapshot);
  if (graph.revision !== request.expectedGraphRevision) throw new CognitionError('REVISION_CONFLICT');
  const node = graph.history.findLast(n => n.id === request.plan.id);
  if (!node || node.kind !== 'plan') throw new CognitionError('NOT_APPLICABLE');
  if (node.revision !== request.plan.revision) throw new CognitionError('REVISION_CONFLICT');
  const report = analyzeImpact(graph, at);
  const item = report.items.find(i => i.node.id === node.id)!;
  if (item.action !== 'RECHECK' || node.summary === request.summary) throw new CognitionError('NOT_APPLICABLE');
  return {namespace: graph.namespace, graphRevision: graph.revision, evaluatedAt: at,
    plan: ref(node), action: 'REVISE', reason: request.reason, causes: item.causes,
    changes: [{field: 'summary', before: node.summary, after: request.summary}]};
}
