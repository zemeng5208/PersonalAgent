import { ProtocolError, PROTOCOL_VERSION } from '@personal-agent/contracts';
import type { Request, Response, TaskSnapshot, ToolDescriptor } from '@personal-agent/contracts';
import { validateToolArguments, validateToolProposal } from '@personal-agent/models';
import type { ModelGateway, ModelMessage, ModelResult, ToolProposal } from '@personal-agent/models';

export interface AgentProgressInput {
  stepId: string;
  label: string;
  completedUnits?: number;
  totalUnits?: number;
}

/** Runtime-facing port owned by the Agent package, not a concrete Runtime type. */
export interface AgentWorkerContext {
  taskId: string;
  deadline: string;
  signal: AbortSignal;
  saveCheckpoint(key: string, value: unknown): void;
  loadCheckpoint(key: string): unknown;
  reportProgress(progress: AgentProgressInput): TaskSnapshot;
}

export interface AgentWorkerResult {
  resultSummary: string;
  evidenceRefs?: readonly string[];
}

export interface AgentToolInvocation {
  toolName: string;
  toolVersion: string;
  arguments: unknown;
  taskId: string;
  runId: string;
  authorizationRef: string;
  deadline: string;
  signal: AbortSignal;
  userPresent?: boolean;
}

export interface ToolInvocationResult {
  state: 'confirmed' | 'pending' | 'unknown';
  result?: unknown;
  evidenceRefs: readonly string[];
}

export interface AgentToolPort {
  list(): ToolDescriptor[];
  invoke(invocation: AgentToolInvocation): Promise<ToolInvocationResult>;
}

export interface AgentRuntimeRequestPort {
  send(input: Request, signal: AbortSignal): Promise<Response>;
}

let requestSequence = 0;

/** Uses the public Runtime request path, so unknown results can enter reconciliation. */
export class RuntimeToolInvoker implements AgentToolPort {
  constructor(
    private readonly runtime: AgentRuntimeRequestPort,
    private readonly descriptors: readonly ToolDescriptor[],
    private readonly requestIdFactory: () => string = () => `agent-tool-request-${++requestSequence}`,
  ) {}

  list(): ToolDescriptor[] { return this.descriptors.map(descriptor => structuredClone(descriptor)); }

  async invoke(invocation: AgentToolInvocation): Promise<ToolInvocationResult> {
    const request: Request = {
      kind: 'request', protocolVersion: PROTOCOL_VERSION, requestId: this.requestIdFactory(), taskId: invocation.taskId,
      idempotencyKey: invocation.runId,
      deadline: invocation.deadline, operation: 'tool.invoke',
      payload: {
        toolName: invocation.toolName, toolVersion: invocation.toolVersion,
        arguments: structuredClone(invocation.arguments) as Record<string, unknown>, scopeRef: invocation.authorizationRef,
      },
    };
    const response = await this.runtime.send(request, invocation.signal);
    if (response.outcome === 'error') throw new ProtocolError(response.error.code, response.error.message, response.error.retryable, response.error.retryAfterMs);
    const data = response.data as {state: 'confirmed' | 'pending' | 'unknown'; result?: unknown; evidenceRefs: string[]};
    return {
      state: data.state,
      ...(data.result === undefined ? {} : {result: structuredClone(data.result)}),
      evidenceRefs: [...data.evidenceRefs],
    };
  }
}

export interface AgentRunOptions {
  goal: string;
  model: ModelGateway;
  tools: AgentToolPort;
  authorizationRefFor: (toolName: string, context: AgentWorkerContext) => string;
  maxSteps: number;
  maxTokens?: number;
  maxRepairAttempts?: number;
  onUnknownResult?: (context: AgentWorkerContext, result: ToolInvocationResult) => void | Promise<void>;
}

export interface AgentOutcome {
  status: 'succeeded' | 'waiting_reconciliation' | 'waiting_approval';
  resultSummary: string;
  evidenceRefs: readonly string[];
  deployment: ModelResult['deployment'];
  usage?: ModelResult['usage'];
  steps: number;
}

function validateBounds(options: AgentRunOptions): void {
  if (!options.goal.trim()) throw new ProtocolError('INVALID_ARGUMENT', 'Agent goal must not be empty');
  if (!Number.isSafeInteger(options.maxSteps) || options.maxSteps < 1) throw new ProtocolError('INVALID_ARGUMENT', 'maxSteps must be a positive integer');
  if (options.maxTokens !== undefined && (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1)) throw new ProtocolError('INVALID_ARGUMENT', 'maxTokens must be a positive integer');
  if (options.maxRepairAttempts !== undefined && (!Number.isSafeInteger(options.maxRepairAttempts) || options.maxRepairAttempts < 0)) throw new ProtocolError('INVALID_ARGUMENT', 'maxRepairAttempts must be a non-negative integer');
}

function checkRuntime(context: AgentWorkerContext): void {
  if (context.signal.aborted) throw new ProtocolError('CANCELLED', 'Agent task was cancelled');
}

function estimateTokens(result: ModelResult): number {
  const reported = result.usage?.totalTokens ?? result.usage?.completionTokens;
  if (reported !== undefined) return Math.max(0, reported);
  return result.response.kind === 'final' ? Math.max(1, Math.ceil(result.response.text.length / 4)) : Math.max(1, Math.ceil(JSON.stringify(result.response.proposal).length / 4));
}

function proposalError(error: unknown): ProtocolError {
  if (error instanceof ProtocolError) return error;
  return new ProtocolError('INVALID_ARGUMENT', error instanceof Error ? error.message : 'Invalid model tool proposal');
}

function withModelMetadata(deployment: ModelResult['deployment'], usage: ModelResult['usage'], text: string): string {
  const tokens = usage?.totalTokens === undefined ? 'unknown' : String(usage.totalTokens);
  return `${text} [model=${deployment.provider}/${deployment.deployment}/${deployment.model}; verification=${deployment.verification}; tokens=${tokens}]`;
}

async function complete(context: AgentWorkerContext, options: AgentRunOptions, messages: readonly ModelMessage[], remainingTokens?: number): Promise<ModelResult> {
  checkRuntime(context);
  return options.model.complete({
    messages,
    tools: options.tools.list(),
    ...(remainingTokens === undefined ? {} : {maxOutputTokens: remainingTokens}),
    deadline: context.deadline,
    signal: context.signal,
  });
}

export async function runAgent(context: AgentWorkerContext, options: AgentRunOptions): Promise<AgentOutcome> {
  validateBounds(options);
  const saved = context.loadCheckpoint('agent-loop') as {messages: ModelMessage[]; usedTokens: number; repairs: number; evidenceRefs: string[]; step: number; pending?: ModelResult} | undefined;
  let messages: ModelMessage[] = saved?.messages ?? [{role: 'user', content: options.goal}];
  let usedTokens = saved?.usedTokens ?? 0;
  let repairs = saved?.repairs ?? 0;
  let evidenceRefs: string[] = saved?.evidenceRefs ?? [];
  let pending = saved?.pending;

  for (let step = saved?.step ?? 1; step <= options.maxSteps; step++) {
    context.reportProgress({stepId: `agent-${step}`, label: 'model planning', completedUnits: step - 1, totalUnits: options.maxSteps});
    if (!pending && options.maxTokens !== undefined && usedTokens >= options.maxTokens) throw new ProtocolError('TIMEOUT', 'Agent token budget exhausted');
    const result = pending ?? await complete(context, options, messages, options.maxTokens === undefined ? undefined : options.maxTokens - usedTokens);
    if (!pending) usedTokens += estimateTokens(result);
    pending = undefined;
    if (options.maxTokens !== undefined && usedTokens > options.maxTokens) throw new ProtocolError('TIMEOUT', 'Agent token budget exhausted');

    if (result.response.kind === 'final') {
      context.reportProgress({stepId: `agent-${step}`, label: 'model answer ready', completedUnits: options.maxSteps, totalUnits: options.maxSteps});
      const outcome: AgentOutcome = {
        status: 'succeeded', resultSummary: withModelMetadata(result.deployment, result.usage, result.response.text), evidenceRefs,
        deployment: result.deployment, ...(result.usage === undefined ? {} : {usage: result.usage}), steps: step,
      };
      return outcome;
    }

    let proposal: ToolProposal;
    try {
      proposal = validateToolProposal(result.response.proposal);
      const descriptor = options.tools.list().find(item => item.name === proposal.toolName);
      if (!descriptor) throw new ProtocolError('UNSUPPORTED_CAPABILITY', `Tool ${proposal.toolName} is not registered`);
      if (descriptor.version !== proposal.toolVersion) throw new ProtocolError('PROTOCOL_MISMATCH', `Tool ${proposal.toolName} version ${proposal.toolVersion} is not available`);
      validateToolArguments(descriptor, proposal.arguments);
    } catch (error) {
      repairs++;
      if (repairs > (options.maxRepairAttempts ?? 1)) throw proposalError(error);
      messages = [...messages, {role: 'assistant', content: JSON.stringify(result.response)}, {role: 'user', content: `The previous tool proposal was rejected: ${proposalError(error).message}. Return a corrected proposal or a final answer.`}];
      continue;
    }

    const authorizationRef = options.authorizationRefFor(proposal.toolName, context);
    if (!authorizationRef.trim()) throw new ProtocolError('UNAUTHORIZED', 'Trusted host did not provide an authorization reference');
    context.reportProgress({stepId: `agent-tool-${step}`, label: `calling ${proposal.toolName}`, completedUnits: step, totalUnits: options.maxSteps});
    context.saveCheckpoint('agent-loop', {messages, usedTokens, repairs, evidenceRefs, step, pending: result});
    const toolResult = await options.tools.invoke({
      toolName: proposal.toolName, toolVersion: proposal.toolVersion, arguments: structuredClone(proposal.arguments),
      taskId: context.taskId, runId: `agent-run-${context.taskId}-${step}`, authorizationRef, deadline: context.deadline, signal: context.signal,
    });
    evidenceRefs = [...evidenceRefs, ...toolResult.evidenceRefs];
    if (toolResult.state === 'pending') {
      return {status: 'waiting_approval', resultSummary: 'Tool is awaiting approval', evidenceRefs, deployment: result.deployment, steps: step};
    }
    if (toolResult.state === 'unknown') {
      if (!options.onUnknownResult) throw new ProtocolError('RESULT_UNKNOWN', 'Tool result is unknown; reconciliation is required');
      await options.onUnknownResult(context, toolResult);
      return {status: 'waiting_reconciliation', resultSummary: 'Tool result is unknown; reconciliation is required before answering', evidenceRefs, deployment: result.deployment, ...(result.usage === undefined ? {} : {usage: result.usage}), steps: step};
    }
    messages = [...messages,
      {role: 'assistant', content: JSON.stringify(result.response)},
      {role: 'tool', content: JSON.stringify({toolName: proposal.toolName, state: toolResult.state, result: toolResult.result})},
    ];
    context.saveCheckpoint('agent-loop', {messages, usedTokens, repairs, evidenceRefs, step: step + 1});
  }
  throw new ProtocolError('TIMEOUT', `Agent reached maxSteps=${options.maxSteps} without a final answer`);
}

export function createAgentWorker(options: AgentRunOptions): (context: AgentWorkerContext) => Promise<AgentWorkerResult> {
  return async context => {
    const outcome = await runAgent(context, options);
    return {resultSummary: outcome.resultSummary, evidenceRefs: outcome.evidenceRefs};
  };
}
