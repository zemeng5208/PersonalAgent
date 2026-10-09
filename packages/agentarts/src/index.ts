import {ProtocolError, validateToolValue} from '@personal-agent/contracts';
import {parseCoordinationResult} from '@personal-agent/coordination';
import type {CoordinationResult} from '@personal-agent/coordination';
import {ModelGateway} from '@personal-agent/models';
import type {ModelPort} from '@personal-agent/models';
import {parseAgentInput, repairInput, record} from './input.js';
import type {AgentInput, RepairContext} from './input.js';
import {FAST_PROMPT, DISPATCH_PROMPT, WORLD_PROMPT, PLAN_PROMPT, REVIEW_PROMPT, PROMPT_VERSION} from './prompts.js';
export {parseAgentInput, PROMPT_VERSION};
export type {AgentInput};

export type AgentRole = 'fast' | 'world' | 'plan' | 'review';
export interface AgentInvocation {query: string; deadline: string; signal: AbortSignal; sessionId: string; requestId: string}
export interface RoleReceipt {role: AgentRole; requestId: string; promptVersion: string; status: 'started' | 'completed' | 'failed'; totalTokens?: number}
export type AgentOutput = Omit<Extract<CoordinationResult, {kind: 'text'}>, 'verification'>
  | Omit<Extract<CoordinationResult, {kind: 'tool_proposal'}>, 'verification'>
  | Omit<Extract<CoordinationResult, {kind: 'repair_candidate'}>, 'verification'>;

/** Cloud-only orchestration. There is deliberately no ToolHost, TaskRuntime or persistence. */
export class OwnedAgentOrchestrator {
  private readonly models: Record<AgentRole, ModelGateway>;
  constructor(models: Record<AgentRole, ModelPort>, private readonly maxOutputTokens: number,
    private readonly onReceipt?: (receipt: RoleReceipt) => void) {
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) throw new ProtocolError('INVALID_ARGUMENT', 'Invalid model budget');
    this.models = {fast: new ModelGateway(models.fast), world: new ModelGateway(models.world),
      plan: new ModelGateway(models.plan), review: new ModelGateway(models.review)};
  }
  async invoke(request: AgentInvocation): Promise<AgentOutput> {
    if (!(request.signal instanceof AbortSignal) || !Number.isFinite(Date.parse(request.deadline))) {
      throw new ProtocolError('INVALID_ARGUMENT', 'Invalid invocation control');
    }
    this.check(request);
    const input = parseAgentInput(request.query);
    const repair = repairInput(input);
    let raw: unknown;
    let reviewedChanges: unknown;
    if (repair) {
      const world = await this.call('world', WORLD_PROMPT, repair.data, request);
      this.validateReport(world, false, repair.context);
      if (record(world).disposition !== 'REVISE') return {kind: 'text', text: 'RECHECK：世界状态分析缺少确定的修复依据。'};
      const plan = await this.call('plan', PLAN_PROMPT, {input: repair.data, world}, request);
      this.validateReport(plan, true, repair.context);
      if (record(plan).disposition !== 'REVISE') return {kind: 'text', text: 'RECHECK：计划修复缺少确定依据。'};
      const affected = record(world).affected as string[];
      if ((record(plan).changes as Array<{node: {id: string}}>).some(change => !affected.includes(change.node.id))) {
        throw new ProtocolError('EXTERNAL_FAILURE', 'Plan exceeds world impact scope');
      }
      reviewedChanges = record(plan).changes;
      raw = await this.call('review', REVIEW_PROMPT, {input: repair.data, world, plan}, request);
    } else {
      const deterministic = this.commandReceipt(input);
      if (deterministic) return deterministic;
      raw = await this.call('fast', FAST_PROMPT + DISPATCH_PROMPT, input, request);
    }
    this.check(request);
    const object = record(raw);
    if (Object.hasOwn(object, 'verification')) throw new ProtocolError('EXTERNAL_FAILURE', 'Agent output includes a trust claim');
    let result: CoordinationResult;
    try { result = parseCoordinationResult({...object, verification: 'unverified'}); }
    catch { throw new ProtocolError('EXTERNAL_FAILURE', 'Agent output does not match the application contract'); }
    if (result.kind === 'tool_proposal') {
      if (input.kind !== 'initial' || repair) throw new ProtocolError('EXTERNAL_FAILURE', 'Tool proposal on a result-only route');
      const tool = input.availableTools.find(item => item.name === result.toolName && item.version === result.toolVersion);
      if (!tool) throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'Proposed tool is absent from the host catalog');
      validateToolValue(tool.inputSchema, result.arguments);
    }
    if (result.kind === 'repair_candidate') {
      if (!repair) throw new ProtocolError('EXTERNAL_FAILURE', 'Repair candidate on an ordinary route');
      this.validateChanges(result.candidate, repair.context);
      // Review may reject with text, but cannot silently replace the reviewed plan.
      const normalize = (changes: unknown) => (changes as typeof result.candidate.changes).map(change => ({
        node: {id: change.node.id, revision: change.node.revision}, summary: change.summary, reason: change.reason,
        dependencies: change.dependencies.map(dep => ({id: dep.id, revision: dep.revision})),
      }));
      if (JSON.stringify(normalize(result.candidate.changes)) !== JSON.stringify(normalize(reviewedChanges))) {
        throw new ProtocolError('EXTERNAL_FAILURE', 'Review substituted the proposed plan');
      }
    }
    const {verification: _verification, ...output} = result;
    return output;
  }
  private check(request: AgentInvocation): void {
    if (request.signal.aborted) throw new ProtocolError('CANCELLED', 'Agent invocation cancelled');
    if (Date.parse(request.deadline) <= Date.now()) throw new ProtocolError('TIMEOUT', 'Agent invocation deadline exceeded');
  }
  private emit(role: AgentRole, request: AgentInvocation, status: RoleReceipt['status'], totalTokens?: number): void {
    try { this.onReceipt?.({role, requestId: request.requestId, promptVersion: PROMPT_VERSION, status,
      ...(totalTokens === undefined ? {} : {totalTokens})}); } catch { /* Observability cannot change a result. */ }
  }
  private async call(role: AgentRole, prompt: string, data: unknown, request: AgentInvocation): Promise<unknown> {
    this.check(request); this.emit(role, request, 'started');
    try {
      const result = await this.models[role].complete({messages: [{role: 'system', content: prompt},
        {role: 'user', content: JSON.stringify(data)}], tools: [], requiredCapabilities: ['text'],
        maxOutputTokens: this.maxOutputTokens, reasoningEffort: 'none', deadline: request.deadline, signal: request.signal});
      this.check(request);
      if (result.response.kind !== 'final' || result.response.text.length > 16_000) throw new Error();
      const parsed: unknown = JSON.parse(result.response.text);
      record(parsed);
      this.emit(role, request, 'completed', result.usage?.totalTokens);
      return parsed;
    } catch (error) {
      this.emit(role, request, 'failed');
      if (error instanceof ProtocolError) throw error;
      throw new ProtocolError('EXTERNAL_FAILURE', 'Agent role returned an invalid response');
    }
  }
  private validateReport(value: unknown, plan: boolean, context: RepairContext): void {
    const report = record(value);
    const fields = plan ? ['disposition','changes','missing_information'] : ['disposition','affected','reason','missing_information'];
    if (Object.keys(report).length !== fields.length || fields.some(field => !Object.hasOwn(report, field))
      || !['KEEP','RECHECK','REVISE'].includes(report.disposition as string)
      || !Array.isArray(report.missing_information) || report.missing_information.some(item => typeof item !== 'string')) {
      throw new ProtocolError('EXTERNAL_FAILURE', 'Invalid role report');
    }
    if (report.disposition === 'REVISE' && report.missing_information.length) {
      throw new ProtocolError('EXTERNAL_FAILURE', 'Repair has unresolved missing information');
    }
    if (plan) {
      if (!Array.isArray(report.changes)) throw new ProtocolError('EXTERNAL_FAILURE', 'Invalid plan report');
      if (report.disposition === 'REVISE') this.validateChanges({expectedGraphRevision: context.expectedGraphRevision, changes: report.changes}, context);
      else if (report.changes.length) throw new ProtocolError('EXTERNAL_FAILURE', 'Uncertain plan includes changes');
    } else if (!Array.isArray(report.affected) || typeof report.reason !== 'string'
      || report.affected.some(id => !context.targets.some(target => target.node.id === id))) {
      throw new ProtocolError('EXTERNAL_FAILURE', 'World report exceeds repair scope');
    }
  }
  private validateChanges(value: unknown, context: RepairContext): void {
    let parsed: Extract<CoordinationResult, {kind: 'repair_candidate'}>;
    try { parsed = parseCoordinationResult({kind:'repair_candidate',candidateVersion:'1.0',candidate:value,verification:'unverified'}) as typeof parsed; }
    catch { throw new ProtocolError('EXTERNAL_FAILURE', 'Invalid repair report'); }
    if (parsed.candidate.expectedGraphRevision !== context.expectedGraphRevision) throw new ProtocolError('EXTERNAL_FAILURE', 'Repair revision changed');
    for (const change of parsed.candidate.changes) {
      const target = context.targets.find(item => item.node.id === change.node.id && item.node.revision === change.node.revision);
      const refs = (dependencies: typeof change.dependencies) => JSON.stringify(dependencies.map(dep => [dep.id, dep.revision]));
      if (!target || refs(change.dependencies) !== refs(target.requestedDependencies)
        || (target.requestedSummary !== undefined && change.summary !== target.requestedSummary)) {
        throw new ProtocolError('EXTERNAL_FAILURE', 'Repair changed host constraints');
      }
    }
  }
  private commandReceipt(input: AgentInput): AgentOutput | undefined {
    if (input.kind !== 'continuation') return undefined;
    const value = input.continuation.result;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const result = record(value);
    if (Object.keys(result).sort().join(',') !== 'exitCode,passed,recipeId') return undefined;
    const names: Record<string, string> = {'node-check':'语法检查','npm-build':'构建','npm-test':'测试'};
    if (typeof result.recipeId !== 'string' || !Object.hasOwn(names, result.recipeId)
      || !Number.isSafeInteger(result.exitCode) || typeof result.passed !== 'boolean'
      || result.passed !== (result.exitCode === 0)) throw new ProtocolError('INVALID_ARGUMENT', 'Inconsistent confirmed command result');
    return {kind:'text', text:`传入的已确认检查回执显示：${names[result.recipeId]}${result.passed ? '通过' : '未通过'}，退出码 ${result.exitCode}。`};
  }
}
