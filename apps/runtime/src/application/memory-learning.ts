import {createHash} from 'node:crypto';
import {ProtocolError} from '@personal-agent/contracts';
import type {SqliteLearningHost, LearningContext, WorkflowVersion} from '@personal-agent/learning';
import type {MemoryReadContext} from '@personal-agent/memory';
import type {SqliteMemoryHost, FactErasureMarker} from '@personal-agent/memory/sqlite';
import type {TaskRuntime} from '../index.js';
import type {SqliteFactProjectionHost} from './sqlite-fact-projection.js';

export const LEARNING_BINDING_CHECKPOINT = 'learning:binding:v1';
const SKILL_CHECKPOINT = 'skill:workspace-reference-summary:v1';
const ID = 'workspace-reference-summary';
const VERSION = '1.0.0';
const TOOL = 'mcp.workspace.read_text';
const STEPS = ['read-reference', 'summarize-reference'];
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
function fail(code: string, message: string): never { throw new ProtocolError(code, message); }

function active(context: LearningContext): void {
  if (!context.signal || typeof context.signal.aborted !== 'boolean'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(context.deadline)
    || !Number.isFinite(Date.parse(context.deadline))) fail('INVALID_ARGUMENT', 'Invalid learning context');
  if (context.signal.aborted) fail('CANCELLED', 'Learning action cancelled');
  if (Date.parse(context.deadline) <= Date.now()) fail('TIMEOUT', 'Learning action expired');
}

export interface LearningSkillManifest {
  readonly id: string;
  readonly version: string;
  readonly digest: string;
  readonly steps: readonly string[];
  readonly capabilities: readonly {toolName: string; toolVersion: string; sideEffect: string}[];
}
export interface LearningTaskBinding {
  readonly purpose: 'validation' | 'execution';
  readonly namespace: string;
  readonly workflowId: string;
  readonly revision: number;
  readonly skillId: string;
  readonly version: string;
  readonly digest: string;
  readonly path: string;
  readonly operationId: string;
}
export interface WorkflowLearningOptions {
  readonly profile: 'huawei_ict_agentarts';
  readonly namespace: string;
  /** Dedicated existing Runtime conversation for bounded task cancellation; defaults to learning:<namespace>. */
  readonly conversationId?: string;
  readonly learning: SqliteLearningHost;
  readonly runtime: TaskRuntime;
  readonly skillManifest: () => LearningSkillManifest;
  /** Existing Runtime dispatch. Atomically bind LEARNING_BINDING_CHECKPOINT BEFORE starting the worker. */
  readonly submitSkillTask: (binding: LearningTaskBinding, context: LearningContext) => string | Promise<string>;
  /** Trusted host/native decision, separately obtained after validation. */
  readonly confirmActivation: (binding: LearningTaskBinding & {expectedActiveRevision: number | null;
    evidenceRef: string}) => Promise<boolean>;
  readonly confirmDeletion: (workflow: WorkflowVersion) => Promise<boolean>;
}

/** No new loop, scheduler, tool invocation or authorization grant. */
export function createWorkflowLearningApplication(options: WorkflowLearningOptions) {
  if (options.profile !== 'huawei_ict_agentarts' || !options.namespace?.trim()) {
    fail('INVALID_ARGUMENT', 'Competition learning scope is required');
  }
  const {namespace, learning, runtime} = options;
  const conversationId = options.conversationId ?? `learning:${namespace}`;
  const manifest = () => {
    const value = structuredClone(options.skillManifest());
    if (value.id !== ID || value.version !== VERSION || !/^[a-f0-9]{64}$/.test(value.digest)
      || !same(value.steps, STEPS)
      || !same(value.capabilities, [{toolName: TOOL, toolVersion: VERSION, sideEffect: 'read'}])) {
      fail('UNSUPPORTED_CAPABILITY', 'Only the fixed reference summary Skill is supported');
    }
    return value;
  };
  const bindingFor = (candidate: WorkflowVersion, purpose: LearningTaskBinding['purpose'], operationId: string): LearningTaskBinding => {
    const current = manifest();
    let source: {skillId: string; version: string; digest: string; path: string};
    try { source = JSON.parse(candidate.sourceRef); }
    catch { return fail('PROTOCOL_MISMATCH', 'Workflow has no fixed Skill binding'); }
    if (Object.keys(source).sort().join(',') !== 'digest,path,skillId,version'
      || source.skillId !== current.id || source.version !== current.version || source.digest !== current.digest
      || typeof source.path !== 'string' || !source.path.trim() || source.path.length > 480
      || /^(?:[A-Za-z]:|[\\/])/.test(source.path) || source.path.split(/[\\/]/).includes('..')
      || !same(candidate.steps, current.steps)) {
      fail('PROTOCOL_MISMATCH', 'Workflow Skill version, digest or scope changed');
    }
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(operationId)) fail('INVALID_ARGUMENT', 'Invalid learning operation ID');
    return {purpose, namespace, workflowId: candidate.workflowId, revision: candidate.revision,
      ...source, operationId};
  };
  const verify = (candidate: WorkflowVersion, taskId: string): string => {
    const saved = runtime.loadCheckpoint(taskId, LEARNING_BINDING_CHECKPOINT) as LearningTaskBinding | undefined;
    if (!saved || !same(saved, bindingFor(candidate, 'validation', saved.operationId))) {
      fail('REVISION_CONFLICT', 'Validation task belongs to another workflow or revision');
    }
    if (runtime.getTask(taskId).state !== 'succeeded') fail('NOT_VALIDATED', 'Validation task has not succeeded');
    const checkpoint = runtime.loadCheckpoint(taskId, SKILL_CHECKPOINT) as {
      binding?: string; phase?: string; read?: {path: string; text: string; contentDigest: string};
      evidenceRefs?: string[]; outcome?: {state: string; evidenceRefs: string[];
        sources?: {path: string; contentDigest: string}[]};
    } | undefined;
    const skillBinding = JSON.stringify({taskId, skillId: saved.skillId,
      version: saved.version, digest: saved.digest, path: saved.path});
    const read = checkpoint?.read;
    const runId = `skill-read-${taskId}-${saved.digest.slice(0, 16)}`;
    if (checkpoint?.binding !== skillBinding || checkpoint.phase !== 'complete'
      || checkpoint.outcome?.state !== 'confirmed' || !read || read.path !== saved.path
      || typeof read.text !== 'string' || hash(read.text) !== read.contentDigest
      || !same(checkpoint.outcome.sources, [{path: saved.path, contentDigest: read.contentDigest}])
      || !same(checkpoint.evidenceRefs, [runId]) || !same(checkpoint.outcome.evidenceRefs, [runId])) {
      fail('NOT_VALIDATED', 'Skill checkpoint does not contain a confirmed bound source');
    }
    const records = runtime.readToolExecutions(taskId);
    const record = records.find(item => item.evidenceId === runId);
    const result = runtime.loadCheckpoint(taskId, `tool-result-${runId}`) as {
      result?: {path?: string; text?: string; contentDigest?: string; source?: string};
    } | undefined;
    if (records.length !== 1 || !record || record.state !== 'confirmed' || !record.executionStarted
      || record.policyDecision !== 'allow' || record.toolName !== TOOL || record.toolVersion !== VERSION
      || !runtime.matchesToolExecutionInput(record, {arguments: {path: saved.path}, scopeRef: runId})
      || result?.result?.source !== 'mcp' || result.result.path !== saved.path
      || result.result.text !== read.text || result.result.contentDigest !== read.contentDigest
      || !runtime.readEvidence(taskId).some(item => item.evidenceId === runId)) {
      fail('NOT_VALIDATED', 'Validation needs the matching Runtime tool record and Evidence');
    }
    return `learning-task:${taskId}:${hash(JSON.stringify(saved))}`;
  };
  const submit = async (candidate: WorkflowVersion, purpose: LearningTaskBinding['purpose'], operationId: string,
    context: LearningContext): Promise<{taskId: string; state: string; revision: number}> => {
    active(context);
    const binding = bindingFor(candidate, purpose, operationId);
    const taskId = await options.submitSkillTask(structuredClone(binding), context);
    active(context);
    if (typeof taskId !== 'string' || !same(runtime.loadCheckpoint(taskId, LEARNING_BINDING_CHECKPOINT), binding)) {
      fail('REVISION_CONFLICT', 'Dispatch did not persist the exact learning binding');
    }
    return {taskId, state: runtime.getTask(taskId).state, revision: candidate.revision};
  };
  return Object.freeze({
    /** Call at worker dispatch/resume and step boundaries, including after approval. */
    assertDispatchBinding(binding: LearningTaskBinding) {
      if (binding.namespace !== namespace) fail('SCOPE_DENIED', 'Learning namespace differs');
      const candidate = learning.readVersion(namespace, binding.workflowId, binding.revision);
      if (!same(binding, bindingFor(candidate, binding.purpose, binding.operationId))) {
        fail('REVISION_CONFLICT', 'Learning dispatch binding changed');
      }
      if (binding.purpose === 'execution'
        && (candidate.validation !== 'passed'
          || learning.readActive(namespace, binding.workflowId)?.revision !== binding.revision)) {
        fail('NOT_VALIDATED', 'Workflow is no longer active');
      }
      if (!['validation', 'execution'].includes(binding.purpose)) fail('INVALID_ARGUMENT', 'Invalid learning purpose');
      return candidate;
    },
    propose(request: LearningContext & {workflowId: string; expectedRevision: number | null;
      operationId: string; summary: string; path: string; createdAt: string}) {
      active(request);
      const current = manifest();
      const sourceRef = JSON.stringify({skillId: current.id, version: current.version,
        digest: current.digest, path: request.path});
      // Validate scope before persisting descriptive material; no candidate-selected tools.
      bindingFor({namespace, workflowId: request.workflowId, revision: 1,
        summary: request.summary, sourceRef, createdAt: request.createdAt,
        steps: current.steps, validation: 'candidate'}, 'validation', request.operationId);
      return learning.propose({namespace, workflowId: request.workflowId,
        expectedRevision: request.expectedRevision, operationId: request.operationId,
        summary: request.summary, sourceRef, steps: current.steps, createdAt: request.createdAt,
        deadline: request.deadline, signal: request.signal});
    },
    startValidation(request: LearningContext & {workflowId: string; revision: number; operationId: string}) {
      const candidate = learning.readVersion(namespace, request.workflowId, request.revision);
      if (candidate.validation !== 'candidate') fail('REVISION_CONFLICT', 'Propose a new candidate instead of repeating validation');
      return submit(candidate, 'validation', request.operationId, request);
    },
    async validate(request: LearningContext & {workflowId: string; revision: number; taskId: string}) {
      active(request);
      const candidate = learning.readVersion(namespace, request.workflowId, request.revision);
      const saved = runtime.loadCheckpoint(request.taskId, LEARNING_BINDING_CHECKPOINT) as LearningTaskBinding | undefined;
      if (!saved || !same(saved, bindingFor(candidate, 'validation', saved.operationId))) {
        fail('REVISION_CONFLICT', 'Validation task identity does not match');
      }
      // Pending/unknown is a pending state, not a failed assessment or a retry trigger.
      const task = runtime.getTask(request.taskId);
      if (!['succeeded', 'failed', 'cancelled'].includes(task.state)) {
        return {state: 'pending', taskId: task.taskId, taskState: task.state as string};
      }
      const validator = {validate: async () => {
        if (task.state !== 'succeeded') return {passed: false, evidenceRef: `learning-task:${task.taskId}:failed`};
        return {passed: true, evidenceRef: verify(candidate, task.taskId)};
      }};
      return {state: 'validated', version: await learning.validate(namespace, request.workflowId,
        request.revision, validator, request)};
    },
    async activate(request: LearningContext & {workflowId: string; revision: number;
      expectedActiveRevision: number | null; operationId: string; activatedAt: string}) {
      request = {workflowId: request.workflowId, revision: request.revision,
        expectedActiveRevision: request.expectedActiveRevision, operationId: request.operationId,
        activatedAt: request.activatedAt, deadline: request.deadline, signal: request.signal};
      active(request);
      const candidate = learning.readVersion(namespace, request.workflowId, request.revision);
      const binding = bindingFor(candidate, 'execution', request.operationId);
      if (candidate.validation !== 'passed' || !candidate.evidenceRef) fail('NOT_VALIDATED', 'Workflow is not validated');
      const taskMatch = /^learning-task:([^:]+):[a-f0-9]{64}$/.exec(candidate.evidenceRef);
      if (!taskMatch || verify(candidate, taskMatch[1]!) !== candidate.evidenceRef) fail('NOT_VALIDATED', 'Validation evidence is unavailable');
      if ((learning.readActive(namespace, request.workflowId)?.revision ?? null) !== request.expectedActiveRevision) {
        fail('REVISION_CONFLICT', 'Active workflow changed');
      }
      if (await options.confirmActivation({...binding, expectedActiveRevision: request.expectedActiveRevision,
        evidenceRef: candidate.evidenceRef}) !== true) return {state: 'declined'};
      active(request);
      bindingFor(candidate, 'execution', request.operationId);
      return {state: 'activated', receipt: learning.activateVersion({...request, namespace})};
    },
    run(request: LearningContext & {workflowId: string; revision: number; operationId: string}) {
      const selected = learning.readActive(namespace, request.workflowId);
      if (!selected || selected.revision !== request.revision || selected.validation !== 'passed') {
        fail('NOT_VALIDATED', 'Requested version is not the active validated workflow');
      }
      return submit(selected, 'execution', request.operationId, request);
    },
    readVersion(workflowId: string, revision: number) { return learning.readVersion(namespace, workflowId, revision); },
    readActive(workflowId: string) { return learning.readActive(namespace, workflowId); },
    async erase(request: LearningContext & {workflowId: string; expectedRevision: number; operationId: string}) {
      request = {workflowId: request.workflowId, expectedRevision: request.expectedRevision,
        operationId: request.operationId, deadline: request.deadline, signal: request.signal};
      active(request);
      const candidate = learning.readVersion(namespace, request.workflowId, request.expectedRevision);
      if (await options.confirmDeletion(structuredClone(candidate)) !== true) return {state: 'declined'};
      active(request);
      let beforeSequence: number | undefined;
      let snapshotSequence: number | undefined;
      for (;;) {
        const page = runtime.listTasks({conversationId, limit: 100,
          ...(beforeSequence === undefined ? {} : {beforeSequence}),
          ...(snapshotSequence === undefined ? {} : {snapshotSequence})});
        for (const task of page.items) {
          const binding = runtime.loadCheckpoint(task.taskId, LEARNING_BINDING_CHECKPOINT) as LearningTaskBinding | undefined;
          if (binding?.namespace === namespace && binding.workflowId === request.workflowId
            && !['succeeded', 'failed', 'cancelled'].includes(task.state)) runtime.requestCancel(task.taskId);
        }
        if (page.nextBeforeSequence === undefined) break;
        beforeSequence = page.nextBeforeSequence;
        snapshotSequence = page.snapshotSequence;
      }
      learning.eraseWorkflow({...request, namespace});
      if (learning.readActive(namespace, request.workflowId) !== null) fail('EXTERNAL_FAILURE', 'Learning deletion readback failed');
      return {state: 'deleted', coverage: 'active_learning_database'};
    },
  });
}

/** Recover only authorized durable public erasure intents; private facts remain unbound. */
export function createBoundPublicFactErasureApplication(options: {
  profile: 'huawei_ict_agentarts'; memory: SqliteMemoryHost; runtime: TaskRuntime;
  projection: SqliteFactProjectionHost; memoryNamespace: string; graphNamespace: string;
  confirm: (ref: {id: string; revision: number}) => Promise<boolean>;
}) {
  const {memory, runtime, projection, memoryNamespace, graphNamespace} = options;
  if (options.profile !== 'huawei_ict_agentarts' || memoryNamespace === 'desktop-private'
    || !memoryNamespace?.trim() || !graphNamespace?.trim()) fail('INVALID_ARGUMENT', 'Explicit public erasure binding is required');
  const store = runtime.provisionFactProjectionStore(graphNamespace);
  const resume = async (marker: FactErasureMarker, context: MemoryReadContext) => {
    active(context);
    const receipt = store.readErasureReceipt(memoryNamespace, marker.factId);
    if (receipt && receipt.operationId !== marker.operationId) fail('REVISION_CONFLICT', 'Erasure receipt identity changed');
    if (marker.phase === 'completed') {
      if (!receipt) fail('REVISION_CONFLICT', 'Public erasure has no Runtime receipt');
      store.checkpointErasureWal();
      memory.resumeCompletedErasureMaintenance(memoryNamespace);
      return;
    }
    const expectedGraphRevision = receipt?.expectedGraphRevision
      ?? (await projection.preflightErasure(marker.factId, context)).graphRevision;
    await projection.resumeFactErasure({factId: marker.factId, expectedRevision: marker.expectedRevision,
      operationId: marker.operationId, expectedGraphRevision, ...context});
    const visible = await memory.bind(memoryNamespace, {allowedSensitivities: ['public']})
      .listHistory({factId: marker.factId, limit: 1, ...context});
    if (visible.facts.length) fail('EXTERNAL_FAILURE', 'Erasure history readback failed');
  };
  return Object.freeze({
    async erase(request: MemoryReadContext & {factId: string; expectedRevision: number; operationId: string}) {
      request = {factId: request.factId, expectedRevision: request.expectedRevision,
        operationId: request.operationId, deadline: request.deadline, signal: request.signal};
      active(request);
      const current = await memory.bind(memoryNamespace, {allowedSensitivities: ['public']})
        .listCurrent({factId: request.factId, at: new Date().toISOString(), limit: 1,
          deadline: request.deadline, signal: request.signal});
      if (current.facts[0]?.ref.revision !== request.expectedRevision) fail('REVISION_CONFLICT', 'Public fact head changed');
      if (await options.confirm({id: request.factId, revision: request.expectedRevision}) !== true) return {state: 'declined'};
      memory.beginFactErasure(memoryNamespace, request);
      await resume({factId: request.factId, expectedRevision: request.expectedRevision,
        operationId: request.operationId, phase: 'pending'}, request);
      return {state: 'deleted', coverage: 'bound_memory_runtime_databases'};
    },
    async reconcile(context: MemoryReadContext) {
      let afterFactId: string | undefined;
      const pending: {factId: string; code: string}[] = [];
      let completed = 0;
      for (;;) {
        active(context);
        const markers = memory.listFactErasures(memoryNamespace, {limit: 100, ...context,
          ...(afterFactId ? {afterFactId} : {})});
        for (const marker of markers) {
          try { await resume(marker, context); completed++; }
          catch (error) {
            if (context.signal.aborted || Date.parse(context.deadline) <= Date.now()) throw error;
            pending.push({factId: marker.factId, code: typeof (error as {code?: unknown})?.code === 'string'
              ? (error as {code: string}).code : 'EXTERNAL_FAILURE'});
          }
        }
        if (markers.length < 100) return {state: pending.length ? 'pending' : 'reconciled', completed, pending};
        afterFactId = markers.at(-1)!.factId;
      }
    },
  });
}
