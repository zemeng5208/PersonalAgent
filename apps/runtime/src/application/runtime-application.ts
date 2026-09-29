import {ProtocolError, validateToolValue} from '@personal-agent/contracts';
import type {Event, Request, Response, RegisteredTool, TaskSnapshot, ToolDescriptor} from '@personal-agent/contracts';
import {RuntimeToolInvoker} from '@personal-agent/agents';
import type {AgentToolPort} from '@personal-agent/agents';
import {ToolGateway, toolArgumentsDigest} from '@personal-agent/tool-gateway';
import {TaskRuntime} from '../index.js';
import {createTextApplication, type TextApplication, type TextApplicationOptions} from './text.js';
import type {ModelMessage} from '@personal-agent/models';
import {QwenRealtimeModelGateway} from '@personal-agent/models';
import {parseCoordinationRepairCandidate} from '@personal-agent/coordination';
import type {CoordinationPort, CoordinationRequest, CoordinationRepairCandidateResult} from '@personal-agent/coordination';
import {startCoordinationTask, assertCompetitionExportAllowed, type CompetitionToolExport} from './coordination.js';
import {createLocalRepairTool, prepareLocalRepair, startLocalRepairTask, LOCAL_REPAIR_CHECKPOINT} from './local-repair.js';
import type {LocalRepairHostOptions, SubmitLocalRepairRequest} from './local-repair.js';
import {isDeepStrictEqual} from 'node:util';
import {RuntimeCompetitionToolCatalog} from './tool-catalog.js';
import type {CompetitionAvailableTool, CompetitionToolAvailability} from './tool-catalog.js';
import {ScopedEvidenceReader} from './evidence-reader.js';
import type {EvidenceReaderOptions} from './evidence-reader.js';
import {createCompetitionFactHost} from './competition-fact-host.js';
import type {CompetitionFactHost, CompetitionFactHostOptions} from './competition-fact-host.js';
import {resolve} from 'node:path';
import {SystemObservationSessions, SYSTEM_OBSERVATION_SESSION_CHECKPOINT,
  SYSTEM_OBSERVATION_NAME, SYSTEM_OBSERVATION_VERSION, SYSTEM_OBSERVATION_SCOPE} from './system-observation-session.js';
import type {StartSystemObservationSessionRequest, SystemObservationSession} from './system-observation-session.js';
import {MailReadSessions, MAIL_READ_SESSION_CHECKPOINT, MAIL_READ_TOOL, MAIL_READ_VERSION} from './mail-read-session.js';
import type {StartMailReadSessionRequest, MailReadSession} from './mail-read-session.js';
import {createRuntimeSubagentDispatchTool} from './subagent-host.js';
import {WORKSPACE_PATCH_APPLY_TOOL_NAME, WorkspacePatchReconciliationAdapter} from './workspace-patch-reconciliation.js';
import type {WorkspacePatchReconciliationPort, WorkspacePatchReconciliationReadback} from './workspace-patch-reconciliation.js';
type SuccessfulResponse = Extract<Response, {outcome: 'ok'}>;

export interface RevokeHostAuthorizationRequest {
  subjectRef: string;
  conversationId: string;
  taskId: string;
  authorizationRef: string;
  expectedApprovalRevision: number;
  /** Trusted host checks current session ownership and permission on each call. */
  authorize: (scope: Readonly<{subjectRef: string; conversationId: string; taskId: string;
    authorizationRef: string}>) => boolean | Promise<boolean>;
}

export interface RevokeHostAuthorizationResult {revoked: boolean; grantPresent: false; approvalRevision: number;}

const CONVERSATION_HISTORY_LIMIT = 20;
const MODEL_METADATA = /\s*\[model=[^;\]]+;\s*verification=[^;\]]+;\s*tokens=[^\]]+\]\s*$/;
const HOST_TOOL_CHECKPOINT = 'host-tool-intent';
const HOST_TOOL_PREPARATION_CHECKPOINT = 'host-tool-preparation';
const HOST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export interface SubmitHostToolTaskRequest {
  /** Stable across retries and application restarts, chosen by the trusted host. */
  commandId: string;
  toolName: string;
  toolVersion: string;
  arguments: Record<string, unknown>;
  deadline: string;
}

export type PrepareHostToolTaskRequest = Omit<SubmitHostToolTaskRequest, 'arguments'>;
export interface FinalizeHostToolTaskRequest {
  taskId: string;
  commandId: string;
  expectedTaskRevision: number;
  arguments: Record<string, unknown>;
}

interface HostToolPreparation extends PrepareHostToolTaskRequest {
  namespace: string;
  workspaceBindingId?: string;
}
interface HostToolIntent extends SubmitHostToolTaskRequest {
  namespace: string;
  argumentsDigest: string;
  workspaceBindingId?: string;
}

export interface HostToolTaskReadback {
  commandId: string;
  toolName: string;
  toolVersion: string;
  task: TaskSnapshot;
  approval?: {approvalId: string; revision: number; state: 'pending' | 'allowed' | 'denied'};
  confirmed?: {runId: string; result: unknown; evidenceRefs: string[]};
}

export interface ConfirmedSystemObservationSample {
  readonly taskId: string;
  readonly source: 'node:os';
  readonly timestamp: string;
  readonly cpuPercent: number;
  readonly memoryPercent: number;
  readonly samplingIntervalMs: number;
  readonly evidenceRefs: readonly string[];
}

function assistantText(resultSummary: string): string {
  return resultSummary.replace(MODEL_METADATA, '').trim();
}

export interface ThinkingConfig {
  depth: number;
  fast: boolean;
}

export interface ThinkingState extends ThinkingConfig {
  maxSteps: number;
  applied: boolean;
  reason: string;
  stepBudget: {
    maxSteps: number;
    fast: boolean;
    description: string;
  };
  modelReasoning: {
    supported: boolean;
    effort: 'none' | 'low' | 'medium' | 'high';
    reason: string;
  };
}

export interface RuntimeApplicationOptions { path: string; now?: () => Date; idFactory?: () => string; text?: TextApplicationOptions; tools?: readonly RegisteredTool[]; profile?: 'local' | 'huawei_ict_agentarts'; coordination?: CoordinationPort; competitionToolExports?: readonly CompetitionToolExport[]; competitionToolAvailability?: readonly CompetitionToolAvailability[]; competitionMaxSteps?: number; repairCandidateVersion?: '1.0'; localRepair?: LocalRepairHostOptions; hostUserNamespace?: string;
  thinking?: ThinkingConfig;
  /** Trusted host policy for routine operations inside already enabled module scopes. */
  automaticTools?: readonly {toolName: string; toolVersion: string}[];
  /** Trusted Desktop-only recovery port; paths and process identity stay in its closure. */
  workspacePatchReconciliation?: WorkspacePatchReconciliationPort;
}
export interface RuntimeApplicationTransport { send(request: Request, signal: AbortSignal): Promise<Response>; }

export class RuntimeApplication implements RuntimeApplicationTransport {
  readonly runtime: TaskRuntime;
  private textApplication: TextApplication;
  private readonly activeTextTasks = new Map<string, Promise<unknown>>();
  private readonly tools: AgentToolPort | undefined;
  readonly profile: 'local' | 'huawei_ict_agentarts';
  private readonly coordination: CoordinationPort | undefined;
  private readonly competitionToolExports: readonly CompetitionToolExport[];
  private competitionMaxSteps: number;
  private thinkingConfig: ThinkingConfig = {depth: 1, fast: false};
  private readonly repairCandidateVersion: '1.0' | undefined;
  private readonly localRepair: LocalRepairHostOptions | undefined;
  private readonly hostUserNamespace: string | undefined;
  private readonly now: () => Date;
  private readonly competitionToolCatalog?: RuntimeCompetitionToolCatalog;
  private readonly storagePath: string;
  private readonly observationSessions: SystemObservationSessions;
  private readonly mailReadSessions: MailReadSessions;
  private readonly workspacePatchReconciliation?: WorkspacePatchReconciliationAdapter;

  constructor(options: RuntimeApplicationOptions) {
    this.storagePath = resolve(options.path);
    this.profile = options.profile ?? 'local';
    if (options.competitionMaxSteps !== undefined && (this.profile !== 'huawei_ict_agentarts'
      || !Number.isSafeInteger(options.competitionMaxSteps) || options.competitionMaxSteps < 1)) {
      throw new ProtocolError('INVALID_ARGUMENT', 'Competition step budget must be a positive integer');
    }
    this.competitionMaxSteps = options.competitionMaxSteps ?? 4;
    if (options.thinking) this.configureThinking(options.thinking);
    else if (options.competitionMaxSteps !== undefined) this.thinkingConfig = {depth: Math.min(5, Math.max(0, Math.floor(options.competitionMaxSteps / 2) - 1)), fast: false};
    if (!['local', 'huawei_ict_agentarts'].includes(this.profile)
      || (this.profile === 'local' && (options.coordination !== undefined || options.competitionToolExports !== undefined || options.competitionToolAvailability !== undefined || options.repairCandidateVersion !== undefined || options.hostUserNamespace !== undefined))
      || (options.repairCandidateVersion !== undefined && options.repairCandidateVersion !== '1.0')
      || (options.localRepair !== undefined && options.repairCandidateVersion !== '1.0')
      || (this.profile === 'huawei_ict_agentarts' && options.text !== undefined)) {
      throw new ProtocolError('INVALID_ARGUMENT', 'Choose explicit competition coordination or existing local text configuration, not both');
    }
    this.coordination = options.coordination;
    this.now = options.now ?? (() => new Date());
    this.repairCandidateVersion = options.repairCandidateVersion;
    this.localRepair = options.localRepair;
    if (options.hostUserNamespace !== undefined && !HOST_ID.test(options.hostUserNamespace)) {
      throw new ProtocolError('INVALID_ARGUMENT', 'Invalid trusted host user namespace');
    }
    this.hostUserNamespace = options.hostUserNamespace;
    if (options.workspacePatchReconciliation !== undefined
      && (this.profile !== 'huawei_ict_agentarts' || !this.hostUserNamespace
        || typeof options.workspacePatchReconciliation.reconcile !== 'function'
        || !/^[a-f0-9]{64}$/u.test(options.workspacePatchReconciliation.bindingId))) {
      throw new ProtocolError('INVALID_ARGUMENT', 'Workspace patch reconciliation needs the trusted Competition host');
    }
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
        gateway = new ToolGateway({policy: {authorize: request => {
          // Gate even the generic tool.invoke wire path: a persisted sample
          // grant alone cannot survive its process-local consent lease.
          const session = this.runtime.loadCheckpoint(request.taskId, SYSTEM_OBSERVATION_SESSION_CHECKPOINT);
          if (session !== undefined) {
            if (typeof session !== 'string' || request.toolName !== SYSTEM_OBSERVATION_NAME
              || request.authorizationRef !== `host-tool-${request.taskId}`) {
              throw new ProtocolError('UNAUTHORIZED', 'Invalid observation authorization');
            }
            this.observationSessions.assertSample(session, request.taskId);
          }
          const mailSession = this.runtime.loadCheckpoint(request.taskId, MAIL_READ_SESSION_CHECKPOINT);
          if (mailSession !== undefined) {
            if (typeof mailSession !== 'string' || request.toolName !== MAIL_READ_TOOL
              || request.authorizationRef !== `host-tool-${request.taskId}`) {
              throw new ProtocolError('UNAUTHORIZED', 'Invalid inbox read authorization');
            }
            this.mailReadSessions.assertPage(mailSession, request.taskId);
          }
          return policy.authorize(request);
        }}, now: () => (options.now?.() ?? new Date()).getTime()});
        for (const tool of options.tools ?? []) gateway.register(tool);
        if (this.localRepair) gateway.register(createLocalRepairTool(() => this.runtime, this.localRepair));
        return gateway;
      }} : {}),
    });
    if (options.workspacePatchReconciliation) {
      this.workspacePatchReconciliation = new WorkspacePatchReconciliationAdapter(
        this.runtime, options.workspacePatchReconciliation, this.hostUserNamespace);
    }
    this.observationSessions = new SystemObservationSessions(() => this.now().getTime(), taskId => {
      this.runtime.policy.revoke(`host-tool-${taskId}`);
      this.runtime.requestCancel(taskId, 'System observation consent ended');
    });
    this.mailReadSessions = new MailReadSessions(() => this.now().getTime(), taskId => {
      this.runtime.policy.revoke(`host-tool-${taskId}`);
      this.runtime.requestCancel(taskId, 'Inbox read consent ended');
    });
    if (gateway) {
      const descriptors = gateway.list();
      const automaticTools = new Set<string>();
      for (const binding of options.automaticTools ?? []) {
        const descriptor = descriptors.find(tool => tool.name === binding.toolName && tool.version === binding.toolVersion);
        if (this.profile !== 'huawei_ict_agentarts' || !descriptor || descriptor.sideEffect === 'external_write' || descriptor.requiresPresence) {
          throw new ProtocolError('INVALID_ARGUMENT', 'Routine policy requires a registered non-external tool without presence requirements');
        }
        automaticTools.add(JSON.stringify([binding.toolName, binding.toolVersion]));
      }
      const invoker = new RuntimeToolInvoker(this.runtime, descriptors);
      this.tools = {list: () => structuredClone(descriptors), invoke: async invocation => {
        const tool = descriptors.find(item => item.name === invocation.toolName && item.version === invocation.toolVersion);
        if (!tool) throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'Tool is not registered');
        validateToolValue(tool.inputSchema, invocation.arguments);
        const observationSession = this.runtime.loadCheckpoint(invocation.taskId, SYSTEM_OBSERVATION_SESSION_CHECKPOINT);
        if (observationSession !== undefined) {
          if (typeof observationSession !== 'string' || invocation.toolName !== SYSTEM_OBSERVATION_NAME
            || invocation.toolVersion !== SYSTEM_OBSERVATION_VERSION
            || !isDeepStrictEqual(invocation.arguments, {})) {
            throw new ProtocolError('UNAUTHORIZED', 'Invalid observation session invocation');
          }
          this.observationSessions.assertSample(observationSession, invocation.taskId);
        }
        const mailSession = this.runtime.loadCheckpoint(invocation.taskId, MAIL_READ_SESSION_CHECKPOINT);
        if (mailSession !== undefined) {
          if (typeof mailSession !== 'string' || invocation.toolName !== MAIL_READ_TOOL
            || invocation.toolVersion !== MAIL_READ_VERSION) throw new ProtocolError('UNAUTHORIZED', 'Invalid inbox invocation');
          this.mailReadSessions.assertPage(mailSession, invocation.taskId);
        }
        const ref = invocation.runId;
        if (!this.runtime.policy.get(ref) && automaticTools.has(JSON.stringify([tool.name, tool.version]))) {
          const decisionKey = `routine-tool-policy:${ref}`;
          if (this.runtime.loadCheckpoint(invocation.taskId, decisionKey)) {
            throw new ProtocolError('UNAUTHORIZED', 'Routine tool grant was revoked');
          }
          if (invocation.signal.aborted || this.runtime.getTask(invocation.taskId).state !== 'running'
            || Date.parse(invocation.deadline) <= this.now().getTime()) {
            throw new ProtocolError('CANCELLED', 'Routine task is no longer active');
          }
          const argumentsDigest = toolArgumentsDigest(invocation.arguments);
          this.runtime.saveCheckpoint(invocation.taskId, decisionKey, {toolName:tool.name,
            toolVersion:tool.version, argumentsDigest, source:'trusted-routine-tool-policy'});
          this.runtime.policy.grant({authorizationRef:ref,taskId:invocation.taskId,toolName:tool.name,
            scopes:tool.requiredScopes,argumentsDigest,maxUses:1,expiresAt:invocation.deadline});
        }
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
    if (options.competitionToolAvailability !== undefined) {
      if (!this.tools) throw new ProtocolError('INVALID_ARGUMENT', 'Competition tool catalog needs registered tools');
      this.competitionToolCatalog = new RuntimeCompetitionToolCatalog(
        this.runtime, this.tools, this.competitionToolExports, options.competitionToolAvailability);
    }
    this.textApplication = createTextApplication({...options.text, ...(this.tools ? {tools: this.tools} : {})});
  }

  get deployment(): TextApplication['deployment'] { this.requireLocalText(); return structuredClone(this.textApplication.deployment); }
  get activeTaskCount(): number { return this.activeTextTasks.size; }

  configureThinking(config: ThinkingConfig): ThinkingState {
    const depth = Number(config?.depth);
    if (!Number.isInteger(depth) || depth < 0 || depth > 5) {
      throw new ProtocolError('INVALID_ARGUMENT', 'Thinking depth must be an integer between 0 and 5');
    }
    const fast = Boolean(config?.fast);
    this.thinkingConfig = {depth, fast};
    this.competitionMaxSteps = this.calculateThinkingMaxSteps(depth, fast);
    const labels = ['最低', '低', '平衡', '深入', '高', '最高'];
    const effortLevels: ('none' | 'low' | 'medium' | 'high')[] = ['none', 'low', 'low', 'medium', 'high', 'high'];
    const effort = effortLevels[depth] ?? 'low';
    const isReasoningSupported = false;
    const reasoningReason = isReasoningSupported
      ? `模型推理思考已配置（effort: ${effort}）`
      : `主模型当前未开放原生 reasoning 参数，思考深度作为任务步骤预算（maxSteps: ${this.competitionMaxSteps}）独立生效；若使用支持 reasoning 的子模型将透传推理参数`;

    return {
      depth,
      fast,
      maxSteps: this.competitionMaxSteps,
      applied: true,
      reason: `思考深度已传入 Runtime：深度 ${labels[depth]}（${fast ? '快速模式' : '标准模式'}，最大步数 ${this.competitionMaxSteps}）。${reasoningReason}`,
      stepBudget: {
        maxSteps: this.competitionMaxSteps,
        fast,
        description: `最大编排执行步数：${this.competitionMaxSteps} 步`,
      },
      modelReasoning: {
        supported: isReasoningSupported,
        effort,
        reason: reasoningReason,
      },
    };
  }

  getThinkingState(): ThinkingState {
    const {depth, fast} = this.thinkingConfig;
    const maxSteps = this.calculateThinkingMaxSteps(depth, fast);
    const labels = ['最低', '低', '平衡', '深入', '高', '最高'];
    const effortLevels: ('none' | 'low' | 'medium' | 'high')[] = ['none', 'low', 'low', 'medium', 'high', 'high'];
    const effort = effortLevels[depth] ?? 'low';
    const isReasoningSupported = false;
    const reasoningReason = isReasoningSupported
      ? `模型推理思考已配置（effort: ${effort}）`
      : `主模型当前未开放原生 reasoning 参数，思考深度作为任务步骤预算（maxSteps: ${maxSteps}）独立生效；若使用支持 reasoning 的子模型将透传推理参数`;

    return {
      depth,
      fast,
      maxSteps,
      applied: true,
      reason: `思考深度已传入 Runtime：深度 ${labels[depth]}（${fast ? '快速模式' : '标准模式'}，最大步数 ${maxSteps}）。${reasoningReason}`,
      stepBudget: {
        maxSteps,
        fast,
        description: `最大编排执行步数：${maxSteps} 步`,
      },
      modelReasoning: {
        supported: isReasoningSupported,
        effort,
        reason: reasoningReason,
      },
    };
  }

  private calculateThinkingMaxSteps(depth: number, fast: boolean): number {
    const baseSteps = Math.max(2, (depth + 1) * 2);
    return fast ? Math.max(2, baseSteps - 2) : baseSteps;
  }

  /** Trusted Runtime-managed subagent dispatch tool. Creates and tracks real child tasks. */
  createSubagentDispatchTool(modelGatewayFactory?: (modelName?: string) => import('@personal-agent/models').ModelGateway | undefined): RegisteredTool {
    return createRuntimeSubagentDispatchTool({
      getRuntime: () => this.runtime,
      getTools: () => this.tools,
      ...(modelGatewayFactory ? {getModelGateway: modelGatewayFactory} : {}),
    });
  }

  /** Trusted composition only. Native audio never replaces AgentArts task coordination. */
  createLiveVoiceModel(config: {workspaceId: string; apiKey: string}): Pick<QwenRealtimeModelGateway, 'connect'> {
    if (this.profile !== 'huawei_ict_agentarts') {
      throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'Live voice requires Competition Profile');
    }
    const gateway = new QwenRealtimeModelGateway(config);
    return {connect: request => gateway.connect(request)};
  }

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

  /** Trusted-host entrypoint. The task and original arguments commit atomically. */
  submitHostToolTask(request: SubmitHostToolTaskRequest): HostToolTaskReadback {
    return this.submitBoundHostToolTask(request);
  }

  /** Trusted host recovery entry for one persisted workspace patch task. */
  reconcileWorkspacePatchTask(taskId: string): Promise<WorkspacePatchReconciliationReadback> {
    if (!this.workspacePatchReconciliation) {
      throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'Workspace patch reconciliation is not configured');
    }
    return this.workspacePatchReconciliation.reconcile(taskId);
  }

  /** Trusted UI consent only; no wire operation or generic tool permission. */
  startSystemObservationSession(request: StartSystemObservationSessionRequest): SystemObservationSession {
    if (this.profile !== 'huawei_ict_agentarts' || !this.hostUserNamespace) {
      throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'System observation is not configured');
    }
    const descriptor = this.hostToolDescriptor(SYSTEM_OBSERVATION_NAME, SYSTEM_OBSERVATION_VERSION);
    if (descriptor.sideEffect !== 'read' || descriptor.requiresPresence
      || descriptor.requiredScopes.length !== 1 || descriptor.requiredScopes[0] !== SYSTEM_OBSERVATION_SCOPE) {
      throw new ProtocolError('UNAUTHORIZED', 'System observation must retain its fixed read-only scope');
    }
    return this.observationSessions.start(request);
  }

  sampleSystemObservationSession(sessionId: string): {state: 'sampled' | 'busy' | 'not_due'; sessionId: string; sample?: HostToolTaskReadback} {
    const next = this.observationSessions.next(sessionId, taskId =>
      this.activeTextTasks.has(taskId) || !['succeeded', 'failed', 'cancelled'].includes(this.runtime.getTask(taskId).state));
    if (next.state !== 'ready') return {state: next.state, sessionId,
      ...(next.taskId ? {sample: this.readHostToolTask(next.taskId)} : {})};
    return {state: 'sampled', sessionId, sample: this.submitBoundHostToolTask({
      commandId: next.commandId, toolName: SYSTEM_OBSERVATION_NAME,
      toolVersion: SYSTEM_OBSERVATION_VERSION, arguments: {}, deadline: next.deadline,
    }, sessionId)};
  }

  stopSystemObservationSession(sessionId: string): {stopped: boolean} {
    return this.observationSessions.stop(sessionId);
  }

  /** Read only a successful system observation still bound to the current process-local consent lease. */
  readCurrentSystemObservationSample(taskId: string): ConfirmedSystemObservationSample | undefined {
    const sessionId = this.runtime.loadCheckpoint(taskId, SYSTEM_OBSERVATION_SESSION_CHECKPOINT);
    if (typeof sessionId !== 'string') return undefined;
    let samplingIntervalMs: number;
    try { samplingIntervalMs = this.observationSessions.sampleIntervalMs(sessionId, taskId); }
    catch (error) {
      if (error instanceof ProtocolError && ['UNAUTHORIZED', 'TIMEOUT'].includes(error.code)) return undefined;
      throw error;
    }
    const readback = this.readHostToolTask(taskId);
    if (readback.toolName !== SYSTEM_OBSERVATION_NAME || readback.toolVersion !== SYSTEM_OBSERVATION_VERSION
      || readback.task.state !== 'succeeded' || !readback.confirmed?.evidenceRefs.length) return undefined;
    const result = readback.confirmed.result;
    if (!result || typeof result !== 'object' || Array.isArray(result)) return undefined;
    const sample = result as {source?: unknown; capturedAt?: unknown; cpu?: {utilizationPercent?: unknown}; memory?: {utilizationPercent?: unknown}};
    const timestamp = sample.capturedAt;
    const cpuPercent = sample.cpu?.utilizationPercent;
    const memoryPercent = sample.memory?.utilizationPercent;
    if (sample.source !== 'node:os' || typeof timestamp !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp)
      || !Number.isFinite(Date.parse(timestamp))
      || typeof cpuPercent !== 'number' || !Number.isFinite(cpuPercent) || cpuPercent < 0 || cpuPercent > 100
      || typeof memoryPercent !== 'number' || !Number.isFinite(memoryPercent) || memoryPercent < 0 || memoryPercent > 100) {
      return undefined;
    }
    return {taskId, source: 'node:os', timestamp, cpuPercent, memoryPercent,
      samplingIntervalMs, evidenceRefs: [...readback.confirmed.evidenceRefs]};
  }

  startMailReadSession(request: StartMailReadSessionRequest): MailReadSession {
    if (this.profile !== 'huawei_ict_agentarts' || !this.hostUserNamespace) {
      throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'Inbox session is not configured');
    }
    const descriptor = this.hostToolDescriptor(MAIL_READ_TOOL, MAIL_READ_VERSION);
    if (descriptor.sideEffect !== 'read' || descriptor.requiresPresence
      || descriptor.requiredScopes.length !== 1 || descriptor.requiredScopes[0] !== 'mail:read') {
      throw new ProtocolError('UNAUTHORIZED', 'Inbox session requires the fixed read-only tool');
    }
    return this.mailReadSessions.start(request);
  }
  nextMailReadSession(sessionId: string) {
    const next = this.mailReadSessions.next(sessionId, taskId => this.readHostToolTask(taskId));
    if (next.state !== 'ready') return next;
    return {state: 'submitted' as const, page: this.submitBoundHostToolTask({commandId: next.commandId,
      toolName: MAIL_READ_TOOL, toolVersion: MAIL_READ_VERSION, arguments: next.arguments,
      deadline: next.deadline}, undefined, sessionId)};
  }
  stopMailReadSession(sessionId: string): {stopped: boolean} {return this.mailReadSessions.stop(sessionId);}

  private submitBoundHostToolTask(request: SubmitHostToolTaskRequest, observationSession?: string, mailSession?: string): HostToolTaskReadback {
    if (!this.hostUserNamespace || !this.tools) throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'Host tool tasks are not configured');
    if (!HOST_ID.test(request.commandId)) throw new ProtocolError('INVALID_ARGUMENT', 'Invalid host command ID');
    const descriptor = this.hostToolDescriptor(request.toolName, request.toolVersion);
    const deadlineMs = Date.parse(request.deadline);
    if (!Number.isFinite(deadlineMs)) throw new ProtocolError('INVALID_ARGUMENT', 'Invalid host tool deadline');
    const idempotencyKey = `host-tool:${JSON.stringify([this.hostUserNamespace, request.commandId])}`;
    const existing = this.runtime.findTaskByIdempotencyKey(idempotencyKey);
    if (existing && this.runtime.loadCheckpoint(existing.taskId,
      HOST_TOOL_PREPARATION_CHECKPOINT) !== undefined) {
      throw new ProtocolError('REVISION_CONFLICT', 'Prepared host tool command requires finalization');
    }
    if (!existing && deadlineMs <= this.now().getTime()) throw new ProtocolError('TIMEOUT', 'Host tool deadline has expired');
    const args = this.hostToolArguments(descriptor, request.arguments);
    const workspaceBindingId = this.workspacePatchBindingFor(descriptor.name);
    const intent: HostToolIntent = {
      namespace: this.hostUserNamespace, commandId: request.commandId,
      toolName: descriptor.name, toolVersion: descriptor.version, arguments: args,
      argumentsDigest: toolArgumentsDigest(args), deadline: request.deadline,
      ...(workspaceBindingId ? {workspaceBindingId} : {}),
    };
    const task = this.runtime.submitTaskWithCheckpoint({
      goal: `Host tool ${descriptor.name}`, conversationId: `host-tool:${this.hostUserNamespace}`,
      idempotencyKey,
    }, HOST_TOOL_CHECKPOINT, intent);
    if (observationSession !== undefined) {
      this.observationSessions.bind(observationSession, task.taskId);
      this.runtime.saveCheckpoint(task.taskId, SYSTEM_OBSERVATION_SESSION_CHECKPOINT, observationSession);
      this.runtime.policy.grant({authorizationRef: `host-tool-${task.taskId}`, taskId: task.taskId,
        toolName: SYSTEM_OBSERVATION_NAME, scopes: [SYSTEM_OBSERVATION_SCOPE],
        expiresAt: request.deadline, maxUses: 1, argumentsDigest: intent.argumentsDigest});
    }
    if (mailSession !== undefined) {
      this.mailReadSessions.bind(mailSession, task.taskId);
      this.runtime.saveCheckpoint(task.taskId, MAIL_READ_SESSION_CHECKPOINT, mailSession);
      this.runtime.policy.grant({authorizationRef: `host-tool-${task.taskId}`, taskId: task.taskId,
        toolName: MAIL_READ_TOOL, scopes: ['mail:read'], expiresAt: request.deadline,
        maxUses: 1, argumentsDigest: intent.argumentsDigest});
    }
    this.dispatchOrReconcileHostToolTask(task);
    return this.readHostToolTask(task.taskId);
  }

  /** Trusted host creates a stable task ID before observing a short-lived external target. */
  prepareHostToolTask(request: PrepareHostToolTaskRequest): TaskSnapshot {
    if (!this.hostUserNamespace || !this.tools) throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'Host tool tasks are not configured');
    if (!HOST_ID.test(request.commandId)) throw new ProtocolError('INVALID_ARGUMENT', 'Invalid host command ID');
    const descriptor = this.hostToolDescriptor(request.toolName, request.toolVersion);
    const deadlineMs = Date.parse(request.deadline);
    if (!Number.isFinite(deadlineMs)) throw new ProtocolError('INVALID_ARGUMENT', 'Invalid host tool deadline');
    const idempotencyKey = `host-tool:${JSON.stringify([this.hostUserNamespace, request.commandId])}`;
    const existing = this.runtime.findTaskByIdempotencyKey(idempotencyKey);
    if (existing && (existing.state !== 'created'
      || this.runtime.loadCheckpoint(existing.taskId, HOST_TOOL_PREPARATION_CHECKPOINT) === undefined
      || this.runtime.loadCheckpoint(existing.taskId, HOST_TOOL_CHECKPOINT) !== undefined)) {
      throw new ProtocolError('REVISION_CONFLICT', 'Host tool command is no longer preparable');
    }
    if (!existing && deadlineMs <= this.now().getTime()) throw new ProtocolError('TIMEOUT', 'Host tool deadline has expired');
    const workspaceBindingId = this.workspacePatchBindingFor(descriptor.name);
    if (existing) {
      const prior = this.runtime.loadCheckpoint(existing.taskId, HOST_TOOL_PREPARATION_CHECKPOINT) as HostToolPreparation | undefined;
      if (prior?.workspaceBindingId !== workspaceBindingId) {
        throw new ProtocolError('REVISION_CONFLICT', 'Prepared workspace patch belongs to a different workspace');
      }
    }
    const preparation: HostToolPreparation = {namespace: this.hostUserNamespace,
      commandId: request.commandId, toolName: descriptor.name,
      toolVersion: descriptor.version, deadline: request.deadline,
      ...(workspaceBindingId ? {workspaceBindingId} : {})};
    return this.runtime.submitTaskWithCheckpoint({
      goal: `Host tool ${descriptor.name}`, conversationId: `host-tool:${this.hostUserNamespace}`,
      idempotencyKey,
    }, HOST_TOOL_PREPARATION_CHECKPOINT, preparation);
  }

  /** Freeze observed arguments at the prepared revision, then enter existing approval flow. */
  finalizeHostToolTask(request: FinalizeHostToolTaskRequest): HostToolTaskReadback {
    if (!this.hostUserNamespace || !this.tools) throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'Host tool tasks are not configured');
    if (!HOST_ID.test(request.commandId)) throw new ProtocolError('INVALID_ARGUMENT', 'Invalid host command ID');
    const preparation = this.runtime.loadCheckpoint(request.taskId,
      HOST_TOOL_PREPARATION_CHECKPOINT) as HostToolPreparation | undefined;
    if (!preparation || preparation.namespace !== this.hostUserNamespace
      || preparation.commandId !== request.commandId) {
      throw new ProtocolError('NOT_FOUND', 'Prepared host tool task not found');
    }
    const descriptor = this.hostToolDescriptor(preparation.toolName, preparation.toolVersion);
    const workspaceBindingId = this.workspacePatchBindingFor(descriptor.name);
    if (preparation.workspaceBindingId !== workspaceBindingId) {
      throw new ProtocolError('REVISION_CONFLICT', 'Prepared workspace patch belongs to a different workspace');
    }
    const args = this.hostToolArguments(descriptor, request.arguments);
    const intent: HostToolIntent = {...preparation, arguments: args,
      argumentsDigest: toolArgumentsDigest(args)};
    const previous = this.runtime.loadCheckpoint(request.taskId, HOST_TOOL_CHECKPOINT);
    if (previous !== undefined) {
      if (!isDeepStrictEqual(previous, intent)) throw new ProtocolError('REVISION_CONFLICT', 'Host tool arguments changed after finalization');
    } else {
      if (Date.parse(preparation.deadline) <= this.now().getTime()) throw new ProtocolError('TIMEOUT', 'Host tool deadline has expired');
      const created = this.runtime.saveCheckpointOnceForCreatedTask(request.taskId,
        HOST_TOOL_CHECKPOINT, intent, request.expectedTaskRevision);
      if (!created && !isDeepStrictEqual(this.runtime.loadCheckpoint(request.taskId, HOST_TOOL_CHECKPOINT), intent)) {
        throw new ProtocolError('REVISION_CONFLICT', 'Host tool arguments changed during finalization');
      }
    }
    this.dispatchOrReconcileHostToolTask(this.runtime.getTask(request.taskId));
    return this.readHostToolTask(request.taskId);
  }

  /** A prepared task with no frozen arguments can be cancelled without a tool attempt. */
  cancelPreparedHostToolTask(taskId: string, commandId: string, expectedTaskRevision: number): TaskSnapshot {
    if (!this.hostUserNamespace) throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'Host tool tasks are not configured');
    const preparation = this.runtime.loadCheckpoint(taskId,
      HOST_TOOL_PREPARATION_CHECKPOINT) as HostToolPreparation | undefined;
    if (!preparation || preparation.namespace !== this.hostUserNamespace
      || preparation.commandId !== commandId) throw new ProtocolError('NOT_FOUND', 'Prepared host tool task not found');
    return this.runtime.cancelCreatedTaskWithoutCheckpoint(taskId,
      HOST_TOOL_CHECKPOINT, expectedTaskRevision);
  }

  private hostToolArguments(descriptor: ToolDescriptor, raw: Record<string, unknown>): Record<string, unknown> {
    let args: Record<string, unknown>;
    try { args = structuredClone(raw); }
    catch { throw new ProtocolError('INVALID_ARGUMENT', 'Host tool arguments must be cloneable'); }
    try {
      const persisted = JSON.parse(JSON.stringify(args)) as Record<string, unknown>;
      if (!isDeepStrictEqual(persisted, args)) throw Error();
      args = persisted;
    } catch { throw new ProtocolError('INVALID_ARGUMENT', 'Host tool arguments must retain their JSON value'); }
    validateToolValue(descriptor.inputSchema, args);
    return args;
  }

  private dispatchOrReconcileHostToolTask(task: TaskSnapshot): void {
    if (task.state === 'created') this.dispatchHostToolTask(task.taskId);
    else if (['planning', 'running', 'verifying'].includes(task.state) && !this.activeTextTasks.has(task.taskId)) {
      this.runtime.transitionTask(task.taskId, 'waiting_reconciliation', {
        error: {code: 'RESULT_UNKNOWN', message: 'Host tool was interrupted; reconcile its result before retrying', retryable: false},
      });
    } else if (task.state === 'waiting_approval') this.resumeHostToolTask(task.taskId);
    else if (task.state === 'waiting_reconciliation' && this.workspacePatchReconciliation
      && this.workspacePatchReconciliation.isPatchTask(task.taskId)) {
      void this.reconcileWorkspacePatchTask(task.taskId).catch(() => {
        // The task and original Evidence remain waiting_reconciliation. A
        // trusted host may retry the same recovery entry after observing the
        // persisted reason; no new tool invocation is scheduled here.
      });
    }
  }

  /** Call after restart for a persisted allowed approval that predated dispatch. */
  resumeHostToolTask(taskId: string): HostToolTaskReadback {
    const readback = this.readHostToolTask(taskId);
    if (readback.task.state === 'waiting_approval' && readback.approval?.state === 'allowed') {
      this.resumeTask(taskId);
    }
    return this.readHostToolTask(taskId);
  }

  /** Trusted-host readback; raw tool results never enter the public task snapshot. */
  readHostToolTask(taskId: string): HostToolTaskReadback {
    const intent = this.runtime.loadCheckpoint(taskId, HOST_TOOL_CHECKPOINT) as HostToolIntent | undefined;
    if (!intent || intent.namespace !== this.hostUserNamespace) throw new ProtocolError('NOT_FOUND', 'Host tool task not found');
    const task = this.runtime.getTask(taskId);
    const runId = `host-tool-${taskId}`;
    const record = this.runtime.readToolExecutions(taskId).find(item => item.evidenceId === runId);
    const result = record?.state === 'confirmed'
      ? this.runtime.loadCheckpoint(taskId, `tool-result-${runId}`) as {result: unknown} | undefined : undefined;
    let approval: HostToolTaskReadback['approval'];
    if (task.state === 'waiting_approval' || record?.state === 'confirmed') {
      try {
        const value = this.runtime.getApproval(runId);
        approval = {approvalId: value.approvalId, revision: value.revision, state: value.state};
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'NOT_FOUND')) throw error;
      }
    }
    return {commandId: intent.commandId, toolName: intent.toolName, toolVersion: intent.toolVersion,
      task, ...(approval ? {approval} : {}),
      ...(task.state === 'succeeded' && result ? {confirmed: {runId, result: result.result, evidenceRefs: [runId]}} : {})};
  }

  private workspacePatchBindingFor(toolName: string): string | undefined {
    if (toolName !== WORKSPACE_PATCH_APPLY_TOOL_NAME) return undefined;
    const bindingId = this.workspacePatchReconciliation?.bindingId;
    if (typeof bindingId !== 'string' || !/^[a-f0-9]{64}$/u.test(bindingId)) {
      throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'Workspace patch recovery is not bound to a trusted workspace');
    }
    return bindingId;
  }

  private hostToolDescriptor(name: string, version: string): ToolDescriptor {
    const descriptor = this.tools?.list().find(tool => tool.name === name && tool.version === version);
    if (!descriptor) throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'Host tool is not registered at this version');
    return descriptor;
  }

  private dispatchHostToolTask(taskId: string, resume = false): void {
    if (this.activeTextTasks.has(taskId)) return;
    const intent = this.runtime.loadCheckpoint(taskId, HOST_TOOL_CHECKPOINT) as HostToolIntent | undefined;
    if (!intent || intent.namespace !== this.hostUserNamespace || !this.tools) throw new ProtocolError('NOT_FOUND', 'Host tool intent not found');
    const descriptor = this.hostToolDescriptor(intent.toolName, intent.toolVersion);
    const execution = this.runtime.runTask(taskId, async context => {
      const args = structuredClone(intent.arguments);
      if (toolArgumentsDigest(args) !== intent.argumentsDigest) throw new ProtocolError('REVISION_CONFLICT', 'Host tool arguments changed');
      validateToolValue(descriptor.inputSchema, args);
      const runId = `host-tool-${taskId}`;
      const result = await this.tools!.invoke({taskId, runId, authorizationRef: runId,
        toolName: descriptor.name, toolVersion: descriptor.version, arguments: args,
        deadline: context.deadline, signal: context.signal});
      if (result.state === 'pending') return {resultSummary: 'Host tool awaits approval', evidenceRefs: result.evidenceRefs};
      if (result.state === 'unknown') return {resultSummary: 'Host tool requires reconciliation', evidenceRefs: result.evidenceRefs};
      return {resultSummary: 'Host tool result confirmed', evidenceRefs: result.evidenceRefs};
    }, {deadline: intent.deadline, sideEffect: descriptor.sideEffect, ...(resume ? {resume: true} : {})})
      .finally(() => this.activeTextTasks.delete(taskId));
    this.activeTextTasks.set(taskId, execution);
    void execution.catch(() => {});
  }

  private requireLocalText(): void {
    if (this.profile !== 'local') throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'Local text configuration is unavailable in competition profile');
  }

  readEvents(afterSequence = 0): Event[] { return this.runtime.readEvents(afterSequence); }

  /** Trusted host only: binds an independently verified public source to durable Fact/Graph projection. */
  createCompetitionFactHost(options: CompetitionFactHostOptions): CompetitionFactHost {
    const memoryPath = resolve(options.memoryPath);
    if ((process.platform === 'win32' ? memoryPath.toLowerCase() : memoryPath)
      === (process.platform === 'win32' ? this.storagePath.toLowerCase() : this.storagePath)) {
      throw new ProtocolError('INVALID_ARGUMENT', 'Competition Memory requires a separate SQLite file');
    }
    return createCompetitionFactHost(this, options);
  }

  /** Trusted host only: session ownership must be checked on every metadata read. */
  createEvidenceReader(options: Omit<EvidenceReaderOptions, 'runtime'>): ScopedEvidenceReader {
    return new ScopedEvidenceReader({...options, runtime: this.runtime});
  }

  /** Trusted host only. Stops future grant consumption; it cannot undo an execution already started. */
  async revokeHostAuthorization(input: RevokeHostAuthorizationRequest): Promise<RevokeHostAuthorizationResult> {
    const bounded = (value: unknown): value is string => typeof value === 'string'
      && value.length > 0 && value.length <= 256 && value.trim() === value;
    if (!bounded(input.subjectRef) || !bounded(input.conversationId) || !bounded(input.taskId)
      || !bounded(input.authorizationRef) || !Number.isInteger(input.expectedApprovalRevision)
      || input.expectedApprovalRevision < 1 || typeof input.authorize !== 'function') {
      throw new ProtocolError('INVALID_ARGUMENT', 'Invalid host authorization revocation request');
    }
    const scope = Object.freeze({subjectRef: input.subjectRef, conversationId: input.conversationId,
      taskId: input.taskId, authorizationRef: input.authorizationRef});
    let allowed = false;
    try { allowed = await input.authorize(scope) === true; } catch { /* host details stay private */ }
    if (!allowed) throw new ProtocolError('UNAUTHORIZED', 'Authorization revocation denied');
    let task: TaskSnapshot;
    let approval: ReturnType<TaskRuntime['getApproval']>;
    try {
      task = this.runtime.getTask(input.taskId);
      approval = this.runtime.getApproval(input.authorizationRef);
    } catch {
      throw new ProtocolError('UNAUTHORIZED', 'Authorization revocation denied');
    }
    if (task.conversationId !== input.conversationId || approval.taskId !== input.taskId
      || approval.state !== 'allowed' || approval.revision !== input.expectedApprovalRevision) {
      throw new ProtocolError('UNAUTHORIZED', 'Authorization revocation scope changed');
    }
    const grant = this.runtime.policy.get(input.authorizationRef);
    if (grant && (grant.taskId !== input.taskId || grant.toolName !== approval.toolName
      || grant.argumentsDigest !== approval.argumentsDigest)) {
      throw new ProtocolError('UNAUTHORIZED', 'Authorization grant binding changed');
    }
    const revoked = this.runtime.policy.revoke(input.authorizationRef);
    if (this.runtime.policy.get(input.authorizationRef)) {
      throw new ProtocolError('EXTERNAL_FAILURE', 'Authorization revocation readback failed');
    }
    return {revoked, grantPresent: false, approvalRevision: approval.revision};
  }

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
    assertCompetitionExportAllowed(this.runtime, this.tools, this.competitionToolExports, request,
      this.competitionToolCatalog !== undefined);
  }

  /** Trusted host obtains only the task-selected public tool shape for cloud input construction. */
  async prepareCompetitionToolCatalog(input: {taskId: string; deadline: string; signal: AbortSignal}): Promise<CompetitionAvailableTool[]> {
    if (!this.competitionToolCatalog) throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'Competition tool catalog is unavailable');
    return this.competitionToolCatalog.prepare(input);
  }

  /** The cloud adapter calls this after credential reads, immediately before its initial fetch. */
  async assertCompetitionToolCatalogAllowed(input: {taskId: string; revision: number; deadline: string; signal: AbortSignal;
    availableTools: readonly CompetitionAvailableTool[]}): Promise<void> {
    if (!this.competitionToolCatalog) throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'Competition tool catalog is unavailable');
    await this.competitionToolCatalog.assertSelectionCurrent(input);
  }

  configureText(options: TextApplicationOptions): TextApplication['deployment'] {
    this.requireLocalText();
    if (this.activeTextTasks.size) throw new Error('Cannot reconfigure text model while tasks are active');
    this.textApplication = createTextApplication({...options, ...(this.tools ? {tools: this.tools} : {})});
    return this.deployment;
  }

  testTextConnection(options?: Parameters<TextApplication['testConnection']>[0]) { this.requireLocalText(); return this.textApplication.testConnection(options); }
  close(): void { this.observationSessions.stopAll(); this.mailReadSessions.stopAll(); this.runtime.close(); }

  resumeTask(taskId: string): void {
    if (this.activeTextTasks.has(taskId)) return;
    if (this.runtime.getTask(taskId).state !== 'waiting_approval') throw new ProtocolError('REVISION_CONFLICT', 'Task is not awaiting approval');
    if (this.runtime.loadCheckpoint(taskId, HOST_TOOL_CHECKPOINT) !== undefined) {
      const runId = `host-tool-${taskId}`;
      if (this.runtime.getApproval(runId).state !== 'allowed') throw new ProtocolError('UNAUTHORIZED', 'Host tool is not approved');
      this.dispatchHostToolTask(taskId, true);
      return;
    }
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
          ...(this.competitionToolCatalog ? {toolCatalog: this.competitionToolCatalog} : {}),
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
      this.runtime.saveCheckpoint(taskId, 'competition-max-steps', this.competitionMaxSteps);
      this.runtime.saveCheckpoint(taskId, 'task-thinking', {depth: this.thinkingConfig.depth, fast: this.thinkingConfig.fast, maxSteps: this.competitionMaxSteps});
      const execution = Promise.resolve().then(() => startCoordinationTask(
        this.runtime, this.coordination, this.tools, taskId, goal, request.deadline,
        {toolExports: this.competitionToolExports,
          ...(this.competitionToolCatalog ? {toolCatalog: this.competitionToolCatalog} : {}),
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
