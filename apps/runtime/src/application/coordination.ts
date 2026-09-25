import {ProtocolError} from '@personal-agent/contracts';
import type {TaskSnapshot} from '@personal-agent/contracts';
import {parseCoordinationResult, parseCoordinationContinuation, type CoordinationContinuation, type CoordinationPort,
  type CoordinationResult, type CoordinationToolProposalResult} from '@personal-agent/coordination';
import type {AgentToolPort, ToolInvocationResult} from '@personal-agent/agents';
import type {TaskRuntime} from '../index.js';
import {isDeepStrictEqual} from 'node:util';
import type {RuntimeCompetitionToolCatalog} from './tool-catalog.js';

const MAX_COMPETITION_STEPS = 4;

/** Trusted composition only. This permits result export, never tool execution. */
export interface CompetitionToolExport {
  readonly toolName: string;
  readonly toolVersion: string;
  /** Must change whenever the host narrows or changes the projection policy. */
  readonly exportPolicyVersion: string;
  /** Restrict to the explicitly selected synthetic data before local approval. */
  accepts(input: {taskId: string; proposalId: string; arguments: Record<string, unknown>}): boolean;
  /** Return only the permitted projection; raw results and Evidence stay local. */
  project(input: {taskId: string; proposalId: string; result: unknown; signal: AbortSignal}): unknown | Promise<unknown>;
}

interface CompetitionCheckpoint {
  step: number;
  continuation?: CoordinationContinuation;
  pending?: CoordinationToolProposalResult;
  evidenceRefs: string[];
  receipts?: {proposal: CoordinationToolProposalResult; continuation: CoordinationContinuation; exportPolicyVersion?: string}[];
}

function summary(text: string, verification: 'mock' | 'unverified'): string {
  return `${text}\n[profile=huawei_ict_agentarts; verification=${verification}]`;
}

function requireExportBinding(
  proposal: CoordinationToolProposalResult,
  taskId: string,
  tools: AgentToolPort | undefined,
  bindings: readonly CompetitionToolExport[] | undefined,
): CompetitionToolExport | undefined {
  if (proposal.verification === 'mock') return undefined;
  const binding = bindings?.find(item => item.toolName === proposal.toolName && item.toolVersion === proposal.toolVersion);
  if (!binding || !tools?.list().some(tool => tool.name === proposal.toolName
    && tool.version === proposal.toolVersion && tool.sideEffect === 'read')) {
    throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'Real Competition tool result export is unavailable');
  }
  let accepted = false;
  try {
    accepted = binding.accepts({taskId, proposalId: proposal.proposalId,
      arguments: structuredClone(proposal.arguments)}) === true;
  } catch { /* Host errors may include private data. */ }
  if (!accepted) throw new ProtocolError('UNAUTHORIZED', 'Competition result export scope denied');
  return binding;
}

/** Final trusted check for real adapter I/O, after asynchronous credential reads. */
export function assertCompetitionExportAllowed(
  runtime: TaskRuntime,
  tools: AgentToolPort | undefined,
  bindings: readonly CompetitionToolExport[],
  request: {taskId: string; deadline: string; signal: AbortSignal; continuation?: CoordinationContinuation},
): void {
  if (!request.continuation) return;
  const checkpoint = runtime.loadCheckpoint(request.taskId, 'competition-loop') as CompetitionCheckpoint | undefined;
  const receipt = checkpoint?.receipts?.find(item => item.proposal.proposalId === request.continuation?.proposalId);
  if (runtime.getTask(request.taskId).state !== 'running'
    || runtime.loadCheckpoint(request.taskId, 'application-profile') !== 'huawei_ict_agentarts'
    || runtime.loadCheckpoint(request.taskId, 'application-deadline') !== request.deadline
    || !receipt || receipt.proposal.verification === 'mock'
    || !isDeepStrictEqual(receipt.continuation, request.continuation)) {
    throw new ProtocolError('UNAUTHORIZED', 'Competition export is not bound to this task');
  }
  const binding = requireExportBinding(receipt.proposal, request.taskId, tools, bindings);
  if (!binding || !receipt.exportPolicyVersion || binding.exportPolicyVersion !== receipt.exportPolicyVersion) {
    throw new ProtocolError('UNAUTHORIZED', 'Competition result export policy changed');
  }
  if (request.signal.aborted) throw new ProtocolError('CANCELLED', 'Competition result export cancelled');
  if (Date.now() >= Date.parse(request.deadline)) throw new ProtocolError('TIMEOUT', 'Competition result export expired');
}

async function projectResult(binding: CompetitionToolExport, input: Parameters<CompetitionToolExport['project']>[0]): Promise<unknown> {
  let onAbort = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new ProtocolError('CANCELLED', 'Competition result export cancelled'));
    input.signal.addEventListener('abort', onAbort, {once: true});
    if (input.signal.aborted) onAbort();
  });
  try {
    return await Promise.race([Promise.resolve().then(() => {
      if (input.signal.aborted) throw Error();
      return binding.project(input);
    }), cancelled]);
  } finally {
    input.signal.removeEventListener('abort', onAbort);
  }
}

async function exchange(
  runtime: TaskRuntime,
  port: CoordinationPort,
  taskId: string,
  goal: string,
  context: {deadline: string; signal: AbortSignal},
  continuation?: CoordinationContinuation,
  beforeInvoke?: () => void,
): Promise<CoordinationResult> {
  let onAbort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new ProtocolError('CANCELLED', 'Coordination request cancelled'));
    context.signal.addEventListener('abort', onAbort, {once: true});
    if (context.signal.aborted) onAbort();
  });
  try {
    return parseCoordinationResult(await Promise.race([
      Promise.resolve().then(async () => {
        if (context.signal.aborted) throw new ProtocolError('CANCELLED', 'Coordination request cancelled');
        // Recheck dynamic export scope at the actual adapter handoff, after
        // tool execution/projection and on every replay of a saved result.
        beforeInvoke?.();
        try {
          return await port.execute(Object.freeze({
          taskId,
          goal,
          revision: runtime.getTask(taskId).revision,
          deadline: context.deadline,
          signal: context.signal,
          ...(continuation === undefined ? {} : {continuation}),
          }));
        } catch {
          // Adapter errors may contain credentials or private response bodies.
          throw new ProtocolError('EXTERNAL_FAILURE', 'Coordination adapter failed');
        }
      }),
      cancelled,
    ]));
  } finally {
    context.signal.removeEventListener('abort', onAbort);
  }
}

/** Runtime-owned Competition loop. Cloud proposals are untrusted and tools remain locally authorized. */
export function startCoordinationTask(
  runtime: TaskRuntime,
  port: CoordinationPort | undefined,
  tools: AgentToolPort | undefined,
  taskId: string,
  goal: string,
  deadline: string,
  options: {resume?: boolean; toolExports?: readonly CompetitionToolExport[]; toolCatalog?: RuntimeCompetitionToolCatalog; repairCandidateVersion?: '1.0'} = {},
): Promise<TaskSnapshot> {
  return runtime.runTask(taskId, async context => {
    if (!port) throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'Competition coordination is unavailable');
    const saved = context.loadCheckpoint('competition-loop') as CompetitionCheckpoint | undefined;
    let evidenceRefs = saved?.evidenceRefs ?? [];
    let continuation = saved?.continuation;
    let pending = saved?.pending;
    const receipts = saved?.receipts ?? [];

    for (let step = saved?.step ?? 1; step <= MAX_COMPETITION_STEPS; step++) {
      context.reportProgress({
        stepId: `competition-${step}`,
        label: pending ? `awaiting approval for ${pending.toolName}` : 'cloud coordination',
        completedUnits: step - 1,
        totalUnits: MAX_COMPETITION_STEPS,
      });
      if (!pending && options.toolCatalog) await options.toolCatalog.prepare({taskId, deadline: context.deadline, signal: context.signal});
      const result = pending ?? await exchange(runtime, port, taskId, goal, context, continuation, () => {
        const prior = receipts.find(item => item.proposal.proposalId === continuation?.proposalId);
        if (prior) {
          const current = requireExportBinding(prior.proposal, taskId, tools, options.toolExports);
          if (current && (!prior.exportPolicyVersion || current.exportPolicyVersion !== prior.exportPolicyVersion)) {
            throw new ProtocolError('UNAUTHORIZED', 'Competition result export policy changed');
          }
          if (context.signal.aborted) throw new ProtocolError('CANCELLED', 'Competition result export cancelled');
          if (Date.now() >= Date.parse(context.deadline)) throw new ProtocolError('TIMEOUT', 'Competition result export expired');
        }
      });
      if (result.kind === 'text') {
        return {resultSummary: summary(result.text, result.verification), evidenceRefs};
      }
      if (result.kind === 'repair_candidate') {
        if (options.repairCandidateVersion !== '1.0') {
          throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'Repair candidates are not enabled');
        }
        context.saveCheckpoint('competition-repair-candidate', result);
        return {resultSummary: summary('Plan repair candidate is ready for local preview; no plan changes committed', 'unverified'), evidenceRefs};
      }
      const exportBinding = requireExportBinding(result, taskId, tools, options.toolExports);
      if (result.verification !== 'mock' && options.toolCatalog) {
        await options.toolCatalog.assertProposal({taskId, toolName: result.toolName,
          toolVersion: result.toolVersion, arguments: result.arguments,
          deadline: context.deadline, signal: context.signal});
      }
      if (!tools) throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'Competition tool execution is unavailable');

      const receipt = receipts.find(item => item.proposal.proposalId === result.proposalId);
      if (receipt) {
        if (!isDeepStrictEqual(receipt.proposal, result)) {
          throw new ProtocolError('REVISION_CONFLICT', 'Competition proposal identity conflict');
        }
        continuation = receipt.continuation;
        pending = undefined;
        context.saveCheckpoint('competition-loop', {step: step + 1, continuation, evidenceRefs, receipts});
        continue;
      }

      // A new execution needs one further exchange to deliver its result. Do
      // not consume approval or perform a tool action that cannot be continued.
      if (step >= MAX_COMPETITION_STEPS) {
        throw new ProtocolError('TIMEOUT', 'Competition has no remaining tool continuation step');
      }

      const runId = `competition-tool-${taskId}-${step}`;
      context.saveCheckpoint('competition-loop', {step, continuation, pending: result, evidenceRefs, receipts});
      const toolResult: ToolInvocationResult = await tools.invoke({
        toolName: result.toolName,
        toolVersion: result.toolVersion,
        arguments: result.arguments,
        taskId,
        runId,
        authorizationRef: runId,
        deadline: context.deadline,
        signal: context.signal,
      });
      evidenceRefs = [...new Set([...evidenceRefs, ...toolResult.evidenceRefs])];
      if (toolResult.state === 'pending') {
        return {resultSummary: 'Competition tool is awaiting local approval', evidenceRefs};
      }
      if (toolResult.state === 'unknown') {
        return {resultSummary: 'Competition tool result requires reconciliation', evidenceRefs};
      }
      let exportedResult: unknown = toolResult.result ?? null;
      if (result.verification !== 'mock') {
        if (context.signal.aborted) throw new ProtocolError('CANCELLED', 'Competition result export cancelled');
        try {
          exportedResult = await projectResult(exportBinding!, {taskId, proposalId: result.proposalId,
            result: structuredClone(exportedResult), signal: context.signal});
          // Use the existing strict JSON validator: getters, cycles, unsupported
          // values and oversized projections must never reach the cloud adapter.
          const projected = parseCoordinationContinuation({proposalId: result.proposalId,
            state: 'confirmed', result: exportedResult});
          if (Buffer.byteLength(JSON.stringify(projected), 'utf8') > 8192) throw Error();
          exportedResult = projected.result;
        } catch {
          throw new ProtocolError('UNAUTHORIZED', 'Competition result export denied');
        }
        if (context.signal.aborted) throw new ProtocolError('CANCELLED', 'Competition result export cancelled');
      }
      continuation = {
        proposalId: result.proposalId,
        state: 'confirmed',
        result: exportedResult,
      };
      receipts.push({proposal: result, continuation,
        ...(exportBinding ? {exportPolicyVersion: exportBinding.exportPolicyVersion} : {})});
      pending = undefined;
      context.saveCheckpoint('competition-loop', {step: step + 1, continuation, evidenceRefs, receipts});
    }
    throw new ProtocolError('TIMEOUT', `Competition coordination reached maxSteps=${MAX_COMPETITION_STEPS}`);
  }, {deadline, sideEffect: 'read', ...(options.resume ? {resume: true} : {})});
}
