import {ProtocolError, validateToolValue} from '@personal-agent/contracts';
import type {Event, Request, Response, RegisteredTool, TaskSnapshot} from '@personal-agent/contracts';
import {RuntimeToolInvoker} from '@personal-agent/agents';
import type {AgentToolPort} from '@personal-agent/agents';
import {ToolGateway, toolArgumentsDigest} from '@personal-agent/tool-gateway';
import {TaskRuntime} from '../index.js';
import {createTextApplication, type TextApplication, type TextApplicationOptions} from './text.js';
import type {ModelMessage} from '@personal-agent/models';
import {parseCoordinationRepairCandidate} from '@personal-agent/coordination';
import type {CoordinationPort, CoordinationRequest, CoordinationRepairCandidateResult} from '@personal-agent/coordination';
import {startCoordinationTask, assertCompetitionExportAllowed, type CompetitionToolExport} from './coordination.js';
import {createLocalRepairTool, prepareLocalRepair, startLocalRepairTask, LOCAL_REPAIR_CHECKPOINT} from './local-repair.js';
import type {LocalRepairHostOptions, SubmitLocalRepairRequest} from './local-repair.js';
type SuccessfulResponse = Extract<Response, {outcome: 'ok'}>;

const CONVERSATION_HISTORY_LIMIT = 20;
const MODEL_METADATA = /\s*\[model=[^;\]]+;\s*verification=[^;\]]+;\s*tokens=[^\]]+\]\s*$/;

function assistantText(resultSummary: string): string {
  return resultSummary.replace(MODEL_METADATA, '').trim();
}

export interface RuntimeApplicationOptions { path: string; now?: () => Date; idFactory?: () => string; text?: TextApplicationOptions; tools?: readonly RegisteredTool[]; profile?: 'local' | 'huawei_ict_agentarts'; coordination?: CoordinationPort; competitionToolExports?: readonly CompetitionToolExport[]; repairCandidateVersion?: '1.0'; localRepair?: LocalRepairHostOptions; }
export interface RuntimeApplicationTransport { send(request: Request, signal: AbortSignal): Promise<Response>; }

export class RuntimeApplication implements RuntimeApplicationTransport {
  readonly runtime: TaskRuntime;
  private textApplication: TextApplication;
  private readonly activeTextTasks = new Map<string, Promise<unknown>>();
  private readonly tools: AgentToolPort | undefined;
  readonly profile: 'local' | 'huawei_ict_agentarts';
  private readonly coordination: CoordinationPort | undefined;
  private readonly competitionToolExports: readonly CompetitionToolExport[];
  private readonly repairCandidateVersion: '1.0' | undefined;
  private readonly localRepair: LocalRepairHostOptions | undefined;

  constructor(options: RuntimeApplicationOptions) {
    this.profile = options.profile ?? 'local';
    if (!['local', 'huawei_ict_agentarts'].includes(this.profile)
      || (this.profile === 'local' && (options.coordination !== undefined || options.competitionToolExports !== undefined || options.repairCandidateVersion !== undefined))
      || (options.repairCandidateVersion !== undefined && options.repairCandidateVersion !== '1.0')
      || (options.localRepair !== undefined && options.repairCandidateVersion !== '1.0')
      || (this.profile === 'huawei_ict_agentarts' && options.text !== undefined)) {
      throw new ProtocolError('INVALID_ARGUMENT', 'Choose explicit competition coordination or existing local text configuration, not both');
    }
    this.coordination = options.coordination;
    this.repairCandidateVersion = options.repairCandidateVersion;
    this.localRepair = options.localRepair;
    if (this.localRepair && (!this.localRepair.graphNamespace?.trim() || !this.localRepair.bindingVersion?.trim()
      || typeof this.localRepair.resolveBinding !== 'function' || typeof this.localRepair.matchesSource !== 'function'
      || typeof this.localRepair.withSourceLock !== 'function'
      || typeof this.localRepair.memory?.listCurrent !== 'function')) {
      throw new ProtocolError('INVALID_ARGUMENT', 'Invalid local repair host configuration');
    }
    this.competitionToolExports = (options.competitionToolExports ?? []).map(binding => Object.freeze({...binding}));
    const exportNames = new Set<string>();
    for (const binding of this.competitionToolExports) {
      const key = JSON.stringify([binding.toolName, binding.toolVersion]);
      if (!binding.toolName || !binding.toolVersion || typeof binding.accepts !== 'function'
        || typeof binding.exportPolicyVersion !== 'string' || !binding.exportPolicyVersion.trim()
        || binding.exportPolicyVersion.length > 128
        || typeof binding.project !== 'function' || exportNames.has(key)) {
        throw new ProtocolError('INVALID_ARGUMENT', 'Invalid Competition export configuration');
      }
      exportNames.add(key);
    }
    let gateway: ToolGateway | undefined;
    this.runtime = new TaskRuntime(options.path, {
      ...(options.now ? {now: options.now} : {}),
      ...(options.idFactory ? {idFactory: options.idFactory} : {}),
      ...(options.tools || this.localRepair ? {createToolGateway: (policy: import('@personal-agent/policy').AuthorizationPolicy) => {
        gateway = new ToolGateway({policy, now: () => (options.now?.() ?? new Date()).getTime()});
        for (const tool of options.tools ?? []) gateway.register(tool);
        if (this.localRepair) gateway.register(createLocalRepairTool(() => this.runtime, this.localRepair));
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

  /** Explicit host preview only; neither this read nor a cloud candidate grants a write. */
  readRepairCandidate(taskId: string): CoordinationRepairCandidateResult | undefined {
    if (this.repairCandidateVersion !== '1.0') throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'Repair candidates are not enabled');
    if (this.runtime.getTask(taskId).state !== 'succeeded') return undefined;
    const result = this.runtime.loadCheckpoint(taskId, 'competition-repair-candidate');
    return result === undefined ? undefined : parseCoordinationRepairCandidate(result);
  }

  /** An explicit trusted-host action creates a separate local task; never a cloud callback. */
  submitLocalRepair(request: SubmitLocalRepairRequest): TaskSnapshot {
    if (!this.localRepair || !this.tools) throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'Local repair is not configured');
    if (!this.readRepairCandidate(request.sourceTaskId)) throw new ProtocolError('NOT_FOUND', 'No completed repair candidate');
    const task = prepareLocalRepair(this.runtime, this.localRepair, request);
    if (task.state === 'created') this.dispatchLocalRepair(task.taskId);
    else if (['planning', 'running', 'verifying'].includes(task.state) && !this.activeTextTasks.has(task.taskId)) {
      return this.runtime.transitionTask(task.taskId, 'waiting_reconciliation', {
        error: {code: 'RESULT_UNKNOWN', message: 'Local repair was interrupted; verify persisted graph before any further action', retryable: false},
      });
    }
    return this.runtime.getTask(task.taskId);
  }

  private dispatchLocalRepair(taskId: string, resume = false): void {
    if (this.activeTextTasks.has(taskId)) return;
    const execution = Promise.resolve().then(() => startLocalRepairTask(this.runtime, this.tools!, taskId, resume))
      .finally(() => this.activeTextTasks.delete(taskId));
    this.activeTextTasks.set(taskId, execution);
    void execution.catch(() => {});
  }

  /** Host-only real-adapter guard; never exposed as a wire or Renderer operation. */
  assertCompetitionExportAllowed(request: CoordinationRequest): void {
    assertCompetitionExportAllowed(this.runtime, this.tools, this.competitionToolExports, request);
  }

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
    if (this.runtime.loadCheckpoint(taskId, LOCAL_REPAIR_CHECKPOINT) !== undefined) {
      if (!this.localRepair || !this.tools || this.runtime.getApproval('local-repair-' + taskId).state !== 'allowed') {
        throw new ProtocolError('UNAUTHORIZED', 'Local repair is unavailable or not approved');
      }
      this.dispatchLocalRepair(taskId, true);
      return;
    }
    const goal = this.runtime.loadCheckpoint(taskId, 'application-goal');
    if (typeof goal !== 'string') throw new ProtocolError('NOT_FOUND', 'Task has no application checkpoint');

    if (this.profile === 'huawei_ict_agentarts') {
      const deadline = this.runtime.loadCheckpoint(taskId, 'application-deadline');
      if (typeof deadline !== 'string') throw new ProtocolError('NOT_FOUND', 'Task has no deadline checkpoint');
      const competition = this.runtime.loadCheckpoint(taskId, 'competition-loop') as {step: number} | undefined;
      const competitionApproval = this.runtime.getApproval(`competition-tool-${taskId}-${competition?.step}`);
      if (competitionApproval.state !== 'allowed') throw new ProtocolError('UNAUTHORIZED', 'Task approval has not been allowed');
      const execution = startCoordinationTask(
        this.runtime, this.coordination, this.tools, taskId, goal, deadline,
        {resume: true, toolExports: this.competitionToolExports,
          ...(this.repairCandidateVersion ? {repairCandidateVersion: this.repairCandidateVersion} : {})},
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
        {toolExports: this.competitionToolExports,
          ...(this.repairCandidateVersion ? {repairCandidateVersion: this.repairCandidateVersion} : {})},
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
