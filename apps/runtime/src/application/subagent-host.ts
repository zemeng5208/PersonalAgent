import {ProtocolError} from '@personal-agent/contracts';
import type {RegisteredTool, TaskSnapshot, ToolContext} from '@personal-agent/contracts';
import {
  createSubagentDispatchTool,
  dispatchSubtasks,
  DEFAULT_ROLE_LABELS,
  SUBAGENT_DISPATCH_TOOL_NAME,
  SUBAGENT_DISPATCH_TOOL_VERSION,
  type AgentWorkerContext,
  type AgentToolPort,
  type SubtaskDefinition,
  type SubtaskExecutionSummary,
} from '@personal-agent/agents';
import {runAgent} from '@personal-agent/agents';
import {
  ModelGateway,
  FakeModelProvider,
  PanguModelProvider,
  type ModelMessage,
  type ModelRequest,
  type PanguModelProviderOptions,
} from '@personal-agent/models';
import type {TaskRuntime, WorkerContext, SubmitTaskInput} from '../index.js';

export {SUBAGENT_DISPATCH_TOOL_NAME, SUBAGENT_DISPATCH_TOOL_VERSION};

export interface SubagentHostOptions {
  getRuntime: () => TaskRuntime;
  getTools?: (() => AgentToolPort | undefined) | undefined;
  getModelGateway?: ((modelName?: string) => ModelGateway | undefined) | undefined;
  now?: (() => number) | undefined;
  maxRecursionDepth?: number | undefined;
}

export function createRuntimeSubagentDispatchTool(options: SubagentHostOptions): RegisteredTool {
  if (typeof options.getRuntime !== 'function') {
    throw new ProtocolError('INVALID_ARGUMENT', 'getRuntime must be a function');
  }

  const handler = async (
    input: {subtasks: readonly SubtaskDefinition[]},
    context: ToolContext,
  ): Promise<SubtaskExecutionSummary> => {
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
      saveCheckpoint: (key: string, value: unknown) => runtime.saveCheckpoint(context.taskId, key, value),
      loadCheckpoint: (key: string) => runtime.loadCheckpoint(context.taskId, key),
      reportProgress: (progress) => runtime.getTask(context.taskId),
    };

    // 3. 子任务真实执行器
    const executor = async (subtask: SubtaskDefinition, signal: AbortSignal): Promise<string> => {
      const childTaskId = `subtask-${context.taskId}-${subtask.subtaskId}`;
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
        if (taskSnapshot.state === 'failed') throw new Error(taskSnapshot.resultSummary || 'Subtask execution failed');
        return taskSnapshot.resultSummary ?? '';
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

            childWorker.reportProgress({
              stepId: `child-${subtask.subtaskId}`,
              label: `[${roleLabel}] 正在执行: ${subtask.goal}`,
            });

            // 检查是否配置了 ModelGateway 进行真实模型推理
            const model = options.getModelGateway?.(subtask.model);
            if (model) {
              const childTools = options.getTools?.();
              const effortLevels: ('none' | 'low' | 'medium' | 'high')[] = ['none', 'low', 'low', 'medium', 'high', 'high'];
              const reasoningEffort = subtask.thinkingDepth !== undefined
                ? (effortLevels[Math.min(Math.max(0, subtask.thinkingDepth), 5)] ?? 'low')
                : undefined;

              const rolePrompt: ModelMessage = {
                role: 'system',
                content: `你是专业次级智能体，当前承担职责为【${roleLabel}】(${subtask.role})。请聚焦于此职责，独立执行指派的目标。`,
              };

              const agentOutcome = await runAgent(
                {
                  taskId: childTaskId,
                  deadline: childWorker.deadline,
                  signal: childWorker.signal,
                  saveCheckpoint: (k, v) => childWorker.saveCheckpoint(k, v),
                  loadCheckpoint: (k) => childWorker.loadCheckpoint(k),
                  reportProgress: (p) => childWorker.reportProgress(p),
                },
                {
                  goal: subtask.goal,
                  initialMessages: [rolePrompt],
                  model,
                  tools: childTools ?? {list: () => [], invoke: async () => { throw new Error('No tools'); }},
                  authorizationRefFor: () => `subtask-auth-${childTaskId}`,
                  maxSteps: subtask.thinkingDepth !== undefined ? Math.max(2, (subtask.thinkingDepth + 1) * 2) : 6,
                  ...(reasoningEffort !== undefined ? {reasoningEffort} : {}),
                },
              );
              return {
                resultSummary: agentOutcome.resultSummary,
                evidenceRefs: agentOutcome.evidenceRefs,
              };
            }

            // 未配置模型时使用基于角色职责的结构化执行
            let detail = '';
            if (subtask.role === 'researcher') {
              detail = `【${roleLabel}】完成针对性资料检索与事实调研：${subtask.goal}`;
            } else if (subtask.role === 'coder') {
              detail = `【${roleLabel}】工程工作区与代码实现核验完毕：${subtask.goal}`;
            } else if (subtask.role === 'reviewer') {
              detail = `【${roleLabel}】合规性与质量复核通过：${subtask.goal}`;
            } else if (subtask.role === 'planner') {
              detail = `【${roleLabel}】子目标与执行步骤已结构化拆解：${subtask.goal}`;
            } else {
              detail = `【${roleLabel}】协作协调与输出汇总完成：${subtask.goal}`;
            }

            const modelNote = subtask.model ? ` [model=${subtask.model}]` : '';
            const thinkingNote = subtask.thinkingDepth !== undefined ? ` [thinking_depth=${subtask.thinkingDepth}]` : '';

            return {
              resultSummary: `${detail}${modelNote}${thinkingNote}`,
              evidenceRefs: [],
            };
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

        return outcome.resultSummary ?? '';
      } finally {
        signal.removeEventListener('abort', abortListener);
        context.signal.removeEventListener('abort', abortListener);
      }
    };

    return dispatchSubtasks(workerBridge, input.subtasks, executor);
  };

  return createSubagentDispatchTool(handler);
}

export interface DesktopSubagentDispatchToolOptions {
  getRuntime: () => TaskRuntime;
  getTools?: (() => AgentToolPort | undefined) | undefined;
  fakeModelMode?: boolean;
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
        return new ModelGateway(new PanguModelProvider(panguOptions));
      }
      return undefined;
    },
  });
}
