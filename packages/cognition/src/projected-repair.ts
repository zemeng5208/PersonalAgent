import type {GraphSnapshot, NodeRef} from '@personal-agent/goals';
import type {CoordinationStorePort} from '@personal-agent/goals/store';
import {analyzeImpact, CognitionError} from './impact.js';
import type {ImpactItem} from './impact.js';
import {previewRepairSnapshot} from './repair.js';
import type {StoredRepairChange, StoredRepairPreview} from './repair.js';

/** Structural view of a trusted Runtime projection receipt; not a wire contract. */
export interface ProjectedRepairInput {
  graphNamespace: string;
  projection: {
    batchToken: string;
    graphRevision: number;
    links: readonly {eventId: string; fact: NodeRef; node: NodeRef}[];
  };
}

export interface ProjectedRepairScope {
  namespace: string;
  graphRevision: number;
  evaluatedAt: string;
  items: ImpactItem[];
}

export interface ProjectedRepairRequest extends ProjectedRepairInput {
  changes: StoredRepairChange[];
}

export interface ProjectedRepairPreview {
  scope: ProjectedRepairScope;
  repair: StoredRepairPreview;
}

function invalid(): never { throw new CognitionError('INVALID_ARGUMENT'); }
function conflict(): never { throw new CognitionError('REVISION_CONFLICT'); }
function notApplicable(): never { throw new CognitionError('NOT_APPLICABLE'); }
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Reflect.ownKeys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key))) return invalid();
  return value as Record<string, unknown>;
}
function reference(value: unknown): NodeRef {
  const raw = exact(value, ['id', 'revision']);
  if (typeof raw.id !== 'string' || !raw.id.trim() || !Number.isSafeInteger(raw.revision)
    || (raw.revision as number) < 1) return invalid();
  return {id: raw.id, revision: raw.revision as number};
}
function input(value: unknown, keys: readonly string[]): ProjectedRepairInput {
  const raw = exact(value, keys);
  const projection = exact(raw.projection, ['batchToken', 'graphRevision', 'links']);
  if (typeof raw.graphNamespace !== 'string' || !raw.graphNamespace.trim()
    || typeof projection.batchToken !== 'string' || !projection.batchToken.trim()
    || !Number.isSafeInteger(projection.graphRevision) || (projection.graphRevision as number) < 0
    || !Array.isArray(projection.links) || projection.links.length > 100) return invalid();
  const events = new Set<string>();
  const links = projection.links.map(link => {
    const item = exact(link, ['eventId', 'fact', 'node']);
    if (typeof item.eventId !== 'string' || !item.eventId.trim()
      || events.has(item.eventId)) return invalid();
    events.add(item.eventId);
    return {eventId: item.eventId, fact: reference(item.fact), node: reference(item.node)};
  });
  return {graphNamespace: raw.graphNamespace, projection: {
    batchToken: projection.batchToken, graphRevision: projection.graphRevision as number, links
  }};
}

/** Current RECHECK items caused by this committed Fact projection only. */
export function selectProjectedRepairScope(
  snapshot: GraphSnapshot, at: string, request: ProjectedRepairInput
): ProjectedRepairScope {
  const selected = input(request, ['graphNamespace', 'projection']);
  const report = analyzeImpact(snapshot, at);
  if (report.namespace !== selected.graphNamespace) return invalid();
  if (report.graphRevision !== selected.projection.graphRevision) return conflict();
  for (const link of selected.projection.links) {
    if (!snapshot.history.some(node => node.id === link.node.id
      && node.revision === link.node.revision && node.kind === 'fact')) return notApplicable();
  }
  const items = report.items.filter(item => item.action === 'RECHECK'
    && item.causes.some(cause => selected.projection.links.some(link =>
      cause.reference.id === link.node.id
      && cause.currentRevision === link.node.revision)));
  return structuredClone({namespace: report.namespace, graphRevision: report.graphRevision,
    evaluatedAt: report.evaluatedAt, items});
}

/** Read one bound snapshot and preview only caller-authored affected changes. */
export function previewProjectedRepair(
  store: CoordinationStorePort, at: string, request: ProjectedRepairRequest
): ProjectedRepairPreview {
  const selected = input(request, ['graphNamespace', 'projection', 'changes']);
  if (!store || typeof store.read !== 'function') return notApplicable();
  const snapshot = structuredClone(store.read());
  const scope = selectProjectedRepairScope(snapshot, at, selected);
  const repair = previewRepairSnapshot(snapshot, at, {
    expectedGraphRevision: selected.projection.graphRevision, changes: request.changes
  });
  const affected = new Set(scope.items.map(item => `${item.node.id}\u0000${item.node.revision}`));
  if (request.changes.some(change => !affected.has(`${change.node.id}\u0000${change.node.revision}`))) {
    return notApplicable();
  }
  return structuredClone({scope, repair});
}
