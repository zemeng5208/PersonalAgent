import {ProtocolError} from '@personal-agent/contracts';
import type {TaskSnapshot} from '@personal-agent/contracts';
import {actionArgumentsDigest, analyzeImpact, buildMinimalRepairCandidate, previewStoredRepair,
  selectGoalRevisionImpact, selectProjectedRepairScope} from '@personal-agent/cognition';
import type {GoalRevisionSelectionRequest, ImpactItem, LayaActionChoiceService,
  LayaActionSelection, ProjectedRepairInput, StoredRepairRequest} from '@personal-agent/cognition';
import type {MemoryReadContext} from '@personal-agent/memory';
import type {GraphSnapshot, NodeRef} from '@personal-agent/goals';
import {toolArgumentsDigest} from '@personal-agent/tool-gateway';
import type {RuntimeApplication} from './runtime-application.js';
import type {SqliteFactProjectionHost} from './sqlite-fact-projection.js';

const INTENT = 'proactive-cognition-intent-v1';
const REVIEW = 'proactive-cognition-review-v1';
const HANDOFF = 'proactive-cognition-handoff-v1';
type Trigger = {kind: 'fact'; input: ProjectedRepairInput}
  | {kind: 'goal'; input: GoalRevisionSelectionRequest}
  | {kind: 'expiry'; input: {graphRevision: number; facts: NodeRef[]; consumers: NodeRef[]}};
interface ReviewIntent {
  version: 1; graphNamespace: string; bindingVersion: string; trigger: Trigger; evaluatedAt: string;
}
/** A proposed approach for AgentArts, never a local tool call or authorization. */
export interface ProactiveCognitionOption {
  id: string;
  revision: number;
  description: string;
  action: 'RECHECK' | 'REVISE';
  repair?: StoredRepairRequest;
}
export interface ProactiveCognitionReview {
  taskId: string;
  graphNamespace: string;
  graphRevision: number;
  bindingVersion: string;
  evaluatedAt: string;
  action: 'KEEP' | 'RECHECK' | 'REVISE';
  affected: ImpactItem[];
  options: ProactiveCognitionOption[];
  selectedOption?: ProactiveCognitionOption;
  /** Low-confidence Laya result routed to the already-offered machine RECHECK option. */
  machineReview?: {reason: 'uncertain'; action: 'RECHECK'; option: {id: string; revision: number}};
  selection?: LayaActionSelection;
  /** Structural proposals are inputs to AgentArts semantic reasoning, not completed repairs. */
  semanticReviewRequired: true;
}
/** Local host envelope. Only its explicitly export-approved goal enters CoordinationRequest. */
export interface ProactiveSelectionHandoff {
  commandId: string;
  reviewTaskId: string;
  selectionDigest: string;
  exportPolicyVersion: string;
  goal: string;
  deadline: string;
}
export interface ProactiveSelectionHandoffPort {
  /** Minimize permitted data for AgentArts; return undefined when egress scope is unavailable. */
  prepare(review: ProactiveCognitionReview, context: MemoryReadContext): Promise<{
    exportPolicyVersion: string; goal: string;
  } | undefined>;
  /** Read an already-persisted Runtime task by this exact stable command ID. No network or dispatch. */
  read(commandId: string): TaskSnapshot | undefined;
  /** Revalidate export scope, then submit to existing AgentArts Runtime orchestration with command idempotency. */
  dispatch(request: ProactiveSelectionHandoff, context: MemoryReadContext): Promise<TaskSnapshot>;
}
export interface ProactiveReviewReadback {
  task: TaskSnapshot;
  review?: ProactiveCognitionReview;
  handoff?: {state: 'submitted'; task: TaskSnapshot} | {state: 'unavailable' | 'expired' | 'pending'};
}
export interface ProactiveCognitionHostOptions {
  application: RuntimeApplication;
  facts: SqliteFactProjectionHost;
  graphNamespace: string;
  bindingVersion: string;
  chooser: Pick<LayaActionChoiceService, 'choose'>;
  /** Optional host-authored legal approaches. Scope and every repair are validated before Laya. */
  prepareOptions?(review: ProactiveCognitionReview, context: MemoryReadContext): Promise<readonly ProactiveCognitionOption[]>;
  selectionHandoff?: ProactiveSelectionHandoffPort;
}
export interface ProactiveCognitionHost {
  consumeAndReview(request: MemoryReadContext & {at: string; limit: number; afterGraphRevision: number}): Promise<{
    reviews: ProactiveReviewReadback[]; nextGraphRevision: number; atWatermark: boolean; hasMoreReviews: boolean;
  }>;
  reviewGoalRevision(input: GoalRevisionSelectionRequest, request: MemoryReadContext & {at: string}): Promise<ProactiveReviewReadback>;
  readReview(taskId: string): ProactiveReviewReadback;
  /** Retry the same idempotent AgentArts handoff, never rerun a saved Laya decision. */
  handoffReview(taskId: string, context: MemoryReadContext): Promise<ProactiveReviewReadback>;
  close(): void;
}

function active(context: MemoryReadContext): void {
  if (!(context.signal instanceof AbortSignal) || !Number.isFinite(Date.parse(context.deadline))) {
    throw new ProtocolError('INVALID_ARGUMENT', 'Invalid cognition request');
  }
  if (context.signal.aborted) throw new ProtocolError('CANCELLED', 'Cognition request cancelled');
  if (Date.now() >= Date.parse(context.deadline)) throw new ProtocolError('TIMEOUT', 'Cognition deadline expired');
}
function evaluationTime(at: string): void {
  if (typeof at !== 'string' || !Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at) {
    throw new ProtocolError('INVALID_ARGUMENT', 'Invalid cognition evaluation time');
  }
}
function localDecisionContext(snapshot: GraphSnapshot, affected: readonly ImpactItem[]): string {
  const current = new Map(snapshot.history.map(node => [node.id, node]));
  const detail = affected.map(item => ({kind: item.kind,
    summary: current.get(item.node.id)!.summary,
    changes: item.causes.map(cause => ({reason: cause.reason,
      before: snapshot.history.find(node => node.id === cause.reference.id
        && node.revision === cause.reference.revision)?.summary,
      current: current.get(cause.reference.id)?.summary,
    })),
  }));
  const context = {destination: 'AgentArts orchestration', semanticReviewRequired: true,
    affectedCount: affected.length, detail};
  return JSON.stringify(context);
}

const refKey = (ref: NodeRef): string => JSON.stringify([ref.id, ref.revision]);
function expiredPublicFactScope(snapshot: GraphSnapshot, at: string): {facts: NodeRef[]; items: ImpactItem[]} {
  const current = new Map(snapshot.history.map(node => [node.id, node]));
  const expired = [...current.values()].filter(node => node.kind === 'fact' && node.state === 'active'
    && node.sensitivity === 'public' && Date.parse(node.validUntil) <= Date.parse(at));
  const facts = expired.map(node => ({id: node.id, revision: node.revision}));
  const keys = new Set(facts.map(refKey));
  const items = analyzeImpact(snapshot, at).items.filter(item => item.action === 'RECHECK'
    && item.causes.some(cause => cause.reason === 'not_effective'
      && cause.currentRevision === cause.reference.revision && keys.has(refKey(cause.reference))));
  const used = new Set(items.flatMap(item => item.causes.filter(cause => cause.reason === 'not_effective'
    && cause.currentRevision === cause.reference.revision && keys.has(refKey(cause.reference)))
    .map(cause => refKey(cause.reference))));
  return {facts: facts.filter(ref => used.has(refKey(ref))).sort((a, b) => refKey(a).localeCompare(refKey(b))), items};
}

function uncertainRecheck(review: ProactiveCognitionReview): ProactiveCognitionReview['machineReview'] {
  const selection = review.selection;
  if (selection?.state !== 'review' || selection.reason !== 'uncertain'
    || selection.eligibleForRuntime !== false || !selection.selected
    || !review.options.some(option => option.id === selection.selected!.id
      && option.revision === selection.selected!.revision)) return undefined;
  const recheck = review.options.filter(option => option.id === 'recheck' && option.action === 'RECHECK'
    && option.repair === undefined && Number.isSafeInteger(option.revision) && option.revision > 0);
  return recheck.length === 1 ? {reason: 'uncertain', action: 'RECHECK',
    option: {id: recheck[0]!.id, revision: recheck[0]!.revision}} : undefined;
}

/** Trusted Competition composition: choose locally, then hand off to AgentArts. No local execution shortcut. */
export function createProactiveCognitionHost(options: ProactiveCognitionHostOptions): ProactiveCognitionHost {
  const {application, facts, graphNamespace, bindingVersion, chooser, prepareOptions, selectionHandoff: handoff} = options;
  if (application.profile !== 'huawei_ict_agentarts' || !graphNamespace?.trim() || !bindingVersion?.trim()) {
    throw new ProtocolError('INVALID_ARGUMENT', 'Invalid proactive cognition binding');
  }
  const runtime = application.runtime;
  const store = runtime.bindCoordinationStore(graphNamespace);
  const controllers = new Set<AbortController>();
  let closed = false;
  const open = () => {
    if (closed) throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'Cognition host is closed');
  };
  const readReview = (taskId: string): ProactiveReviewReadback => {
    open();
    const task = runtime.getTask(taskId);
    const intent = runtime.loadCheckpoint(taskId, INTENT) as ReviewIntent | undefined;
    if (!intent || intent.version !== 1 || intent.graphNamespace !== graphNamespace || intent.bindingVersion !== bindingVersion) {
      throw new ProtocolError('UNAUTHORIZED', 'Cognition review is outside this host binding');
    }
    const review = runtime.loadCheckpoint(taskId, REVIEW) as ProactiveCognitionReview | undefined;
    return {task, ...(review ? {review: structuredClone(review)} : {})};
  };
  const handoffWork = async (taskId: string, context: MemoryReadContext): Promise<ProactiveReviewReadback> => {
    open(); active(context);
    const readback = readReview(taskId);
    let result = readback.review;
    if (readback.task.state !== 'succeeded' || !result) return readback;
    let intent = runtime.loadCheckpoint(taskId, HANDOFF) as ProactiveSelectionHandoff | undefined;
    const machineReview = result.selectedOption ? undefined : uncertainRecheck(result);
    if (!result.selectedOption && !machineReview) return readback;
    if (result.machineReview && JSON.stringify(result.machineReview) !== JSON.stringify(machineReview)) {
      throw new ProtocolError('INVALID_ARGUMENT', 'Invalid persisted machine review');
    }
    if (!handoff) return {...readback, handoff: {state: 'unavailable'}};
    if (!intent) {
      if (machineReview && !result.machineReview) {
        result = {...result, machineReview};
        runtime.saveCheckpoint(taskId, REVIEW, result);
        readback.review = structuredClone(result);
      }
      const projected = await handoff.prepare(structuredClone(result), context);
      active(context); open();
      if (!projected) return {...readback, handoff: {state: 'unavailable'}};
      if (typeof projected.exportPolicyVersion !== 'string' || !projected.exportPolicyVersion.trim()
        || typeof projected.goal !== 'string' || !projected.goal.trim()) {
        throw new ProtocolError('INVALID_ARGUMENT', 'Invalid cognition export projection');
      }
      const proposed: ProactiveSelectionHandoff = {
        commandId: 'proactive-' + toolArgumentsDigest({graphNamespace, bindingVersion, taskId}),
        reviewTaskId: taskId, selectionDigest: toolArgumentsDigest(result),
        exportPolicyVersion: projected.exportPolicyVersion, goal: projected.goal, deadline: context.deadline,
      };
      // An overlapping caller may have persisted an envelope while prepare awaited.
      intent = runtime.loadCheckpoint(taskId, HANDOFF) as ProactiveSelectionHandoff | undefined;
      if (!intent) { intent = proposed; runtime.saveCheckpoint(taskId, HANDOFF, intent); }
    }
    const prior = handoff.read(intent.commandId);
    if (prior) return {...readback, handoff: {state: 'submitted', task: prior}};
    if (Date.parse(intent.deadline) <= Date.now()) return {...readback, handoff: {state: 'expired'}};
    active(context); open();
    const deadline = new Date(Math.min(Date.parse(context.deadline), Date.parse(intent.deadline))).toISOString();
    const task = await handoff.dispatch(structuredClone(intent), {...context, deadline});
    // Submission may have committed before cancellation; return its real receipt.
    return {...readback, handoff: {state: 'submitted', task}};
  };
  const handoffReview = async (taskId: string, request: MemoryReadContext): Promise<ProactiveReviewReadback> => {
    open(); active(request);
    const initial = readReview(taskId);
    const controller = new AbortController();
    controllers.add(controller);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); },
      Math.min(Date.parse(request.deadline) - Date.now(), 2_147_483_647));
    const signal = AbortSignal.any([request.signal, controller.signal]);
    let stop = () => {};
    try {
      const interrupted = new Promise<never>((_resolve, reject) => {
        stop = () => reject(new ProtocolError(timedOut ? 'TIMEOUT' : 'CANCELLED', 'Cognition handoff interrupted'));
        signal.addEventListener('abort', stop, {once: true});
      });
      return await Promise.race([interrupted, handoffWork(taskId, {...request, signal})]);
    } catch (error) {
      if (signal.aborted && handoff) {
        const intent = runtime.loadCheckpoint(taskId, HANDOFF) as ProactiveSelectionHandoff | undefined;
        if (intent) {
          const submitted = handoff.read(intent.commandId);
          // Once dispatch may have started, cancellation is not proof of no
          // submission. Preserve the exact journal and expose reconciliation.
          return {...initial, handoff: submitted ? {state: 'submitted', task: submitted} : {state: 'pending'}};
        }
      }
      throw error;
    } finally { clearTimeout(timer); signal.removeEventListener('abort', stop); controllers.delete(controller); }
  };
  const review = async (trigger: Trigger, request: MemoryReadContext & {at: string}): Promise<ProactiveReviewReadback> => {
    open(); active(request); evaluationTime(request.at);
    const identity = trigger.kind === 'expiry' ? {kind: trigger.kind, facts: trigger.input.facts,
      consumers: trigger.input.consumers} : trigger;
    const key = 'proactive-cognition:' + toolArgumentsDigest({graphNamespace, bindingVersion, trigger: identity});
    const existing = runtime.findTaskByIdempotencyKey(key);
    if (existing && existing.state !== 'created') {
      const saved = readReview(existing.taskId);
      if (existing.state === 'waiting_reconciliation') {
        runtime.reconcileTask(existing.taskId, saved.review ? 'confirmed' : 'not_performed');
      }
      return handoffReview(existing.taskId, request);
    }
    const persisted = existing ? runtime.loadCheckpoint(existing.taskId, INTENT) as ReviewIntent : undefined;
    if (persisted) { request = {...request, at: persisted.evaluatedAt}; trigger = persisted.trigger; }
    const revision = trigger.kind === 'fact' ? trigger.input.projection.graphRevision
      : trigger.kind === 'goal' ? trigger.input.expectedGraphRevision : trigger.input.graphRevision;
    const snapshot = store.read(revision);
    const scope = trigger.kind === 'fact'
      ? selectProjectedRepairScope(snapshot, request.at, trigger.input)
      : trigger.kind === 'goal' ? selectGoalRevisionImpact(snapshot, request.at, trigger.input)
        : {items: expiredPublicFactScope(snapshot, request.at).items.filter(item =>
          trigger.input.consumers.some(ref => refKey(ref) === refKey(item.node)))};
    const intent: ReviewIntent = {version: 1, graphNamespace, bindingVersion, trigger: structuredClone(trigger), evaluatedAt: request.at};
    const task = runtime.submitTaskWithCheckpoint({goal: 'Choose an approach for trusted dependency changes',
      conversationId: 'proactive-cognition:' + graphNamespace, idempotencyKey: key}, INTENT, intent);
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.signal.addEventListener('abort', abort, {once: true});
    controllers.add(controller);
    try {
      await runtime.runTask(task.taskId, async worker => {
        const context = {signal: AbortSignal.any([worker.signal, controller.signal, request.signal]), deadline: request.deadline};
        active(context);
        const result: ProactiveCognitionReview = {taskId: task.taskId, graphNamespace,
          graphRevision: snapshot.revision, bindingVersion, evaluatedAt: request.at,
          action: scope.items.length ? 'RECHECK' : 'KEEP', affected: structuredClone(scope.items),
          options: [], semanticReviewRequired: true};
        if (scope.items.length) {
          const candidate = trigger.kind === 'expiry' ? undefined : buildMinimalRepairCandidate(snapshot, request.at, {
            expectedGraphRevision: snapshot.revision, targets: scope.items.map(item => item.node),
          });
          result.options = [
            {id: 'recheck', revision: 1, action: 'RECHECK', description: 'Ask AgentArts to verify the changed sources and affected dependencies before deciding a plan.'},
            {id: 'defer', revision: 1, action: 'RECHECK', description: 'Ask AgentArts to retain the current plan and arrange a later recheck without executing the stale plan.'},
            ...(candidate?.kind === 'candidate' ? [{id: 'revise', revision: 1, action: 'REVISE' as const,
              description: 'Ask AgentArts to evaluate this minimal dependency repair and revise affected plan content as needed; the candidate is not yet executed.',
              repair: candidate.request}] : []),
          ];
          if (prepareOptions) result.options = structuredClone([...await prepareOptions(structuredClone(result), context)]);
          active(context);
          if (result.options.length < 2 || result.options.length > 16) throw new ProtocolError('INVALID_ARGUMENT', 'Expected bounded cognition options');
          const seen = new Set<string>();
          for (const option of result.options) {
            if (!option || seen.has(option.id) || !['RECHECK', 'REVISE'].includes(option.action)
              || (trigger.kind === 'expiry' && (option.action !== 'RECHECK' || option.repair !== undefined))
              || Object.keys(option).some(key => !['id', 'revision', 'description', 'action', 'repair'].includes(key))) {
              throw new ProtocolError('INVALID_ARGUMENT', 'Invalid cognition option');
            }
            seen.add(option.id);
            if (option.repair) {
              if (option.action !== 'REVISE' || option.repair.expectedGraphRevision !== snapshot.revision
                || option.repair.changes.some(change => !scope.items.some(item =>
                  item.node.id === change.node.id && item.node.revision === change.node.revision))) {
                throw new ProtocolError('INVALID_ARGUMENT', 'Repair option exceeds affected scope');
              }
              previewStoredRepair({read: () => structuredClone(snapshot), append: () => { throw Error('Read-only preview'); }}, request.at, option.repair);
            }
          }
          result.selection = await chooser.choose({
            // Local-only source/plan excerpts help choose an approach. They do
            // not become a cloud payload; handoff.prepare separately controls egress.
            context: localDecisionContext(snapshot, scope.items),
            candidates: result.options.map(option => ({id: option.id, revision: option.revision, description: option.description,
              kind: 'escalate' as const, sources: [], scopeRef: key, expiresAt: request.deadline, risk: 'low' as const,
              argumentsDigest: actionArgumentsDigest({})})), ...context,
          });
          active(context);
          if (result.selection.state === 'selected') {
            const selected = result.options.find(option => option.id === result.selection!.selected?.id
              && option.revision === result.selection!.selected?.revision);
            if (selected) { result.action = selected.action; result.selectedOption = structuredClone(selected); }
          }
          const machineReview = uncertainRecheck(result);
          if (machineReview) result.machineReview = machineReview;
        }
        active(context);
        worker.saveCheckpoint(REVIEW, result);
        return {resultSummary: 'Laya approach recorded for AgentArts orchestration; no plan executed'};
      }, {deadline: request.deadline, sideEffect: 'read'});
      return handoffReview(task.taskId, request);
    } finally { controllers.delete(controller); request.signal.removeEventListener('abort', abort); }
  };
  return Object.freeze({
    consumeAndReview: async (request: MemoryReadContext & {at: string; limit: number; afterGraphRevision: number}) => {
      open(); active(request); evaluationTime(request.at);
      facts.listImpactReceipts({afterGraphRevision: request.afterGraphRevision, limit: request.limit});
      const consumed = await facts.consume({limit: request.limit, deadline: request.deadline, signal: request.signal});
      facts.processImpacts({at: request.at, limit: request.limit, deadline: request.deadline, signal: request.signal});
      const receipts = facts.listImpactReceipts({afterGraphRevision: request.afterGraphRevision, limit: request.limit});
      const reviews: ProactiveReviewReadback[] = [];
      let nextGraphRevision = request.afterGraphRevision;
      for (const receipt of receipts) {
        active(request);
        if (!receipt.completed) break;
        reviews.push(await review({kind: 'fact', input: {graphNamespace, projection: receipt.projection}}, request));
        nextGraphRevision = receipt.projection.graphRevision;
      }
      const hasMoreReviews = facts.listImpactReceipts({afterGraphRevision: nextGraphRevision, limit: 1}).length > 0;
      if (consumed.batch.atWatermark && !hasMoreReviews && reviews.length === 0) {
        const snapshot = store.read();
        const scope = expiredPublicFactScope(snapshot, request.at);
        if (scope.items.length) reviews.push(await review({kind: 'expiry', input: {
          graphRevision: snapshot.revision, facts: scope.facts,
          consumers: scope.items.map(item => item.node).sort((a, b) => refKey(a).localeCompare(refKey(b))),
        }}, request));
      }
      return {reviews, nextGraphRevision, atWatermark: consumed.batch.atWatermark, hasMoreReviews};
    },
    reviewGoalRevision: (input: GoalRevisionSelectionRequest, request: MemoryReadContext & {at: string}) =>
      review({kind: 'goal', input: structuredClone(input)}, request),
    readReview, handoffReview,
    close: () => { closed = true; for (const controller of controllers) controller.abort(); },
  });
}
