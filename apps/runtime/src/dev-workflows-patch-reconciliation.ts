import {isDeepStrictEqual} from 'node:util';
import {ProtocolError, validateToolValue} from '@personal-agent/contracts';
import type {RegisteredTool, TaskSnapshot, ToolContext} from '@personal-agent/contracts';
import {toolArgumentsDigest} from '@personal-agent/tool-gateway';
import type {WorkspacePatchPreviewResult, WorkspacePatchApplyResult} from '@personal-agent/coding-tools';
import type {TaskRuntime} from './index.js';
import type {WorkspacePatchReconciliationPort, WorkspacePatchReconciliationResult} from './application/workspace-patch-reconciliation.js';

const PATCH = 'workspace.apply_text_patch';
const VERSION = '1.0.0';
const key = (runId: string) => `dev-patch-intent:${runId}`;
const observationKey = (runId: string) => `dev-patch-readback:${runId}`;
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
interface Intent {
  bindingId: string;
  arguments: Record<string, unknown> & {path: string; expectedSha256: string};
  argumentsDigest: string;
  expected: WorkspacePatchApplyResult;
}
export interface DevWorkflowPatchReadback {
  task: TaskSnapshot;
  runId: string;
  result: WorkspacePatchReconciliationResult;
  /** Feed only this bound receipt to resumeConfirmed; it never grants another apply. */
  receipt?: Parameters<TaskRuntime['prepareConfirmedReplay']>[1];
}
type ContinuationRuntime = TaskRuntime & {
  reconcileToolExecutionForContinuation?: (taskId: string, runId: string, outcome: 'applied',
    result: WorkspacePatchApplyResult) => TaskSnapshot;
};
function conflict(message: string): never {throw new ProtocolError('REVISION_CONFLICT', message);}

/** Same Runtime records and trusted host marker; no new task store or write retry. */
export class DevWorkflowPatchRecovery {
  private readonly active = new Map<string, Promise<DevWorkflowPatchReadback>>();
  constructor(private readonly runtime: TaskRuntime, private readonly port: WorkspacePatchReconciliationPort,
    private readonly preview: RegisteredTool) {}

  bind(tool: RegisteredTool): RegisteredTool {
    if (tool.descriptor.name !== PATCH || tool.descriptor.version !== VERSION) return tool;
    return {...tool, execute: async (input, context: ToolContext) => {
      const bindingId = this.port.bindingId;
      // Called inside the authorized Gateway execution, before candidate bytes reach apply.
      const prepared = await this.preview.execute(input, context) as WorkspacePatchPreviewResult;
      const args = structuredClone(input) as Intent['arguments'];
      if (!hash(bindingId) || bindingId !== this.port.bindingId || !hash(prepared.beforeSha256) || !hash(prepared.afterSha256)
        || prepared.path !== args.path || prepared.beforeSha256 !== args.expectedSha256
        || typeof prepared.previewText !== 'string' || typeof prepared.changed !== 'boolean') {
        conflict('Trusted patch preview or workspace binding is invalid');
      }
      const expected: WorkspacePatchApplyResult = {path: prepared.path, beforeSha256: prepared.beforeSha256,
        afterSha256: prepared.afterSha256, byteLength: Buffer.byteLength(prepared.previewText),
        changed: prepared.changed, applied: true};
      validateToolValue(tool.descriptor.outputSchema, expected);
      const intent: Intent = {bindingId, arguments: args,
        argumentsDigest: toolArgumentsDigest(args), expected};
      const previous = this.runtime.loadCheckpoint(context.taskId, key(context.runId));
      if (previous !== undefined && !isDeepStrictEqual(previous, intent)) conflict('Original patch intent changed');
      this.runtime.saveCheckpointOnce(context.taskId, key(context.runId), intent);
      try {return await tool.execute(input, context);}
      catch (error) {
        // Gateway intentionally hides write exceptions. Preserve fixed diagnostic categories locally.
        const message = error instanceof Error ? error.message : '';
        const stage = message.includes('identity') ? 'process_identity'
          : message.includes('in-flight') ? 'marker'
          : message.includes('input failed') ? 'helper_input'
          : message.includes('did not complete') ? 'helper_exit'
          : message.includes('source changed') ? 'source_conflict'
          : message.includes('interrupted') || message.includes('deadline') ? 'interrupted' : 'unclassified';
        this.runtime.saveCheckpoint(context.taskId, `dev-patch-diagnostic:${context.runId}`,
          {stage, code: error instanceof ProtocolError ? error.code : 'EXTERNAL_FAILURE'});
        throw error;
      }
    }};
  }

  reconcile(taskId: string, runId: string): Promise<DevWorkflowPatchReadback> {
    const activeKey = `${taskId}\0${runId}`;
    const prior = this.active.get(activeKey);
    if (prior) return prior;
    const execution = Promise.resolve().then(async () => {
      const intent = this.runtime.loadCheckpoint(taskId, key(runId)) as Intent | undefined;
      const record = this.runtime.readToolExecutions(taskId).find(item => item.evidenceId === runId);
      if (!intent || !record || record.taskId !== taskId || !runId.startsWith(`${taskId}:ci-fix:`)
        || record.toolName !== PATCH || record.toolVersion !== VERSION
        || intent.bindingId !== this.port.bindingId || !hash(intent.bindingId)
        || intent.argumentsDigest !== toolArgumentsDigest(intent.arguments)
        || !this.runtime.matchesToolExecutionInput(record, {arguments: intent.arguments, scopeRef: runId})) {
        conflict('Patch recovery does not match the original workflow, run, input and workspace');
      }
      if (record.policyDecision !== 'allow' || !record.executionStarted) {
        throw new ProtocolError('UNAUTHORIZED', 'Original patch execution was not authorized');
      }
      const receipt = {runId, toolName: PATCH, toolVersion: VERSION, arguments: intent.arguments};
      const input = {relativePath: intent.arguments.path, expectedRunId: runId,
        expectedArgumentsDigest: intent.argumentsDigest, expectedBeforeSha256: intent.arguments.expectedSha256};
      const validate = (result: WorkspacePatchReconciliationResult, allowClear = false) => {
        if (intent.bindingId !== this.port.bindingId) conflict('Patch workspace binding changed during readback');
        if (!result || result.path !== input.relativePath) conflict('Patch readback path changed');
        if (result.state === 'clear') {
          if (!allowClear) conflict('Original patch marker is absent; no applied result can be inferred');
          return;
        }
        if (result.runId !== runId || result.argumentsDigest !== input.expectedArgumentsDigest
          || result.beforeSha256 !== intent.expected.beforeSha256 || result.afterSha256 !== intent.expected.afterSha256
          || (result.state !== 'in_progress' && result.state !== 'reconciled')
          || (result.state === 'in_progress' && (!Number.isSafeInteger(result.pid) || result.pid < 1))
          || (result.state === 'reconciled' && (!hash(result.currentSha256)
            || !['applied', 'not_applied', 'unknown'].includes(result.outcome)
            || (result.outcome === 'applied' && result.currentSha256 !== intent.expected.afterSha256)
            || (result.outcome === 'not_applied' && result.currentSha256 !== intent.expected.beforeSha256)))) {
          conflict('Original patch marker or source hash changed');
        }
      };
      let saved = this.runtime.loadCheckpoint(taskId, observationKey(runId)) as WorkspacePatchReconciliationResult | undefined;
      const cache = this.runtime.loadCheckpoint(taskId, `tool-result-${runId}`) as {result?: unknown} | undefined;
      if (!(saved && record.reconciliationOutcome && record.reconciliationOutcome !== 'unknown')) {
        if (this.runtime.getTask(taskId).state !== 'waiting_reconciliation'
          || !['unknown','started'].includes(record.state)) conflict('Original patch is not waiting for recovery');
        const result = await this.port.reconcile({...input, retainMarker: true});
        validate(result);
        if (result.state !== 'reconciled' || result.outcome === 'unknown') {
          return {task: this.runtime.getTask(taskId), runId, result};
        }
        if (result.outcome === 'applied') {
          const core = this.runtime as ContinuationRuntime;
          if (typeof core.reconcileToolExecutionForContinuation !== 'function') {
            throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'Runtime continuation reconciliation is not available; original marker retained');
          }
          this.runtime.saveCheckpoint(taskId, observationKey(runId), result);
          core.reconcileToolExecutionForContinuation(taskId, runId, 'applied', intent.expected);
          if (this.runtime.getTask(taskId).state !== 'waiting_reconciliation') {
            throw new ProtocolError('RESULT_UNKNOWN', 'Runtime did not preserve the workflow continuation; marker retained');
          }
        } else {
          this.runtime.saveCheckpoint(taskId, observationKey(runId), result);
          this.runtime.reconcileToolExecution(taskId, runId, 'not_applied', result);
        }
        saved = result;
      } else {
        validate(saved);
        if (saved.state !== 'reconciled' || saved.outcome !== record.reconciliationOutcome
          || (saved.outcome === 'applied' && !isDeepStrictEqual(cache?.result, intent.expected))) {
          conflict('Persisted patch outcome does not match the original candidate');
        }
      }
      const persisted = this.runtime.readToolExecutions(taskId).find(item => item.evidenceId === runId);
      const persistedCache = this.runtime.loadCheckpoint(taskId, `tool-result-${runId}`) as {result?: unknown} | undefined;
      if (saved.state !== 'reconciled' || persisted?.reconciliationOutcome !== saved.outcome
        || (saved.outcome === 'applied' && (persisted.state !== 'confirmed'
          || !isDeepStrictEqual(persistedCache?.result, intent.expected)))) {
        throw new ProtocolError('RESULT_UNKNOWN', 'Patch outcome persistence could not be read back; marker retained');
      }
      const acknowledged = await this.port.reconcile(input);
      validate(acknowledged, true);
      if (acknowledged.state !== 'clear' && !isDeepStrictEqual(acknowledged, saved)) conflict('Patch marker changed before acknowledgement');
      return {task: this.runtime.getTask(taskId), runId, result: saved,
        ...(saved.outcome === 'applied' ? {receipt} : {})};
    }).finally(() => this.active.delete(activeKey));
    this.active.set(activeKey, execution);
    return execution;
  }
}
