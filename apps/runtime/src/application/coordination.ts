import {ProtocolError} from '@personal-agent/contracts';
import type {TaskSnapshot} from '@personal-agent/contracts';
import {parseCoordinationResult, type CoordinationContinuation, type CoordinationPort,
  type CoordinationResult, type CoordinationToolProposalResult} from '@personal-agent/coordination';
import type {AgentToolPort, ToolInvocationResult} from '@personal-agent/agents';
import type {TaskRuntime} from '../index.js';

const MAX_COMPETITION_STEPS = 4;

interface CompetitionCheckpoint {
  step: number;
  continuation?: CoordinationContinuation;
  pending?: CoordinationToolProposalResult;
  evidenceRefs: string[];
}

function summary(text: string, verification: 'mock' | 'unverified'): string {
  return `${text}\n[profile=huawei_ict_agentarts; verification=${verification}]`;
}

async function exchange(
  runtime: TaskRuntime,
  port: CoordinationPort,
  taskId: string,
  goal: string,
  context: {deadline: string; signal: AbortSignal},
  continuation?: CoordinationContinuation,
): Promise<CoordinationResult> {
  let onAbort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new ProtocolError('CANCELLED', 'Coordination request cancelled'));
    context.signal.addEventListener('abort', onAbort, {once: true});
    if (context.signal.aborted) onAbort();
  });
  try {
    return parseCoordinationResult(await Promise.race([
      Promise.resolve().then(() => {
        if (context.signal.aborted) throw new ProtocolError('CANCELLED', 'Coordination request cancelled');
        return port.execute(Object.freeze({
          taskId,
          goal,
          revision: runtime.getTask(taskId).revision,
          deadline: context.deadline,
          signal: context.signal,
          ...(continuation === undefined ? {} : {continuation}),
        }));
      }).catch(() => {
        // Adapter errors may contain credentials or private response bodies.
        throw new ProtocolError('EXTERNAL_FAILURE', 'Coordination adapter failed');
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
  options: {resume?: boolean} = {},
): Promise<TaskSnapshot> {
  return runtime.runTask(taskId, async context => {
    if (!port) throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'Competition coordination is unavailable');
    const saved = context.loadCheckpoint('competition-loop') as CompetitionCheckpoint | undefined;
    let evidenceRefs = saved?.evidenceRefs ?? [];
    let continuation = saved?.continuation;
    let pending = saved?.pending;

    for (let step = saved?.step ?? 1; step <= MAX_COMPETITION_STEPS; step++) {
      context.reportProgress({
        stepId: `competition-${step}`,
        label: pending ? `awaiting approval for ${pending.toolName}` : 'cloud coordination',
        completedUnits: step - 1,
        totalUnits: MAX_COMPETITION_STEPS,
      });
      const result = pending ?? await exchange(runtime, port, taskId, goal, context, continuation);
      if (result.kind === 'text') {
        return {resultSummary: summary(result.text, result.verification), evidenceRefs};
      }
      if (result.verification !== 'mock') {
        throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'Real Competition tool result export is unavailable');
      }
      if (!tools) throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'Competition tool execution is unavailable');

      const runId = `competition-tool-${taskId}-${step}`;
      context.saveCheckpoint('competition-loop', {step, continuation, pending: result, evidenceRefs});
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
      continuation = {
        proposalId: result.proposalId,
        state: 'confirmed',
        result: toolResult.result ?? null,
      };
      pending = undefined;
      context.saveCheckpoint('competition-loop', {step: step + 1, continuation, evidenceRefs});
    }
    throw new ProtocolError('TIMEOUT', `Competition coordination reached maxSteps=${MAX_COMPETITION_STEPS}`);
  }, {deadline, sideEffect: 'read', ...(options.resume ? {resume: true} : {})});
}
