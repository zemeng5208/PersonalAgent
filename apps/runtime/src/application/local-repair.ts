import {isDeepStrictEqual} from 'node:util';
import {ProtocolError} from '@personal-agent/contracts';
import type {RegisteredTool, TaskSnapshot} from '@personal-agent/contracts';
import type {AgentToolPort} from '@personal-agent/agents';
import {parseCoordinationRepairCandidate} from '@personal-agent/coordination';
import type {CoordinationRepairCandidateResult} from '@personal-agent/coordination';
import {commitStoredRepair, previewStoredRepair} from '@personal-agent/cognition';
import type {FactRef, FactVersion, MemoryQueryPort} from '@personal-agent/memory';
import type {GraphSnapshot, NodeRef, NodeVersion} from '@personal-agent/goals';
import {toolArgumentsDigest} from '@personal-agent/tool-gateway';
import type {TaskRuntime} from '../index.js';

export const LOCAL_REPAIR_TOOL = 'cognition.commit_repair';
export const LOCAL_REPAIR_CHECKPOINT = 'local-repair-intent';

/** Captured at the original projection/export, never rebound to newer refs. */
export interface LocalRepairBinding {
  fact: FactRef;
  node: NodeRef;
  graphRevision: number;
  allowedTargets: NodeRef[];
  allowedDependencies: NodeRef[];
}

export interface LocalRepairHostOptions {
  graphNamespace: string;
  bindingVersion: string;
  sourceTool: {name: string; version: string; arguments: Record<string, unknown>};
  memory: MemoryQueryPort;
  /** Shared with trusted Fact ingestion and projection writes for this source. */
  withSourceLock<T>(work: () => Promise<T>): Promise<T>;
  resolveBinding(input: {sourceTaskId: string; evidenceId: string}): LocalRepairBinding;
  matchesSource(input: {result: unknown; fact: FactVersion; node: NodeVersion}): boolean;
}

export interface SubmitLocalRepairRequest {
  sourceTaskId: string;
  evidenceId: string;
  idempotencyKey: string;
  deadline: string;
}

interface LocalRepairIntent extends SubmitLocalRepairRequest {
  candidate: CoordinationRepairCandidateResult;
  binding: LocalRepairBinding;
  graphNamespace: string;
  bindingVersion: string;
  sourceTool: LocalRepairHostOptions['sourceTool'];
}

function denied(message = 'Local repair binding is invalid'): never {
  throw new ProtocolError('UNAUTHORIZED', message);
}

function active(deadline: string, signal: AbortSignal): void {
  if (signal.aborted) throw new ProtocolError('CANCELLED', 'Local repair cancelled');
  if (!Number.isFinite(Date.parse(deadline)) || Date.now() >= Date.parse(deadline)) {
    throw new ProtocolError('TIMEOUT', 'Local repair deadline expired');
  }
}

function sameRef(a: NodeRef, b: NodeRef): boolean { return a.id === b.id && a.revision === b.revision; }

function requireSource(runtime: TaskRuntime, intent: LocalRepairIntent): unknown {
  const source = runtime.getTask(intent.sourceTaskId);
  const record = runtime.readToolExecutions(intent.sourceTaskId).find(item => item.evidenceId === intent.evidenceId);
  if (source.state !== 'succeeded' || !source.evidenceRefs.includes(intent.evidenceId)
    || !record || record.taskId !== intent.sourceTaskId || record.toolName !== intent.sourceTool.name
    || record.toolVersion !== intent.sourceTool.version || record.state !== 'confirmed'
    || record.policyDecision !== 'allow' || !record.executionStarted
    || !runtime.matchesToolExecutionInput(record, {arguments: intent.sourceTool.arguments,
      scopeRef: intent.evidenceId})) denied();
  const approval = runtime.getApproval(intent.evidenceId);
  if (approval.state !== 'allowed' || approval.taskId !== intent.sourceTaskId
    || approval.toolName !== intent.sourceTool.name
    || approval.argumentsDigest !== toolArgumentsDigest(intent.sourceTool.arguments)) denied();
  const saved = runtime.loadCheckpoint(intent.sourceTaskId, 'tool-result-' + intent.evidenceId) as {result?: unknown} | undefined;
  if (!saved || !Object.hasOwn(saved, 'result')) denied();
  return saved.result;
}

/** Compile the entire immutable intent before starting a worker. */
export function prepareLocalRepair(
  runtime: TaskRuntime, host: LocalRepairHostOptions, request: SubmitLocalRepairRequest,
): TaskSnapshot {
  if (Object.keys(request).some(key => !['sourceTaskId', 'evidenceId', 'idempotencyKey', 'deadline'].includes(key))
    || Object.values(request).some(value => typeof value !== 'string' || !value.trim())
    || !Number.isFinite(Date.parse(request.deadline))) denied();
  const candidate = parseCoordinationRepairCandidate(runtime.loadCheckpoint(request.sourceTaskId, 'competition-repair-candidate'));
  const binding = structuredClone(host.resolveBinding({sourceTaskId: request.sourceTaskId, evidenceId: request.evidenceId}));
  const intent: LocalRepairIntent = {...request, candidate, binding,
    graphNamespace: host.graphNamespace, bindingVersion: host.bindingVersion, sourceTool: structuredClone(host.sourceTool)};
  requireSource(runtime, intent);
  const digest = toolArgumentsDigest(intent);
  const key = 'local-repair:' + request.idempotencyKey;
  const taskInput = {goal: 'Apply explicitly approved plan repair',
    conversationId: runtime.getTask(request.sourceTaskId).conversationId ?? 'local-repair',
    attachmentRefs: ['local-repair-intent:' + digest], idempotencyKey: key};
  const prior = runtime.findTaskByIdempotencyKey(key);
  if (prior) {
    const saved = runtime.loadCheckpoint(prior.taskId, LOCAL_REPAIR_CHECKPOINT);
    if (!prior.attachmentRefs?.includes('local-repair-intent:' + digest)
      || (saved !== undefined && toolArgumentsDigest(saved) !== digest)
      || (saved === undefined && prior.state !== 'created')) {
      throw new ProtocolError('REVISION_CONFLICT', 'Local repair intent conflict or missing checkpoint');
    }
    return saved === undefined
      ? runtime.submitTaskWithCheckpoint(taskInput, LOCAL_REPAIR_CHECKPOINT, intent)
      : prior;
  }
  validateSelection(intent, runtime.bindCoordinationStore(host.graphNamespace).read());
  return runtime.submitTaskWithCheckpoint(taskInput, LOCAL_REPAIR_CHECKPOINT, intent);
}

function validateSelection(intent: LocalRepairIntent, graph: GraphSnapshot): void {
  const {binding, candidate} = intent;
  if (!binding || graph.revision !== binding.graphRevision
    || candidate.candidate.expectedGraphRevision !== binding.graphRevision
    || !Array.isArray(binding.allowedTargets) || !Array.isArray(binding.allowedDependencies)) denied();
  for (const change of candidate.candidate.changes) {
    if (!binding.allowedTargets.some(ref => sameRef(ref, change.node))
      || change.dependencies.some(ref => !binding.allowedDependencies.some(allowed => sameRef(ref, allowed)))) denied('Repair candidate exceeds selected nodes');
    const original = graph.history.findLast(item => item.id === change.node.id);
    if (!original || !sameRef(original, change.node)
      || original.dependencies.length !== change.dependencies.length
      || original.dependencies.some(ref => !change.dependencies.some(next => next.id === ref.id))) {
      denied('Repair candidate changes the selected dependency identities');
    }
  }
}

export function createLocalRepairTool(getRuntime: () => TaskRuntime, host: LocalRepairHostOptions): RegisteredTool {
  return {
    descriptor: {
      name: LOCAL_REPAIR_TOOL, version: '1.0.0',
      inputSchema: {type: 'object', required: ['intentDigest'], additionalProperties: false,
        properties: {intentDigest: {type: 'string', pattern: '^[a-f0-9]{64}$'}}},
      outputSchema: {type: 'object', required: ['kind', 'graphRevision'], additionalProperties: false,
        properties: {kind: {enum: ['applied', 'rejected']}, graphRevision: {type: 'integer', minimum: 0}}},
      sideEffect: 'local_write', requiredScopes: ['cognition:repair'], idempotencySupport: true,
      recoverySupport: true, requiresPresence: false,
    },
    async execute(input, context) {
      const runtime = getRuntime();
      const intent = runtime.loadCheckpoint(context.taskId, LOCAL_REPAIR_CHECKPOINT) as LocalRepairIntent | undefined;
      if (!intent || (input as {intentDigest?: string}).intentDigest !== toolArgumentsDigest(intent)) denied();
      return host.withSourceLock(async () => {
      const store = runtime.bindCoordinationStore(intent.graphNamespace);
      // A pre-write rejection is a confirmed no-write result, not an unknown write.
      let fact: FactVersion;
      try {
        active(context.deadline, context.signal);
        const page = await host.memory.listCurrent({factId: intent.binding.fact.id,
          at: new Date().toISOString(), limit: 1, deadline: context.deadline, signal: context.signal});
        if (page.nextCursor || page.facts.length !== 1) denied();
        fact = page.facts[0]!;
        // No asynchronous operation is allowed from this guard through CAS/readback.
        active(context.deadline, context.signal);
        if (host.bindingVersion !== intent.bindingVersion || host.graphNamespace !== intent.graphNamespace
          || !isDeepStrictEqual(host.sourceTool, intent.sourceTool)
          || !isDeepStrictEqual(host.resolveBinding({sourceTaskId: intent.sourceTaskId, evidenceId: intent.evidenceId}), intent.binding)) denied();
        const sourceResult = requireSource(runtime, intent);
        const graph = store.read();
        if (graph.namespace !== intent.graphNamespace) denied();
        validateSelection(intent, graph);
        const node = graph.history.findLast(item => item.id === intent.binding.node.id);
        const now = Date.now();
        const grant = runtime.policy.get(context.authorizationRef);
        // Check revocation/expiry without consuming the already-used allow_once again.
        if (!grant || grant.taskId !== context.taskId || grant.toolName !== LOCAL_REPAIR_TOOL
          || Date.parse(grant.expiresAt) <= now || !grant.scopes.includes('cognition:repair')
          || grant.argumentsDigest !== toolArgumentsDigest(input)) denied();
        if (graph.revision !== intent.binding.graphRevision || !node || node.kind !== 'fact'
          || !sameRef(node, intent.binding.node) || !sameRef(fact.ref, intent.binding.fact)
          || fact.state !== 'active' || node.state !== 'active' || fact.confirmation === 'model_inference'
          || Date.parse(fact.validFrom) > now || Date.parse(fact.validUntil) <= now
          || fact.sourceRef !== 'tool-evidence:' + intent.evidenceId || node.sourceRef !== fact.sourceRef
          || node.summary !== fact.summary || node.validFrom !== fact.validFrom || node.validUntil !== fact.validUntil
          || host.matchesSource({result: structuredClone(sourceResult), fact: structuredClone(fact), node: structuredClone(node)}) !== true) denied();
        previewStoredRepair(store, new Date(now).toISOString(), intent.candidate.candidate);
        active(context.deadline, context.signal);
      } catch {
        return {kind: 'rejected', graphRevision: store.read().revision};
      }
      // Synchronous CAS followed by durable version readback. If the process dies
      // here, Runtime's already-persisted started record prevents automatic replay.
      const result = commitStoredRepair(store, new Date().toISOString(), intent.candidate.candidate);
      if (result.kind !== 'applied') return {kind: 'rejected', graphRevision: result.currentGraphRevision};
      if (!isDeepStrictEqual(store.read(result.snapshot.revision), result.snapshot)) {
        throw new ProtocolError('RESULT_UNKNOWN', 'Repair commit requires reconciliation');
      }
      return {kind: 'applied', graphRevision: result.snapshot.revision};
      });
    },
  };
}

export function startLocalRepairTask(
  runtime: TaskRuntime, tools: AgentToolPort, taskId: string, resume = false,
): Promise<TaskSnapshot> {
  const intent = runtime.loadCheckpoint(taskId, LOCAL_REPAIR_CHECKPOINT) as LocalRepairIntent | undefined;
  if (!intent) throw new ProtocolError('NOT_FOUND', 'Local repair intent is missing');
  return runtime.runTask(taskId, async context => {
    const runId = 'local-repair-' + taskId;
    const result = await tools.invoke({taskId, runId, authorizationRef: runId,
      toolName: LOCAL_REPAIR_TOOL, toolVersion: '1.0.0', arguments: {intentDigest: toolArgumentsDigest(intent)},
      deadline: context.deadline, signal: context.signal});
    if (result.state === 'pending') return {resultSummary: 'Local plan repair awaits approval', evidenceRefs: result.evidenceRefs};
    if (result.state === 'unknown') return {resultSummary: 'Local plan repair requires reconciliation', evidenceRefs: result.evidenceRefs};
    if ((result.result as {kind?: string})?.kind !== 'applied') {
      throw new ProtocolError('REVISION_CONFLICT', 'Local repair source, scope or graph changed; no write performed');
    }
    return {resultSummary: 'Approved local plan repair committed and read back', evidenceRefs: result.evidenceRefs};
  }, {deadline: intent.deadline, sideEffect: 'local_write', ...(resume ? {resume: true} : {})});
}
