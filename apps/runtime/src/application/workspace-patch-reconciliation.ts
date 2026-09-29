import {ProtocolError} from '@personal-agent/contracts';
import type {TaskSnapshot} from '@personal-agent/contracts';
import type {TaskRuntime, ToolExecutionRecord} from '../index.js';

export const WORKSPACE_PATCH_APPLY_TOOL_NAME = 'workspace.apply_text_patch';
export const WORKSPACE_PATCH_APPLY_TOOL_VERSION = '1.0.0';

export type WorkspacePatchReconciliationResult =
  | {path: string; state: 'clear'}
  | {path: string; state: 'in_progress'; pid: number; beforeSha256: string; afterSha256: string}
  | {path: string; state: 'reconciled'; outcome: 'applied' | 'not_applied' | 'unknown';
    beforeSha256: string; afterSha256: string; currentSha256: string};

/**
 * Trusted Desktop composition owns the roots, ACL checks and process identity
 * query. Runtime receives only the original relative source path from the
 * persisted host intent; it cannot receive a PID or a recovery directory.
 */
export interface WorkspacePatchReconciliationPort {
  reconcile(input: {relativePath: string}): Promise<WorkspacePatchReconciliationResult>;
}

export interface WorkspacePatchReconciliationReadback {
  taskId: string;
  runId: string;
  result: WorkspacePatchReconciliationResult;
  task: TaskSnapshot;
  evidence: import('@personal-agent/contracts').ProtocolContracts['evidence'][];
}

interface HostToolIntent {
  namespace: string;
  commandId: string;
  toolName: string;
  toolVersion: string;
  arguments: Record<string, unknown> & {path: string};
  deadline: string;
  argumentsDigest: string;
}

function invalid(message: string): never {
  throw new ProtocolError('REVISION_CONFLICT', message);
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function validateResult(value: unknown): WorkspacePatchReconciliationResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolError('RESULT_UNKNOWN', 'Workspace patch reconciliation returned an invalid result');
  }
  const result = value as Record<string, unknown>;
  if (typeof result.path !== 'string' || result.path.length < 1 || result.path.length > 1024
    || result.path.includes('\\') || result.path.startsWith('/') || result.path.includes('\0')) {
    throw new ProtocolError('RESULT_UNKNOWN', 'Workspace patch reconciliation returned an invalid path');
  }
  if (result.state === 'clear') return {path: result.path, state: 'clear'};
  if (result.state === 'in_progress') {
    if (!Number.isSafeInteger(result.pid) || (result.pid as number) < 1
      || !isHash(result.beforeSha256) || !isHash(result.afterSha256)) {
      throw new ProtocolError('RESULT_UNKNOWN', 'Workspace patch process identity is invalid');
    }
    return {path: result.path, state: 'in_progress', pid: result.pid as number,
      beforeSha256: result.beforeSha256, afterSha256: result.afterSha256};
  }
  if (result.state === 'reconciled' && ['applied', 'not_applied', 'unknown'].includes(String(result.outcome))
    && isHash(result.beforeSha256) && isHash(result.afterSha256) && isHash(result.currentSha256)) {
    return {path: result.path, state: 'reconciled', outcome: result.outcome as 'applied' | 'not_applied' | 'unknown',
      beforeSha256: result.beforeSha256, afterSha256: result.afterSha256, currentSha256: result.currentSha256};
  }
  throw new ProtocolError('RESULT_UNKNOWN', 'Workspace patch reconciliation returned an invalid state');
}

function readIntent(runtime: TaskRuntime, taskId: string, expectedNamespace?: string): HostToolIntent {
  const value = runtime.loadCheckpoint(taskId, 'host-tool-intent');
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Workspace patch host intent is missing');
  const intent = value as HostToolIntent;
  if ((expectedNamespace !== undefined && intent.namespace !== expectedNamespace)
    || intent.toolName !== WORKSPACE_PATCH_APPLY_TOOL_NAME
    || intent.toolVersion !== WORKSPACE_PATCH_APPLY_TOOL_VERSION
    || !intent.arguments || typeof intent.arguments !== 'object' || Array.isArray(intent.arguments)
    || typeof intent.arguments.path !== 'string') {
    invalid('Task is not a workspace patch apply task at the supported version');
  }
  return intent;
}

function readRecord(runtime: TaskRuntime, taskId: string, runId: string): ToolExecutionRecord {
  const record = runtime.readToolExecutions(taskId).find(item => item.evidenceId === runId);
  if (!record || record.taskId !== taskId || record.toolName !== WORKSPACE_PATCH_APPLY_TOOL_NAME
    || record.toolVersion !== WORKSPACE_PATCH_APPLY_TOOL_VERSION) {
    invalid('Workspace patch execution record is missing or mismatched');
  }
  if (record.policyDecision !== 'allow' || record.executionStarted !== true) {
    throw new ProtocolError('UNAUTHORIZED', 'Workspace patch execution was not authorized by Runtime');
  }
  return record;
}

function savedResult(runtime: TaskRuntime, taskId: string, runId: string,
  path: string, record: ToolExecutionRecord): WorkspacePatchReconciliationResult | undefined {
  if (!record.reconciliationOutcome) return undefined;
  const checkpoint = runtime.loadCheckpoint(taskId, 'tool-reconciliation-' + runId) as {result?: unknown} | undefined;
  if (!checkpoint || checkpoint.result === undefined) {
    throw new ProtocolError('RESULT_UNKNOWN', 'Workspace patch reconciliation checkpoint is missing');
  }
  const result = validateResult(checkpoint.result);
  if (result.state !== 'reconciled' || result.path !== path || result.outcome !== record.reconciliationOutcome) {
    throw new ProtocolError('REVISION_CONFLICT', 'Workspace patch reconciliation checkpoint is mismatched');
  }
  return result;
}

export class WorkspacePatchReconciliationAdapter {
  private readonly active = new Map<string, Promise<WorkspacePatchReconciliationReadback>>();

  constructor(private readonly runtime: TaskRuntime, private readonly port: WorkspacePatchReconciliationPort,
    private readonly namespace?: string) {}

  isPatchTask(taskId: string): boolean {
    try { return readIntent(this.runtime, taskId, this.namespace).toolName === WORKSPACE_PATCH_APPLY_TOOL_NAME; }
    catch { return false; }
  }

  reconcile(taskId: string): Promise<WorkspacePatchReconciliationReadback> {
    const prior = this.active.get(taskId);
    if (prior) return prior;
    const execution = Promise.resolve().then(async () => {
      const task = this.runtime.getTask(taskId);
      const intent = readIntent(this.runtime, taskId, this.namespace);
      const runId = `host-tool-${taskId}`;
      const record = readRecord(this.runtime, taskId, runId);
      const priorResult = savedResult(this.runtime, taskId, runId, intent.arguments.path, record);
      if (priorResult) {
        return {taskId, runId, result: priorResult, task: this.runtime.getTask(taskId),
          evidence: this.runtime.readEvidence(taskId)};
      }
      if (task.state !== 'waiting_reconciliation') {
        throw new ProtocolError('REVISION_CONFLICT', 'Workspace patch task is not waiting for reconciliation');
      }
      if (record.state !== 'started' && record.state !== 'unknown') {
        throw new ProtocolError('REVISION_CONFLICT', 'Workspace patch execution is not recoverable');
      }
      if (!this.runtime.matchesToolExecutionInput(record, {arguments: intent.arguments, scopeRef: runId})) {
        throw new ProtocolError('REVISION_CONFLICT', 'Workspace patch intent changed after execution');
      }
      let result: WorkspacePatchReconciliationResult;
      try {
        result = validateResult(await this.port.reconcile({relativePath: intent.arguments.path}));
        if (result.path !== intent.arguments.path) {
          throw new ProtocolError('REVISION_CONFLICT', 'Workspace patch reconciliation source does not match the original intent');
        }
      } catch (error) {
        const concurrent = this.runtime.readToolExecutions(taskId).find(item => item.evidenceId === runId);
        const concurrentResult = concurrent && savedResult(this.runtime, taskId, runId, intent.arguments.path, concurrent);
        if (concurrentResult) {
          return {taskId, runId, result: concurrentResult, task: this.runtime.getTask(taskId),
            evidence: this.runtime.readEvidence(taskId)};
        }
        throw error;
      }
      if (result.state === 'clear') {
        throw new ProtocolError('REVISION_CONFLICT', 'Workspace patch marker is absent; result remains unreconciled');
      }
      if (result.state === 'in_progress') {
        return {taskId, runId, result, task: this.runtime.getTask(taskId), evidence: this.runtime.readEvidence(taskId)};
      }
      const nextTask = this.runtime.reconcileToolExecution(taskId, runId, result.outcome, result);
      return {taskId, runId, result, task: nextTask, evidence: this.runtime.readEvidence(taskId)};
    }).finally(() => this.active.delete(taskId));
    this.active.set(taskId, execution);
    return execution;
  }
}
