import {ProtocolError} from '@personal-agent/contracts';
import type {RegisteredTool, TaskSnapshot, ToolContext} from '@personal-agent/contracts';
import {
  createSubagentDispatchTool,
  dispatchSubtasks,
  DEFAULT_ROLE_LABELS,
  computeSubtaskInputDigest,
  SUBAGENT_DISPATCH_TOOL_NAME,
  SUBAGENT_DISPATCH_TOOL_VERSION,
  type AgentWorkerContext,
  type AgentToolPort,
  type SubtaskDefinition,
  type SubtaskExecutionSummary,
  type SubtaskProgress,
  type SubtaskProgressRecord,
} from '@personal-agent/agents';
import {runAgent} from '@personal-agent/agents';
import {
  ModelGateway,
  FakeModelProvider,
  PanguModelProvider,
  type ModelMessage,
  type ModelRequest,
  type PanguModelProviderOptions,
  type ReasoningEffort,
  StructuredToolProvider,
  OpenAICompatibleModelProvider,
  type ModelProvider,
} from '@personal-agent/models';
import {toolArgumentsDigest} from '@personal-agent/tool-gateway';
import type {TaskRuntime, WorkerContext, WorkerResult, SubmitTaskInput} from '../index.js';

export {SUBAGENT_DISPATCH_TOOL_NAME, SUBAGENT_DISPATCH_TOOL_VERSION};

export interface ConfiguredSubagentModelOptions {
  profile?: 'huawei_ict_agentarts';
  provider: 'pangu' | 'openai-compatible';
  baseUrl: string;
  model: string;
  deployment: string;
  apiKey: () => string | Promise<string>;
}

/** Runtime composition only; Desktop injects credentials, never imports providers. */
export function createConfiguredSubagentModelGateway(
  config: ConfiguredSubagentModelOptions,
  decorateProvider?: (provider: ModelProvider) => ModelProvider,
): ModelGateway {
  if (config.profile !== undefined && config.profile !== 'huawei_ict_agentarts') {
    throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'Subagent model profile is unavailable');
  }
  if (config.provider !== 'pangu' && config.provider !== 'openai-compatible') {
    throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'Subagent model provider is unavailable');
  }
  const Provider = config.provider === 'pangu' ? PanguModelProvider : OpenAICompatibleModelProvider;
  const provider = new StructuredToolProvider(new Provider(config));
  return new ModelGateway(decorateProvider ? decorateProvider(provider) : provider);
}

export interface SubagentHostOptions {
  getRuntime: () => TaskRuntime;
  getTools?: (() => AgentToolPort | undefined) | undefined;
  getModelGateway?: ((modelName?: string) => ModelGateway | undefined) | undefined;
  /** Only explicitly supported provider parameters; step budgets are separate. */
  getModelReasoningEfforts?: ((modelName?: string) => readonly ReasoningEffort[]) | undefined;
  now?: (() => number) | undefined;
  maxRecursionDepth?: number | undefined;
}

type ChildBinding = SubtaskDefinition & {parentTaskId: string; parentDeadline: string};
function childBinding(runtime: TaskRuntime, taskId: string): ChildBinding {
  const binding = runtime.loadCheckpoint(taskId, 'subtask-parent') as ChildBinding | undefined;
  if (!binding || typeof binding.parentTaskId !== 'string' || !binding.parentTaskId.trim()
    || typeof binding.subtaskId !== 'string' || !binding.subtaskId.trim()
    || typeof binding.goal !== 'string' || !binding.goal.trim() || !Object.hasOwn(DEFAULT_ROLE_LABELS, binding.role)
    || (binding.roleLabel !== undefined && typeof binding.roleLabel !== 'string')
    || typeof binding.parentDeadline !== 'string' || !Number.isFinite(Date.parse(binding.parentDeadline))
    || (binding.model !== undefined && typeof binding.model !== 'string')
    || (binding.thinkingDepth !== undefined && (!Number.isInteger(binding.thinkingDepth)
      || binding.thinkingDepth < 0 || binding.thinkingDepth > 5))) {
    throw new ProtocolError('INVALID_ARGUMENT', 'Invalid persisted subagent binding');
  }
  const task = runtime.getTask(taskId);
  const roleLabel = binding.roleLabel?.trim() || DEFAULT_ROLE_LABELS[binding.role];
  if (task.conversationId !== `desktop-subtask:${binding.parentTaskId}`
    || task.goal !== `[${roleLabel}] ${binding.goal}`
    || runtime.findTaskByIdempotencyKey(`subagent-dispatch-${binding.parentTaskId}-${binding.subtaskId}`)?.taskId !== taskId) {
    throw new ProtocolError('REVISION_CONFLICT', 'Subagent binding does not match the persisted task');
  }
  return binding;
}

async function runSubagentWorker(options: SubagentHostOptions, subtask: SubtaskDefinition,
  childWorker: WorkerContext): Promise<WorkerResult> {
  if (childWorker.signal.aborted) throw new ProtocolError('CANCELLED', 'Subtask cancelled during execution');
  const runtime = options.getRuntime();
  const roleLabel = subtask.roleLabel?.trim() || DEFAULT_ROLE_LABELS[subtask.role];
  childWorker.reportProgress({stepId: `child-${subtask.subtaskId}`, label: `[${roleLabel}] 正在执行: ${subtask.goal}`});
  const model = options.getModelGateway?.(subtask.model);
  if (!model) {
    const modelLabel = subtask.model ? `模型 ${subtask.model}` : '默认模型';
    throw new ProtocolError('UNSUPPORTED_CAPABILITY',
      `子任务无法执行：${modelLabel} 未配置或不受支持。请在受信设置中配置模型后重试`);
  }
  const identity = {provider: model.deployment.provider, deployment: model.deployment.deployment, model: model.deployment.model};
  const previousIdentity = childWorker.loadCheckpoint('subtask-model-binding') as typeof identity | undefined;
  const pendingLoop = childWorker.loadCheckpoint('agent-loop') as {pending?: import('@personal-agent/models').ModelResult} | undefined;
  const expected = previousIdentity ?? pendingLoop?.pending?.deployment;
  if (expected && (expected.provider !== identity.provider || expected.deployment !== identity.deployment || expected.model !== identity.model)) {
    throw new ProtocolError('REVISION_CONFLICT', 'Subagent model configuration changed; the prior proposal cannot be resumed');
  }
  if (!previousIdentity) childWorker.saveCheckpoint('subtask-model-binding', identity);
  const effortLevels: ReasoningEffort[] = ['none', 'low', 'low', 'medium', 'high', 'high'];
  const requestedEffort = subtask.thinkingDepth === undefined ? undefined : effortLevels[subtask.thinkingDepth];
  const reasoningEffort = requestedEffort !== undefined
    && options.getModelReasoningEfforts?.(subtask.model).includes(requestedEffort) ? requestedEffort : undefined;
  const maxSteps = subtask.thinkingDepth !== undefined ? Math.max(2, (subtask.thinkingDepth + 1) * 2) : 6;
  childWorker.saveCheckpoint('subtask-thinking-binding', {depth: subtask.thinkingDepth ?? null,
    stepBudget: {maxSteps}, modelReasoning: {requestedEffort: requestedEffort ?? null,
      effort: reasoningEffort ?? null, supported: reasoningEffort !== undefined,
      verification: 'conditional', thinkingBudgetSupported: false,
      reason: reasoningEffort !== undefined ? 'Trusted host explicitly configured this reasoning_effort'
        : requestedEffort === undefined ? 'No native reasoning effort selected' : 'Selected effort is not configured for this model'}});
  const rolePrompt: ModelMessage = {role: 'system',
    content: `你是专业次级智能体，当前承担职责为【${roleLabel}】(${subtask.role})。请聚焦于此职责，独立执行指派的目标。`};
  const outcome = await runAgent(childWorker, {goal: subtask.goal, initialMessages: [rolePrompt], model,
    tools: options.getTools?.() ?? {list: () => [], invoke: async () => {throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'No tools');}},
    maxSteps,
    ...(reasoningEffort === undefined ? {} : {reasoningEffort}),
    onUnknownResult: () => {
      if (runtime.getTask(childWorker.taskId).state === 'running') runtime.transitionTask(childWorker.taskId, 'waiting_reconciliation');
    },
  });
  if (outcome.status === 'waiting_approval' && runtime.getTask(childWorker.taskId).state === 'running') {
    // This is a wait state only; no approval or grant is issued by the model/worker.
    runtime.transitionTask(childWorker.taskId, 'waiting_approval');
  }
  return {resultSummary: outcome.resultSummary, evidenceRefs: outcome.evidenceRefs};
}

/** Reuse the exact child and pending agent invocation after trusted approval. */
export async function resumeRuntimeSubagentTask(options: SubagentHostOptions, childTaskId: string,
  parentSignal?: AbortSignal): Promise<TaskSnapshot> {
  const runtime = options.getRuntime();
  const binding = childBinding(runtime, childTaskId);
  const child = runtime.getTask(childTaskId);
  if (['succeeded', 'failed', 'cancelled'].includes(child.state)) return child;
  const parent = runtime.getTask(binding.parentTaskId);
  if (parent.cancelRequested || parentSignal?.aborted) {
    runtime.requestCancel(childTaskId, 'Parent task cancelled');
    return runtime.getTask(childTaskId);
  }
  if (['succeeded', 'failed', 'cancelled'].includes(parent.state) || child.state !== 'waiting_approval') {
    throw new ProtocolError('REVISION_CONFLICT', 'Subagent is not resumable for this parent');
  }
  const loop = runtime.loadCheckpoint(childTaskId, 'agent-loop') as {step?: number; pending?: import('@personal-agent/models').ModelResult} | undefined;
  if (!Number.isSafeInteger(loop?.step) || (loop?.step ?? 0) < 1 || !loop?.pending || loop.pending.response.kind !== 'tool_proposal') {
    throw new ProtocolError('NOT_FOUND', 'Subagent has no pending agent invocation');
  }
  const runId = `agent-run-${childTaskId}-${loop.step}`;
  const approval = runtime.getApproval(runId);
  if (approval.taskId !== childTaskId || approval.state !== 'allowed'
    || approval.toolName !== loop.pending.response.proposal.toolName
    || approval.argumentsDigest !== toolArgumentsDigest(loop.pending.response.proposal.arguments)
    || !runtime.policy.get(runId)) {
    throw new ProtocolError('UNAUTHORIZED', 'Subagent invocation is not approved or grant was revoked');
  }
  const cancel = () => {
    try {runtime.requestCancel(childTaskId, 'Parent task cancelled');}
    catch { /* A terminal child cannot be cancelled or reopened. */ }
  };
  parentSignal?.addEventListener('abort', cancel, {once: true});
  try {
    return await runtime.runTask(childTaskId, worker => runSubagentWorker(options, binding, worker),
      {deadline: binding.parentDeadline, sideEffect: 'read', resume: true});
  } finally {parentSignal?.removeEventListener('abort', cancel);}
}

/** Read-only aggregation from persistent children; never reopens a terminal parent. */
export function readRuntimeSubagentSummary(runtime: TaskRuntime, parentTaskId: string,
  definitions?: readonly SubtaskDefinition[]): SubtaskExecutionSummary & {summary: string} {
  const records = runtime.loadCheckpoint(parentTaskId, 'subtask-progress-records') as Record<string, SubtaskProgressRecord> | undefined;
  const subtasks = definitions ?? Object.values(records ?? {}).map(record => {
    try {
      const definition = JSON.parse(record.inputDigest) as SubtaskDefinition;
      // The digest normalizes text; the record retains the actual dispatch identity.
      return {...definition, subtaskId: record.subtaskId};
    }
    catch {throw new ProtocolError('INVALID_ARGUMENT', 'Invalid subtask progress binding');}
  });
  const progress: SubtaskProgress[] = subtasks.map(subtask => {
    const record = records?.[subtask.subtaskId];
    if (record && (record.parentTaskId !== parentTaskId || record.inputDigest !== computeSubtaskInputDigest(subtask))) {
      throw new ProtocolError('REVISION_CONFLICT', 'Subtask input changed from the persisted dispatch');
    }
    const child = runtime.findTaskByIdempotencyKey(`subagent-dispatch-${parentTaskId}-${subtask.subtaskId}`);
    const binding = child ? childBinding(runtime, child.taskId) : undefined;
    if (binding && computeSubtaskInputDigest(binding) !== computeSubtaskInputDigest(subtask)) {
      throw new ProtocolError('REVISION_CONFLICT', 'Subtask definition does not match the persistent child');
    }
    const roleLabel = binding?.roleLabel?.trim() || subtask.roleLabel?.trim() || DEFAULT_ROLE_LABELS[subtask.role];
    const state: SubtaskProgress['state'] = !child ? record?.state ?? 'pending'
      : ['succeeded', 'failed', 'cancelled'].includes(child.state) ? child.state as 'succeeded' | 'failed' | 'cancelled'
        : child.state === 'running' || child.state === 'cancelling' ? 'running' : 'pending';
    return {subtaskId: subtask.subtaskId, role: subtask.role, roleLabel, state,
      ...(state === 'succeeded' ? {result: child?.resultSummary ?? record?.result ?? ''} : {}),
      ...(state === 'failed' || state === 'cancelled' ? {error: child?.error?.message ?? record?.error ?? 'Subtask execution stopped'}
        : state === 'pending' || state === 'running' ? {error: `Subtask is ${child?.state ?? state}; execution is not complete`} : {}),
    };
  });
  const succeeded = progress.filter(item => item.state === 'succeeded').length;
  const failed = progress.filter(item => item.state === 'failed').length;
  const cancelled = progress.filter(item => item.state === 'cancelled').length;
  const pending = progress.length - succeeded - failed - cancelled;
  const summary = `## 次级智能体协作汇总（共 ${progress.length} 项：成功 ${succeeded}，失败 ${failed}，取消 ${cancelled}，未完成 ${pending}）\n\n`
    + progress.map(item => `### 【${item.roleLabel}】(${item.role}) · ${item.state}\n${item.result ?? item.error ?? ''}`).join('\n\n');
  return {total: progress.length, succeeded, failed, cancelled, subtasks: progress, aggregatedSummary: summary, summary};
}

export function createRuntimeSubagentDispatchTool(options: SubagentHostOptions): RegisteredTool {
  if (typeof options.getRuntime !== 'function') {
    throw new ProtocolError('INVALID_ARGUMENT', 'getRuntime must be a function');
  }

  const handler = async (
    input: {subtasks: readonly SubtaskDefinition[]},
    context: ToolContext,
  ): Promise<SubtaskExecutionSummary & {summary: string}> => {
    const runtime = options.getRuntime();
    if (!runtime) throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'Runtime is not available');

    // 1. 父任务检查与防无界递归
    const parentTask = runtime.getTask(context.taskId);
    if (!parentTask) throw new ProtocolError('NOT_FOUND', `Parent task ${context.taskId} not found`);

    if (parentTask.conversationId?.startsWith('desktop-subtask:')) {
      throw new ProtocolError('INVALID_ARGUMENT', 'Subagent recursive delegation is not allowed');
    }

    if (!Array.isArray(input.subtasks) || input.subtasks.length === 0) {
      throw new ProtocolError('INVALID_ARGUMENT', 'Subtasks must be a non-empty array');
    }
    if (input.subtasks.length > 10) {
      throw new ProtocolError('INVALID_ARGUMENT', 'Subtasks count cannot exceed 10');
    }

    // 2. 构造父任务 WorkerContext 桥接对象供 dispatchSubtasks 记录进度与检查点
    const workerBridge: AgentWorkerContext = {
      taskId: context.taskId,
      deadline: context.deadline,
      signal: context.signal,
      saveCheckpoint: (key: string, value: unknown) => {
        if (key === 'subtask-progress-records') {
          const records = structuredClone(value) as Record<string, SubtaskProgressRecord>;
          for (const record of Object.values(records)) {
            const child = runtime.findTaskByIdempotencyKey(`subagent-dispatch-${context.taskId}-${record.subtaskId}`);
            if (child && ['waiting_approval', 'waiting_reconciliation'].includes(child.state)) {
              record.state = 'pending'; delete record.result;
            }
          }
          runtime.saveCheckpoint(context.taskId, key, records);
        } else runtime.saveCheckpoint(context.taskId, key, value);
      },
      loadCheckpoint: (key: string) => runtime.loadCheckpoint(context.taskId, key),
      reportProgress: (progress) => runtime.recordProgress(context.taskId, progress),
    };

    // 3. 子任务真实执行器
    const executor = async (subtask: SubtaskDefinition, signal: AbortSignal): Promise<string> => {
      const idempotencyKey = `subagent-dispatch-${context.taskId}-${subtask.subtaskId}`;

      if (signal.aborted || context.signal.aborted) {
        throw new ProtocolError('CANCELLED', 'Subtask cancelled before execution');
      }

      const roleLabel = subtask.roleLabel?.trim()
        || (DEFAULT_ROLE_LABELS as Record<string, string>)[subtask.role]
        || String(subtask.role);

      // 4. 在 TaskRuntime 中创建并追踪真实子任务
      const existing = runtime.findTaskByIdempotencyKey(idempotencyKey);
      let taskSnapshot: TaskSnapshot;
      if (existing) {
        taskSnapshot = existing;
      } else {
        const subtaskInput: SubmitTaskInput = {
          conversationId: `desktop-subtask:${context.taskId}`,
          goal: `[${roleLabel}] ${subtask.goal}`,
          idempotencyKey,
        };
        taskSnapshot = runtime.submitTaskWithCheckpoint(
          subtaskInput,
          'subtask-parent',
          {
            parentTaskId: context.taskId,
            subtaskId: subtask.subtaskId,
            role: subtask.role,
            roleLabel,
            goal: subtask.goal,
            model: subtask.model,
            thinkingDepth: subtask.thinkingDepth,
            parentDeadline: context.deadline,
          },
        );
      }

      // 如果已在终态，直接读取
      if (['succeeded', 'failed', 'cancelled'].includes(taskSnapshot.state)) {
        if (taskSnapshot.state === 'cancelled') throw new ProtocolError('CANCELLED', 'Subtask was cancelled');
        if (taskSnapshot.state === 'failed') throw new Error(taskSnapshot.error?.message || taskSnapshot.resultSummary || 'Subtask execution failed');
        return taskSnapshot.resultSummary ?? '';
      }
      if (taskSnapshot.state !== 'created') {
        throw new ProtocolError('UNSUPPORTED_CAPABILITY', `Subtask is ${taskSnapshot.state}; execution is not complete`);
      }

      // 5. 使用 runtime.runTask 真实运行子任务并监听父级取消以联动取消子任务
      const childDeadline = context.deadline;
      const abortListener = () => {
        try {
          runtime.requestCancel(taskSnapshot.taskId, 'Parent task cancelled');
        } catch {
          // ignore if already terminal
        }
      };
      if (signal.aborted || context.signal.aborted) {
        abortListener();
      } else {
        signal.addEventListener('abort', abortListener, {once: true});
        context.signal.addEventListener('abort', abortListener, {once: true});
      }

      try {
        const outcome = await runtime.runTask(
          taskSnapshot.taskId,
          async (childWorker: WorkerContext) => {
            if (signal.aborted || childWorker.signal.aborted || context.signal.aborted) {
              throw new ProtocolError('CANCELLED', 'Subtask cancelled during execution');
            }
            return runSubagentWorker(options, subtask, childWorker);
          },
          {
            deadline: childDeadline,
            sideEffect: 'read',
          },
        );

        if (outcome.state === 'cancelled') {
          throw new ProtocolError('CANCELLED', 'Subtask was cancelled');
        }
        if (outcome.state === 'failed') {
          throw new Error(outcome.error?.message || outcome.resultSummary || 'Subtask execution failed');
        }

        if (outcome.state !== 'succeeded') {
          throw new ProtocolError('UNSUPPORTED_CAPABILITY', `Subtask is ${outcome.state}; execution is not complete`);
        }
        return outcome.resultSummary ?? '';
      } finally {
        signal.removeEventListener('abort', abortListener);
        context.signal.removeEventListener('abort', abortListener);
      }
    };

    await dispatchSubtasks(workerBridge, input.subtasks, executor);
    return readRuntimeSubagentSummary(runtime, context.taskId, input.subtasks);
  };

  return createSubagentDispatchTool(handler);
}

export interface DesktopSubagentDispatchToolOptions {
  getRuntime: () => TaskRuntime;
  getTools?: (() => AgentToolPort | undefined) | undefined;
  fakeModelMode?: boolean;
  /** Trusted host selection. An unknown name must return undefined, never default. */
  getModelGateway?: ((modelName?: string) => ModelGateway | undefined) | undefined;
  getModelReasoningEfforts?: ((modelName?: string) => readonly ReasoningEffort[]) | undefined;
  modelConfig?: {
    baseUrl?: string;
    model?: string;
    deployment?: string;
    apiKey?: string;
  };
  now?: (() => number) | undefined;
  maxRecursionDepth?: number | undefined;
}

export function createDesktopSubagentDispatchTool(options: DesktopSubagentDispatchToolOptions): RegisteredTool {
  const {getRuntime, getTools, fakeModelMode, modelConfig, now, maxRecursionDepth} = options;
  return createRuntimeSubagentDispatchTool({
    getRuntime,
    getTools,
    now,
    maxRecursionDepth,
    getModelReasoningEfforts: options.getModelReasoningEfforts,
    getModelGateway: (modelName?: string) => {
      if (fakeModelMode) {
        return new ModelGateway(new FakeModelProvider(
          Array.from({length: 16}, () => (req: ModelRequest) => ({
            kind: 'final',
            text: `[次级智能体 ${modelName || 'default'}] 完成分析与执行：${req.messages.at(-1)?.content || ''}`,
          })),
          {
            provider: 'fake',
            deployment: 'desktop-subagent-fake',
            model: modelName || 'fake-subagent-model',
            verification: 'mock',
            capabilities: {text: true, streaming: false, toolCalling: true, structuredOutput: true, vision: false},
          },
        ));
      }
      if (options.getModelGateway) return options.getModelGateway(modelName);
      if (modelConfig?.baseUrl && modelConfig?.apiKey && (modelName === 'pangu' || !modelName)) {
        const apiKey = modelConfig.apiKey;
        const panguOptions: PanguModelProviderOptions = {
          baseUrl: modelConfig.baseUrl,
          model: modelConfig.model ?? 'default',
          apiKey: () => apiKey,
        };
        if (modelConfig.deployment !== undefined) {
          panguOptions.deployment = modelConfig.deployment;
        }
        return new ModelGateway(new StructuredToolProvider(new PanguModelProvider(panguOptions)));
      }
      return undefined;
    },
  });
}
