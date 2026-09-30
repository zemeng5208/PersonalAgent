import {ProtocolError} from '@personal-agent/contracts';
import type {TaskSnapshot} from '@personal-agent/contracts';
import type {TaskRuntime, ToolExecutionRecord} from '../index.js';

export const WORKSPACE_PATCH_APPLY_TOOL_NAME = 'workspace.apply_text_patch';
export const WORKSPACE_PATCH_APPLY_TOOL_VERSION = '1.0.0';

export type WorkspacePatchReconciliationResult =
  | {path: string; state: 'clear'}
  | {path: string; state: 'in_progress'; runId: string; argumentsDigest: string; pid: number; beforeSha256: string; afterSha256: string}
  | {path: string; state: 'reconciled'; runId: string; argumentsDigest: string;
    outcome: 'applied' | 'not_applied' | 'unknown'; beforeSha256: string; afterSha256: string; currentSha256: string};

/**
 * Trusted Desktop composition owns the roots, ACL checks and process identity
 * query. Runtime receives only the original relative source path from the
 * persisted host intent; it cannot receive a PID or a recovery directory.
 */
export interface WorkspacePatchReconciliationPort {
  readonly bindingId: string;
  reconcile(input: {relativePath: string; expectedRunId: string; expectedArgumentsDigest: string;
    expectedBeforeSha256: string; retainMarker?: boolean}): Promise<WorkspacePatchReconciliationResult>;
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
  arguments: Record<string, unknown> & {path: string; expectedSha256: string};
  deadline: string;
  argumentsDigest: string;
  workspaceBindingId: string;
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
    if (typeof result.runId !== 'string' || !result.runId.trim() || !isHash(result.argumentsDigest)
      || !Number.isSafeInteger(result.pid) || (result.pid as number) < 1
      || !isHash(result.beforeSha256) || !isHash(result.afterSha256)) {
      throw new ProtocolError('RESULT_UNKNOWN', 'Workspace patch process identity is invalid');
    }
    return {path: result.path, state: 'in_progress', runId: result.runId as string,
      argumentsDigest: result.argumentsDigest as string, pid: result.pid as number,
      beforeSha256: result.beforeSha256, afterSha256: result.afterSha256};
  }
  if (result.state === 'reconciled' && ['applied', 'not_applied', 'unknown'].includes(String(result.outcome))
    && typeof result.runId === 'string' && !!result.runId.trim() && isHash(result.argumentsDigest)
    && isHash(result.beforeSha256) && isHash(result.afterSha256) && isHash(result.currentSha256)) {
    return {path: result.path, state: 'reconciled', runId: result.runId,
      argumentsDigest: result.argumentsDigest, outcome: result.outcome as 'applied' | 'not_applied' | 'unknown',
      beforeSha256: result.beforeSha256, afterSha256: result.afterSha256, currentSha256: result.currentSha256};
  }
  throw new ProtocolError('RESULT_UNKNOWN', 'Workspace patch reconciliation returned an invalid state');
}

function readIntent(runtime: TaskRuntime, taskId: string, expectedNamespace: string | undefined,
  expectedBindingId: string): HostToolIntent {
  const value = runtime.loadCheckpoint(taskId, 'host-tool-intent');
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Workspace patch host intent is missing');
  const intent = value as HostToolIntent;
  if ((expectedNamespace !== undefined && intent.namespace !== expectedNamespace)
    || intent.workspaceBindingId !== expectedBindingId || !isHash(intent.workspaceBindingId)
    || !isHash(intent.argumentsDigest) || !isHash(intent.arguments.expectedSha256)
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

function assertBoundResult(result: WorkspacePatchReconciliationResult, intent: HostToolIntent,
  runId: string): void {
  if (result.state !== 'clear' && (result.path !== intent.arguments.path || result.runId !== runId
    || result.argumentsDigest !== intent.argumentsDigest
    || result.beforeSha256 !== intent.arguments.expectedSha256)) {
    throw new ProtocolError('REVISION_CONFLICT', 'Workspace patch marker does not match the original workspace, run, input and source hash');
  }
}

function sameReconciledResult(left: WorkspacePatchReconciliationResult,
  right: WorkspacePatchReconciliationResult): boolean {
  return left.state === 'reconciled' && right.state === 'reconciled'
    && left.path === right.path && left.runId === right.runId
    && left.argumentsDigest === right.argumentsDigest && left.outcome === right.outcome
    && left.beforeSha256 === right.beforeSha256 && left.afterSha256 === right.afterSha256
    && left.currentSha256 === right.currentSha256;
}

function savedResult(runtime: TaskRuntime, taskId: string, runId: string,
  intent: HostToolIntent, record: ToolExecutionRecord): WorkspacePatchReconciliationResult | undefined {
  if (!record.reconciliationOutcome) return undefined;
  const checkpoint = runtime.loadCheckpoint(taskId, 'tool-reconciliation-' + runId) as {result?: unknown} | undefined;
  if (!checkpoint || checkpoint.result === undefined) {
    throw new ProtocolError('RESULT_UNKNOWN', 'Workspace patch reconciliation checkpoint is missing');
  }
  const result = validateResult(checkpoint.result);
  assertBoundResult(result, intent, runId);
  if (result.state !== 'reconciled' || result.outcome !== record.reconciliationOutcome) {
    throw new ProtocolError('REVISION_CONFLICT', 'Workspace patch reconciliation checkpoint is mismatched');
  }
  return result;
}

export class WorkspacePatchReconciliationAdapter {
  private readonly active = new Map<string, Promise<WorkspacePatchReconciliationReadback>>();

  constructor(private readonly runtime: TaskRuntime, private readonly port: WorkspacePatchReconciliationPort,
    private readonly namespace?: string) {}

  get bindingId(): string { return this.port.bindingId; }

  isPatchTask(taskId: string): boolean {
    try { return readIntent(this.runtime, taskId, this.namespace, this.port.bindingId).toolName === WORKSPACE_PATCH_APPLY_TOOL_NAME; }
    catch { return false; }
  }

  reconcile(taskId: string): Promise<WorkspacePatchReconciliationReadback> {
    const prior = this.active.get(taskId);
    if (prior) return prior;
    const execution = Promise.resolve().then(async () => {
      const task = this.runtime.getTask(taskId);
      const intent = readIntent(this.runtime, taskId, this.namespace, this.port.bindingId);
      const runId = `host-tool-${taskId}`;
      const record = readRecord(this.runtime, taskId, runId);
      const priorResult = savedResult(this.runtime, taskId, runId, intent, record);
      if (priorResult) {
        await this.acknowledge(intent, runId, priorResult);
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
      const reconciliationInput = {relativePath: intent.arguments.path, expectedRunId: runId,
        expectedArgumentsDigest: intent.argumentsDigest, expectedBeforeSha256: intent.arguments.expectedSha256};
      let result: WorkspacePatchReconciliationResult;
      try {
        result = validateResult(await this.port.reconcile({...reconciliationInput, retainMarker: true}));
        assertBoundResult(result, intent, runId);
      } catch (error) {
        const concurrent = this.runtime.readToolExecutions(taskId).find(item => item.evidenceId === runId);
        const concurrentResult = concurrent && savedResult(this.runtime, taskId, runId, intent, concurrent);
        if (concurrentResult) {
          await this.acknowledge(intent, runId, concurrentResult);
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
      const persistedRecord = this.runtime.readToolExecutions(taskId).find(item => item.evidenceId === runId);
      const persisted = persistedRecord && savedResult(this.runtime, taskId, runId, intent, persistedRecord);
      if (!persisted || !sameReconciledResult(result, persisted)) {
        throw new ProtocolError('RESULT_UNKNOWN', 'Workspace patch reconciliation persistence could not be read back');
      }
      await this.acknowledge(intent, runId, persisted);
      return {taskId, runId, result: persisted, task: nextTask, evidence: this.runtime.readEvidence(taskId)};
    }).finally(() => this.active.delete(taskId));
    this.active.set(taskId, execution);
    return execution;
  }

  private async acknowledge(intent: HostToolIntent, runId: string,
    expected: WorkspacePatchReconciliationResult): Promise<void> {
    const result = validateResult(await this.port.reconcile({relativePath: intent.arguments.path,
      expectedRunId: runId, expectedArgumentsDigest: intent.argumentsDigest,
      expectedBeforeSha256: intent.arguments.expectedSha256}));
    assertBoundResult(result, intent, runId);
    if (result.state !== 'clear' && !sameReconciledResult(result, expected)) {
      throw new ProtocolError('REVISION_CONFLICT', 'Workspace patch marker changed after Runtime persisted its outcome');
    }
  }
}
