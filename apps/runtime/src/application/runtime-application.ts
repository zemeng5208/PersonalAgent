import {ProtocolError, validateToolValue} from '@personal-agent/contracts';
import type {Event, Request, Response, RegisteredTool} from '@personal-agent/contracts';
import {RuntimeToolInvoker} from '@personal-agent/agents';
import type {AgentToolPort} from '@personal-agent/agents';
import {ToolGateway, toolArgumentsDigest} from '@personal-agent/tool-gateway';
import {TaskRuntime} from '../index.js';
import {createTextApplication, type TextApplication, type TextApplicationOptions} from './text.js';
import type {ModelMessage} from '@personal-agent/models';
import type {CoordinationPort} from '@personal-agent/coordination';
import {startCoordinationTask} from './coordination.js';
type SuccessfulResponse = Extract<Response, {outcome: 'ok'}>;

const CONVERSATION_HISTORY_LIMIT = 20;
const MODEL_METADATA = /\s*\[model=[^;\]]+;\s*verification=[^;\]]+;\s*tokens=[^\]]+\]\s*$/;

function assistantText(resultSummary: string): string {
  return resultSummary.replace(MODEL_METADATA, '').trim();
}

export interface RuntimeApplicationOptions { path: string; now?: () => Date; idFactory?: () => string; text?: TextApplicationOptions; tools?: readonly RegisteredTool[]; profile?: 'local' | 'huawei_ict_agentarts'; coordination?: CoordinationPort; }
export interface RuntimeApplicationTransport { send(request: Request, signal: AbortSignal): Promise<Response>; }

export class RuntimeApplication implements RuntimeApplicationTransport {
  readonly runtime: TaskRuntime;
  private textApplication: TextApplication;
  private readonly activeTextTasks = new Map<string, Promise<unknown>>();
  private readonly tools: AgentToolPort | undefined;
  readonly profile: 'local' | 'huawei_ict_agentarts';
  private readonly coordination: CoordinationPort | undefined;

  constructor(options: RuntimeApplicationOptions) {
    this.profile = options.profile ?? 'local';
    if (!['local', 'huawei_ict_agentarts'].includes(this.profile)
      || (this.profile === 'local' && options.coordination !== undefined)
      || (this.profile === 'huawei_ict_agentarts' && options.text !== undefined)) {
      throw new ProtocolError('INVALID_ARGUMENT', 'Choose explicit competition coordination or existing local text configuration, not both');
    }
    this.coordination = options.coordination;
    let gateway: ToolGateway | undefined;
    this.runtime = new TaskRuntime(options.path, {
      ...(options.now ? {now: options.now} : {}),
      ...(options.idFactory ? {idFactory: options.idFactory} : {}),
      ...(options.tools ? {createToolGateway: (policy: import('@personal-agent/policy').AuthorizationPolicy) => {
        gateway = new ToolGateway({policy, now: () => (options.now?.() ?? new Date()).getTime()});
        for (const tool of options.tools ?? []) gateway.register(tool);
        return gateway;
      }} : {}),
    });
    if (gateway) {
      const descriptors = gateway.list();
      const invoker = new RuntimeToolInvoker(this.runtime, descriptors);
      this.tools = {list: () => structuredClone(descriptors), invoke: async invocation => {
        const tool = descriptors.find(item => item.name === invocation.toolName && item.version === invocation.toolVersion);
        if (!tool) throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'Tool is not registered');
        validateToolValue(tool.inputSchema, invocation.arguments);
        const ref = invocation.runId;
        if (!this.runtime.policy.get(ref)) {
          const expiresAt = new Date((options.now?.() ?? new Date()).getTime() + 600_000).toISOString();
          const approval = this.runtime.requestToolApproval(ref, invocation.taskId, tool, expiresAt, toolArgumentsDigest(invocation.arguments));
          if (approval.state === 'denied') throw new ProtocolError('UNAUTHORIZED', 'Tool approval was denied');
          if (approval.state === 'allowed') throw new ProtocolError('UNAUTHORIZED', 'Tool grant was revoked');
          return {state: 'pending', evidenceRefs: []};
        }
        return invoker.invoke({...invocation, authorizationRef: ref});
      }};
    }
    this.textApplication = createTextApplication({...options.text, ...(this.tools ? {tools: this.tools} : {})});
  }

  get deployment(): TextApplication['deployment'] { this.requireLocalText(); return structuredClone(this.textApplication.deployment); }
  get activeTaskCount(): number { return this.activeTextTasks.size; }

  async send(request: Request, signal: AbortSignal): Promise<Response> {
    const response = await this.runtime.send(request, signal);
    if (request.operation === 'task.submit' && response.outcome === 'ok') this.dispatchSubmittedTextTask(request, response);
    if (request.operation === 'authorization.respond' && response.outcome === 'ok' && request.payload.decision === 'allow_once') {
      const approval = this.runtime.getApproval(request.payload.approvalId);
      await this.activeTextTasks.get(approval.taskId);
      if (this.runtime.getTask(approval.taskId).state === 'waiting_approval') this.resumeTask(approval.taskId);
    }
    return response;
  }

  private requireLocalText(): void {
    if (this.profile !== 'local') throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'Local text configuration is unavailable in competition profile');
  }

  readEvents(afterSequence = 0): Event[] { return this.runtime.readEvents(afterSequence); }

  configureText(options: TextApplicationOptions): TextApplication['deployment'] {
    this.requireLocalText();
    if (this.activeTextTasks.size) throw new Error('Cannot reconfigure text model while tasks are active');
    this.textApplication = createTextApplication({...options, ...(this.tools ? {tools: this.tools} : {})});
    return this.deployment;
  }

  testTextConnection(options?: Parameters<TextApplication['testConnection']>[0]) { this.requireLocalText(); return this.textApplication.testConnection(options); }
  close(): void { this.runtime.close(); }

  resumeTask(taskId: string): void {
    if (this.activeTextTasks.has(taskId)) return;
    if (this.runtime.getTask(taskId).state !== 'waiting_approval') throw new ProtocolError('REVISION_CONFLICT', 'Task is not awaiting approval');
    const goal = this.runtime.loadCheckpoint(taskId, 'application-goal');
    if (typeof goal !== 'string') throw new ProtocolError('NOT_FOUND', 'Task has no application checkpoint');

    if (this.profile === 'huawei_ict_agentarts') {
      const deadline = this.runtime.loadCheckpoint(taskId, 'application-deadline');
      if (typeof deadline !== 'string') throw new ProtocolError('NOT_FOUND', 'Task has no deadline checkpoint');
      const competition = this.runtime.loadCheckpoint(taskId, 'competition-loop') as {step: number} | undefined;
      const competitionApproval = this.runtime.getApproval(`competition-tool-${taskId}-${competition?.step}`);
      if (competitionApproval.state !== 'allowed') throw new ProtocolError('UNAUTHORIZED', 'Task approval has not been allowed');
      const execution = startCoordinationTask(
        this.runtime, this.coordination, this.tools, taskId, goal, deadline, {resume: true},
      ).finally(() => this.activeTextTasks.delete(taskId));
      this.activeTextTasks.set(taskId, execution);
      void execution.catch(() => {});
      return;
    }

    this.requireLocalText();
    const checkpoint = this.runtime.loadCheckpoint(taskId, 'agent-loop') as {step: number} | undefined;
    const approval = this.runtime.getApproval(`agent-run-${taskId}-${checkpoint?.step}`);
    if (approval.state !== 'allowed') throw new ProtocolError('UNAUTHORIZED', 'Task approval has not been allowed');
    const context = this.runtime.loadCheckpoint(taskId, 'application-context') as {messages?: ModelMessage[]} | undefined;
    const execution = this.textApplication.startTask(this.runtime, taskId, goal, {
      resume: true,
      ...(context?.messages === undefined ? {} : {initialMessages: context.messages}),
    }).finally(() => this.activeTextTasks.delete(taskId));
    this.activeTextTasks.set(taskId, execution);
    void execution.catch(() => {});
  }

  private dispatchSubmittedTextTask(request: Request, response: SuccessfulResponse): void {
    const taskId = response.data && typeof response.data === 'object' && 'taskId' in response.data ? response.data.taskId : undefined;
    const goal = request.operation === 'task.submit' ? request.payload.goal : undefined;
    const conversationId = request.operation === 'task.submit' ? request.payload.conversationId : undefined;
    if (typeof taskId !== 'string' || typeof goal !== 'string' || typeof conversationId !== 'string' || this.activeTextTasks.has(taskId)) return;
    if (this.runtime.getTask(taskId).state !== 'created') return;
    if (this.profile === 'huawei_ict_agentarts') {
      this.runtime.saveCheckpoint(taskId, 'application-profile', this.profile);
      this.runtime.saveCheckpoint(taskId, 'application-goal', goal);
      this.runtime.saveCheckpoint(taskId, 'application-deadline', request.deadline);
      const execution = Promise.resolve().then(() => startCoordinationTask(
        this.runtime, this.coordination, this.tools, taskId, goal, request.deadline,
      )).finally(() => this.activeTextTasks.delete(taskId));
      this.activeTextTasks.set(taskId, execution);
      void execution.catch(() => {});
      return;
    }
    const application = this.textApplication;

    const history: ModelMessage[] = this.runtime.readConversationHistory(conversationId, taskId, CONVERSATION_HISTORY_LIMIT).flatMap(turn => {
      const answer = assistantText(turn.resultSummary);
      return answer ? [
        {role: 'user' as const, content: turn.goal},
        {role: 'assistant' as const, content: answer},
      ] : [];
    });
    this.runtime.saveCheckpoint(taskId, 'application-goal', goal);
    this.runtime.saveCheckpoint(taskId, 'application-context', {messages: history});
    const execution = Promise.resolve().then(() => application.startTask(this.runtime, taskId, goal, {
      ...(history.length ? {initialMessages: history} : {}),
    })).finally(() => this.activeTextTasks.delete(taskId));
    this.activeTextTasks.set(taskId, execution);
    void execution.catch(() => {
      // TaskRuntime persists the failure. This catch only prevents an unhandled rejection.
    });
  }
}

export function createRuntimeApplication(options: RuntimeApplicationOptions): RuntimeApplication { return new RuntimeApplication(options); }
