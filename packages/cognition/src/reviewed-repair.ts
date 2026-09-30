import type {GraphSnapshot, NodeRef} from '@personal-agent/goals';
import {CognitionError} from './impact.js';
import {actionArgumentsDigest} from './laya-action-choice.js';
import {previewRepairSnapshot} from './repair.js';
import type {StoredRepairRequest, StoredRepairPreview} from './repair.js';

/** Trusted in-process review projection; not a wire operation or authorization. */
export interface ReviewedRepairSelection {
  taskId: string;
  graphNamespace: string;
  graphRevision: number;
  bindingVersion: string;
  affected: readonly {node: NodeRef}[];
  options: readonly {id: string; revision: number; description: string; action: string; repair?: StoredRepairRequest}[];
  selectedOption?: ReviewedRepairSelection['options'][number];
  selection?: {state: string; eligibleForRuntime: boolean; selected?: NodeRef};
}
export interface ReviewedRepairBinding {
  reviewTaskId: string;
  graphNamespace: string;
  bindingVersion: string;
  graphRevision: number;
  selectionDigest: string;
  candidateDigest: string;
  targets: NodeRef[];
  dependencies: NodeRef[];
}
export type ReviewedRepairPreparation =
  | {kind: 'unavailable'; reason: 'no_selected_repair' | 'unsupported_scope'}
  | {kind: 'prepared'; binding: ReviewedRepairBinding; request: StoredRepairRequest; preview: StoredRepairPreview};
const same=(a: NodeRef | undefined,b: NodeRef | undefined): boolean => !!a && !!b && a.id===b.id && a.revision===b.revision;
const invalid=(): never => {throw new CognitionError('INVALID_ARGUMENT');};
const conflict=(): never => {throw new CognitionError('REVISION_CONFLICT');};
const digest=(input: object): string => actionArgumentsDigest(input as Record<string,unknown>);

/** Reuse the existing repair preflight; cloud text may vary only inside the selected structural scope. */
export function prepareReviewedRepair(snapshot: GraphSnapshot,at: string,review: ReviewedRepairSelection,
  candidate?: StoredRepairRequest): ReviewedRepairPreparation {
  if (!review || review.graphNamespace!==snapshot.namespace || !review.taskId || !review.bindingVersion) return invalid();
  if (review.graphRevision!==snapshot.revision) return conflict();
  const option=review.selectedOption;
  if (!option || review.selection?.state!=='selected' || review.selection.eligibleForRuntime!==true
    || !same(option,review.selection.selected) || option.action!=='REVISE' || !option.repair) {
    return {kind:'unavailable',reason:'no_selected_repair'};
  }
  if (!review.options.some(offered=>same(offered,option) && digest(offered)===digest(option))) return invalid();
  if (option.repair.expectedGraphRevision!==snapshot.revision) return conflict();
  if (!Array.isArray(review.affected) || option.repair.changes.some(change=>!review.affected.some(item=>same(item.node,change.node)))) return invalid();
  const selected=previewRepairSnapshot(snapshot,at,option.repair);
  if (selected.inputs.length>16 || selected.inputs.some(node=>node.sensitivity==='restricted')) {
    return {kind:'unavailable',reason:'unsupported_scope'};
  }
  const request=candidate??option.repair;
  if (request.expectedGraphRevision!==snapshot.revision) return conflict();
  // Canonical validation rejects accessor-bearing/prototype data before it is cloned or interpreted.
  const candidateDigest=digest(request);
  const preview=previewRepairSnapshot(snapshot,at,request);
  if (!Array.isArray(request.changes) || request.changes.some(change=>{
    const allowed=option.repair!.changes.find(item=>same(item.node,change.node));
    return !allowed || change.summary===option.description
      || change.dependencies.length!==allowed.dependencies.length
      || change.dependencies.some(dep=>!allowed.dependencies.some(ref=>same(ref,dep)));
  })) return invalid();
  const dependencies=new Map<string,NodeRef>();
  for (const change of option.repair.changes) for (const dep of change.dependencies) dependencies.set(JSON.stringify(dep),dep);
  return structuredClone({kind:'prepared' as const,binding:{reviewTaskId:review.taskId,
    graphNamespace:review.graphNamespace,bindingVersion:review.bindingVersion,graphRevision:snapshot.revision,
    selectionDigest:digest(option),candidateDigest,
    targets:option.repair.changes.map(change=>({...change.node})),dependencies:[...dependencies.values()]},request,preview});
}
