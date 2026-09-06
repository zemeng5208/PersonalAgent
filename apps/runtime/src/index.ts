import {randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {parseEvent, parseRequest, parseResponse, PROTOCOL_VERSION, ProtocolError, validateContract} from '@personal-agent/contracts';
import type {Event, Operation, Request, Response, TaskSnapshot, ToolDescriptor} from '@personal-agent/contracts';
import {openStorage} from '@personal-agent/storage';
import type {Migration} from '@personal-agent/storage';

type TaskState = TaskSnapshot['state'];
type TaskError = NonNullable<TaskSnapshot['error']>;
type SideEffect = 'read' | 'local_write' | 'external_write';

export interface SubmitTaskInput {
  goal: string;
  conversationId: string;
  attachmentRefs?: readonly string[];
  idempotencyKey: string;
}

export interface ProgressInput {
  stepId: string;
  label: string;
  completedUnits?: number;
  totalUnits?: number;
}

export interface TransitionPatch {
  resultSummary?: string;
  evidenceRefs?: readonly string[];
  error?: TaskError;
  cancelRequested?: boolean;
}

export interface RunOptions {
  deadline: string;
  sideEffect: SideEffect;
}

export interface WorkerContext {
  taskId: string;
  deadline: string;
  signal: AbortSignal;
  saveCheckpoint(key: string, value: unknown): void;
  loadCheckpoint(key: string): unknown;
  reportProgress(progress: ProgressInput): TaskSnapshot;
}

export interface WorkerResult {
  resultSummary: string;
  evidenceRefs?: readonly string[];
}

export interface ScheduleInput {
  scheduleId: string;
  goal: string;
  conversationId: string;
  runAt: string;
  timeZone: string;
  missedRunPolicy: 'run_once' | 'skip';
  taskIdempotencyKey: string;
}

export interface ScheduleSnapshot extends ScheduleInput {
  status: 'pending' | 'fired' | 'skipped';
  taskId?: string;
}

export interface ScheduleDispatch {
  scheduleId: string;
  status: 'fired' | 'skipped';
  task?: TaskSnapshot;
}

export interface RuntimeToolInvocation {
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

export interface RuntimeToolGateway {
  list(): ToolDescriptor[];
  invoke(invocation: RuntimeToolInvocation): Promise<unknown>;
}

export interface RuntimeOptions {
  now?: () => Date;
  idFactory?: () => string;
  toolGateway?: RuntimeToolGateway;
}

export interface TaskPort {
  submitTask(input: SubmitTaskInput): TaskSnapshot;
  getTask(taskId: string): TaskSnapshot;
  transitionTask(taskId: string, state: TaskState, patch?: TransitionPatch): TaskSnapshot;
  requestCancel(taskId: string, reason?: string): {taskId: string; state: TaskState; cancelAccepted: boolean};
  saveCheckpoint(taskId: string, key: string, value: unknown): void;
  loadCheckpoint(taskId: string, key: string): unknown;
}

export interface EventPort {
  readEvents(afterSequence?: number): Event[];
}

export interface SchedulerPort {
  createSchedule(input: ScheduleInput): ScheduleSnapshot;
  getSchedule(scheduleId: string): ScheduleSnapshot;
  dispatchDueSchedules(): ScheduleDispatch[];
  recoverMissedSchedules(): ScheduleDispatch[];
}

interface TaskRow {
  task_id: string;
  state: TaskState;
  revision: number;
  updated_at: string;
  steps_json: string;
  evidence_refs_json: string;
  result_summary: string | null;
  error_json: string | null;
  cancel_requested: number;
}

interface EventRow {
  sequence: number;
  event_id: string;
  stream_id: string;
  task_id: string | null;
  type: Event['type'];
  occurred_at: string;
  payload_json: string;
}

interface ScheduleRow {
  schedule_id: string;
  goal: string;
  conversation_id: string;
  run_at: string;
  time_zone: string;
  missed_run_policy: 'run_once' | 'skip';
  task_idempotency_key: string;
  status: 'pending' | 'fired' | 'skipped';
  task_id: string | null;
}

const terminal = new Set<TaskState>(['succeeded', 'failed', 'cancelled']);
const baseCapabilities: Operation[] = ['system.handshake', 'task.submit', 'task.get', 'task.cancel', 'event.subscribe'];
const interrupted = ['planning', 'running', 'waiting_external', 'verifying', 'cancelling'] as const;
const allowed: Record<TaskState, readonly TaskState[]> = {
  created: ['planning', 'cancelling', 'failed'],
  planning: ['running', 'waiting_approval', 'waiting_external', 'waiting_reconciliation', 'cancelling', 'failed'],
  running: ['waiting_approval', 'waiting_external', 'waiting_reconciliation', 'verifying', 'cancelling', 'failed'],
  waiting_approval: ['running', 'cancelling', 'cancelled', 'failed'],
  waiting_external: ['running', 'waiting_reconciliation', 'cancelling', 'failed'],
  waiting_reconciliation: ['running', 'verifying', 'cancelling', 'cancelled', 'failed'],
  verifying: ['succeeded', 'waiting_reconciliation', 'cancelling', 'failed'],
  cancelling: ['cancelled', 'waiting_reconciliation', 'failed'],
  succeeded: [],
  failed: [],
  cancelled: []
};

export const RUNTIME_MIGRATIONS: readonly Migration[] = [{
  version: 1,
  sql: [
    "CREATE TABLE tasks (task_id TEXT PRIMARY KEY, goal TEXT NOT NULL, conversation_id TEXT NOT NULL, attachment_refs_json TEXT NOT NULL, state TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL, steps_json TEXT NOT NULL, evidence_refs_json TEXT NOT NULL, result_summary TEXT, error_json TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1))) STRICT;",
    "CREATE TABLE task_idempotency (idempotency_key TEXT PRIMARY KEY, input_json TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(task_id)) STRICT;",
    "CREATE TABLE task_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, stream_id TEXT NOT NULL, task_id TEXT REFERENCES tasks(task_id), type TEXT NOT NULL, occurred_at TEXT NOT NULL, payload_json TEXT NOT NULL) STRICT;",
    "CREATE INDEX task_events_stream_sequence ON task_events(stream_id, sequence);",
    "CREATE TABLE task_checkpoints (task_id TEXT NOT NULL REFERENCES tasks(task_id), checkpoint_key TEXT NOT NULL, value_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (task_id, checkpoint_key)) STRICT;",
    "CREATE TABLE task_schedules (schedule_id TEXT PRIMARY KEY, goal TEXT NOT NULL, conversation_id TEXT NOT NULL, run_at TEXT NOT NULL, time_zone TEXT NOT NULL, missed_run_policy TEXT NOT NULL CHECK (missed_run_policy IN ('run_once', 'skip')), task_idempotency_key TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending', 'fired', 'skipped')), task_id TEXT REFERENCES tasks(task_id)) STRICT;",
    "CREATE INDEX task_schedules_due ON task_schedules(status, run_at);"
  ].join('\n')
}];

export class RuntimeError extends Error {
  constructor(public readonly code: TaskError['code'], message: string) {
    super(message);
    this.name = 'RuntimeError';
  }
}

class DeadlineExceeded extends Error {}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const record = value as Record<string, unknown>;
  return '{' + Object.keys(record).sort().map(key => JSON.stringify(key) + ':' + canonical(record[key])).join(',') + '}';
}

function requireText(value: string, name: string): string {
  if (!value.trim()) throw new RuntimeError('INVALID_ARGUMENT', name + ' must not be empty');
  return value;
}

function parseTime(value: string, name: string): number {
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new RuntimeError('INVALID_ARGUMENT', name + ' must be an ISO 8601 time');
  return result;
}

function taskFromRow(row: TaskRow): TaskSnapshot {
  const snapshot: TaskSnapshot = {
    taskId: row.task_id,
    state: row.state,
    revision: row.revision,
    updatedAt: row.updated_at,
    steps: JSON.parse(row.steps_json) as TaskSnapshot['steps'],
    evidenceRefs: JSON.parse(row.evidence_refs_json) as string[]
  };
  if (row.result_summary !== null) snapshot.resultSummary = row.result_summary;
  if (row.error_json !== null) snapshot.error = JSON.parse(row.error_json) as TaskError;
  if (row.cancel_requested === 1) snapshot.cancelRequested = true;
  validateContract('snapshot', snapshot);
  return snapshot;
}

function scheduleFromRow(row: ScheduleRow): ScheduleSnapshot {
  const schedule: ScheduleSnapshot = {
    scheduleId: row.schedule_id,
    goal: row.goal,
    conversationId: row.conversation_id,
    runAt: row.run_at,
    timeZone: row.time_zone,
    missedRunPolicy: row.missed_run_policy,
    taskIdempotencyKey: row.task_idempotency_key,
    status: row.status
  };
  if (row.task_id !== null) schedule.taskId = row.task_id;
  return schedule;
}

export class TaskRuntime implements TaskPort, EventPort, SchedulerPort {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly toolGateway: RuntimeToolGateway | undefined;
  private readonly sessionRef = 'runtime-' + randomUUID();
  private readonly active = new Map<string, AbortController>();

  constructor(path: string, options: RuntimeOptions = {}) {
    this.db = openStorage(path, RUNTIME_MIGRATIONS);
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.toolGateway = options.toolGateway;
  }

  close(): void {
    if (this.active.size) throw new RuntimeError('REVISION_CONFLICT', 'Cannot close runtime while workers are active');
    this.db.close();
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private taskRow(taskId: string): TaskRow {
    const row = this.db.prepare('SELECT task_id, state, revision, updated_at, steps_json, evidence_refs_json, result_summary, error_json, cancel_requested FROM tasks WHERE task_id = ?').get(taskId) as unknown as TaskRow | undefined;
    if (!row) throw new RuntimeError('NOT_FOUND', 'Task not found');
    return row;
  }

  getTask(taskId: string): TaskSnapshot {
    return structuredClone(taskFromRow(this.taskRow(requireText(taskId, 'taskId'))));
  }

  async send(input: Request, signal: AbortSignal): Promise<Response> {
    const request = parseRequest(structuredClone(input));
    try {
      if (signal.aborted) throw new RuntimeError('CANCELLED', 'Call was aborted');
      if (Date.parse(request.deadline) <= this.now().getTime()) throw new RuntimeError('TIMEOUT', 'Request deadline expired');
      let data: unknown;
      switch (request.operation) {
        case 'system.handshake':
          if (request.payload.supportedMajor !== 1) throw new RuntimeError('PROTOCOL_MISMATCH', 'Unsupported protocol major');
          data = {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: this.toolGateway ? [...baseCapabilities, 'capability.list', 'tool.invoke'] : baseCapabilities,
            sessionRef: this.sessionRef
          };
          break;
        case 'task.submit': {
          const task = this.submitTask({
            goal: request.payload.goal,
            conversationId: request.payload.conversationId,
            attachmentRefs: request.payload.attachmentRefs ?? [],
            idempotencyKey: request.idempotencyKey
          });
          data = {taskId: task.taskId, state: task.state, revision: task.revision};
          break;
        }
        case 'task.get':
          data = this.getTask(request.payload.taskId);
          break;
        case 'task.cancel':
          data = this.requestCancel(request.payload.taskId, request.payload.reason);
          break;
        case 'event.subscribe': {
          if (request.payload.streamId !== 'tasks') throw new RuntimeError('NOT_FOUND', 'Event stream not found');
          const afterSequence = request.payload.afterSequence ?? 0;
          this.readEvents(afterSequence);
          data = {subscriptionId: 'subscription-' + randomUUID(), replayFrom: afterSequence + 1};
          break;
        }
        case 'capability.list': {
          if (!this.toolGateway) throw new RuntimeError('UNSUPPORTED_CAPABILITY', 'Tool gateway is not configured');
          const manifests = request.payload.kind === undefined || request.payload.kind === 'tool'
            ? this.toolGateway.list()
            : [];
          data = {
            manifests,
            health: manifests.map(manifest => ({id: manifest.name, state: 'ready' as const}))
          };
          break;
        }
        case 'tool.invoke': {
          if (!this.toolGateway) throw new RuntimeError('UNSUPPORTED_CAPABILITY', 'Tool gateway is not configured');
          if (!request.taskId) throw new RuntimeError('INVALID_ARGUMENT', 'tool.invoke requires a taskId');
          const task = this.getTask(request.taskId);
          if (task.state !== 'running') {
            throw new RuntimeError('REVISION_CONFLICT', 'Tools can only be invoked for a running task');
          }
          const runId = this.idFactory();
          try {
            const result = await this.toolGateway.invoke({
              toolName: request.payload.toolName,
              toolVersion: request.payload.toolVersion,
              arguments: request.payload.arguments,
              taskId: request.taskId,
              runId,
              authorizationRef: request.payload.scopeRef,
              deadline: request.deadline,
              signal,
            });
            data = {runId, state: 'confirmed', result, evidenceRefs: []};
            this.emit('tool.completed', {runId, state: 'confirmed', evidenceRefs: []}, request.taskId);
          } catch (error) {
            if (error instanceof ProtocolError && error.code === 'RESULT_UNKNOWN') {
              this.transitionTask(request.taskId, 'waiting_reconciliation', {
                error: {code: 'RESULT_UNKNOWN', message: error.message, retryable: false}
              });
              data = {runId, state: 'unknown', evidenceRefs: []};
              this.emit('tool.completed', {runId, state: 'unknown', evidenceRefs: []}, request.taskId);
              break;
            }
            throw error;
          }
          break;
        }
        default:
          throw new RuntimeError('UNSUPPORTED_CAPABILITY', 'Operation is not configured in this Runtime');
      }
      const response = {
        kind: 'response',
        protocolVersion: PROTOCOL_VERSION,
        requestId: request.requestId,
        outcome: 'ok',
        data,
        evidenceRefs: []
      } as Response;
      return structuredClone(parseResponse(response, request.operation, request.requestId));
    } catch (error) {
      const response = {
        kind: 'response',
        protocolVersion: PROTOCOL_VERSION,
        requestId: request.requestId,
        outcome: 'error',
        error: {
          code: error instanceof RuntimeError || error instanceof ProtocolError ? error.code : 'EXTERNAL_FAILURE',
          message: error instanceof Error ? error.message : 'Runtime request failed',
          retryable: error instanceof ProtocolError ? error.retryable : false,
          ...(error instanceof ProtocolError && error.retryAfterMs !== undefined ? {retryAfterMs: error.retryAfterMs} : {})
        },
        evidenceRefs: []
      } as Response;
      return structuredClone(parseResponse(response, request.operation, request.requestId));
    }
  }

  private emit(type: Event['type'], payload: unknown, taskId?: string): Event {
    const eventId = this.idFactory();
    const occurredAt = this.timestamp();
    const result = this.db.prepare('INSERT INTO task_events (event_id, stream_id, task_id, type, occurred_at, payload_json) VALUES (?, ?, ?, ?, ?, ?)').run(
      eventId,
      'tasks',
      taskId ?? null,
      type,
      occurredAt,
      JSON.stringify(payload)
    );
    const event = parseEvent({
      kind: 'event',
      protocolVersion: '1.0.0',
      eventId,
      streamId: 'tasks',
      sequence: Number(result.lastInsertRowid),
      ...(taskId ? {taskId} : {}),
      type,
      occurredAt,
      payload
    });
    return event;
  }

  private submitInTransaction(input: SubmitTaskInput): TaskSnapshot {
    const normalized = {
      goal: requireText(input.goal, 'goal'),
      conversationId: requireText(input.conversationId, 'conversationId'),
      attachmentRefs: [...(input.attachmentRefs ?? [])]
    };
    const idempotencyKey = requireText(input.idempotencyKey, 'idempotencyKey');
    const inputJson = canonical(normalized);
    const previous = this.db.prepare('SELECT input_json, task_id FROM task_idempotency WHERE idempotency_key = ?').get(idempotencyKey) as unknown as {input_json: string; task_id: string} | undefined;
    if (previous) {
      if (previous.input_json !== inputJson) throw new RuntimeError('REVISION_CONFLICT', 'Idempotency key was reused with different input');
      return taskFromRow(this.taskRow(previous.task_id));
    }
    const taskId = this.idFactory();
    const updatedAt = this.timestamp();
    this.db.prepare('INSERT INTO tasks (task_id, goal, conversation_id, attachment_refs_json, state, revision, updated_at, steps_json, evidence_refs_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      taskId,
      normalized.goal,
      normalized.conversationId,
      JSON.stringify(normalized.attachmentRefs),
      'created',
      1,
      updatedAt,
      '[]',
      '[]'
    );
    this.db.prepare('INSERT INTO task_idempotency (idempotency_key, input_json, task_id) VALUES (?, ?, ?)').run(idempotencyKey, inputJson, taskId);
    const task = taskFromRow(this.taskRow(taskId));
    this.emit('task.created', task, taskId);
    return task;
  }

  submitTask(input: SubmitTaskInput): TaskSnapshot {
    return structuredClone(this.transaction(() => this.submitInTransaction(input)));
  }

  private writeSnapshot(snapshot: TaskSnapshot): void {
    this.db.prepare('UPDATE tasks SET state = ?, revision = ?, updated_at = ?, steps_json = ?, evidence_refs_json = ?, result_summary = ?, error_json = ?, cancel_requested = ? WHERE task_id = ?').run(
      snapshot.state,
      snapshot.revision,
      snapshot.updatedAt,
      JSON.stringify(snapshot.steps),
      JSON.stringify(snapshot.evidenceRefs),
      snapshot.resultSummary ?? null,
      snapshot.error ? JSON.stringify(snapshot.error) : null,
      snapshot.cancelRequested ? 1 : 0,
      snapshot.taskId
    );
  }

  private updateTask(taskId: string, state: TaskState, patch: TransitionPatch, requireTransition: boolean): TaskSnapshot {
    const current = taskFromRow(this.taskRow(taskId));
    if (requireTransition && !allowed[current.state].includes(state)) {
      throw new RuntimeError('REVISION_CONFLICT', 'Illegal task transition from ' + current.state + ' to ' + state);
    }
    const next = structuredClone(current);
    next.state = state;
    next.revision++;
    next.updatedAt = this.timestamp();
    if (patch.resultSummary !== undefined) next.resultSummary = patch.resultSummary;
    if (patch.evidenceRefs !== undefined) next.evidenceRefs = [...patch.evidenceRefs];
    if (patch.error !== undefined) next.error = structuredClone(patch.error);
    if (patch.cancelRequested !== undefined) next.cancelRequested = patch.cancelRequested;
    validateContract('snapshot', next);
    this.writeSnapshot(next);
    this.emit('task.state_changed', next, taskId);
    const terminalType = state === 'succeeded' ? 'task.completed' : state === 'failed' ? 'task.failed' : state === 'cancelled' ? 'task.cancelled' : undefined;
    if (terminalType) this.emit(terminalType, next, taskId);
    return next;
  }

  transitionTask(taskId: string, state: TaskState, patch: TransitionPatch = {}): TaskSnapshot {
    return structuredClone(this.transaction(() => this.updateTask(requireText(taskId, 'taskId'), state, patch, true)));
  }

  recordProgress(taskId: string, progress: ProgressInput): TaskSnapshot {
    requireText(progress.stepId, 'stepId');
    requireText(progress.label, 'label');
    if (progress.completedUnits !== undefined && (!Number.isFinite(progress.completedUnits) || progress.completedUnits < 0)) {
      throw new RuntimeError('INVALID_ARGUMENT', 'completedUnits must be non-negative');
    }
    if (progress.totalUnits !== undefined && (!Number.isFinite(progress.totalUnits) || progress.totalUnits < 0)) {
      throw new RuntimeError('INVALID_ARGUMENT', 'totalUnits must be non-negative');
    }
    return structuredClone(this.transaction(() => {
      const task = taskFromRow(this.taskRow(taskId));
      if (terminal.has(task.state)) throw new RuntimeError('REVISION_CONFLICT', 'Terminal task cannot report progress');
      const step = task.steps.find(item => item.stepId === progress.stepId);
      const state = progress.totalUnits !== undefined && progress.completedUnits === progress.totalUnits ? 'completed' : 'running';
      if (step) {
        step.label = progress.label;
        step.state = state;
      } else {
        task.steps.push({stepId: progress.stepId, label: progress.label, state});
      }
      task.revision++;
      task.updatedAt = this.timestamp();
      this.writeSnapshot(task);
      const payload: ProgressInput = {stepId: progress.stepId, label: progress.label};
      if (progress.completedUnits !== undefined) payload.completedUnits = progress.completedUnits;
      if (progress.totalUnits !== undefined) payload.totalUnits = progress.totalUnits;
      this.emit('task.progress', payload, taskId);
      return task;
    }));
  }

  saveCheckpoint(taskId: string, key: string, value: unknown): void {
    requireText(key, 'checkpoint key');
    this.getTask(taskId);
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new RuntimeError('INVALID_ARGUMENT', 'Checkpoint must be JSON serializable');
    this.db.prepare('INSERT INTO task_checkpoints (task_id, checkpoint_key, value_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(task_id, checkpoint_key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at').run(
      taskId,
      key,
      encoded,
      this.timestamp()
    );
  }

  loadCheckpoint(taskId: string, key: string): unknown {
    const row = this.db.prepare('SELECT value_json FROM task_checkpoints WHERE task_id = ? AND checkpoint_key = ?').get(taskId, requireText(key, 'checkpoint key')) as unknown as {value_json: string} | undefined;
    return row ? structuredClone(JSON.parse(row.value_json)) : undefined;
  }

  requestCancel(taskId: string, _reason?: string): {taskId: string; state: TaskState; cancelAccepted: boolean} {
    const result = this.transaction(() => {
      const task = taskFromRow(this.taskRow(taskId));
      if (terminal.has(task.state)) return {taskId, state: task.state, cancelAccepted: false};
      if (task.cancelRequested) return {taskId, state: task.state, cancelAccepted: true};
      const next = task.state === 'waiting_reconciliation'
        ? this.updateTask(taskId, task.state, {cancelRequested: true}, false)
        : this.updateTask(taskId, 'cancelling', {cancelRequested: true}, true);
      return {taskId, state: next.state, cancelAccepted: true};
    });
    this.active.get(taskId)?.abort();
    return result;
  }

  confirmCancellation(taskId: string): TaskSnapshot {
    return this.transitionTask(taskId, 'cancelled', {cancelRequested: true});
  }

  async runTask(taskId: string, worker: (context: WorkerContext) => Promise<WorkerResult>, options: RunOptions): Promise<TaskSnapshot> {
    const deadlineMs = parseTime(options.deadline, 'deadline');
    const initial = this.getTask(taskId);
    if (initial.state !== 'created' || this.active.has(taskId)) {
      throw new RuntimeError('REVISION_CONFLICT', 'Task is not ready to start');
    }
    const controller = new AbortController();
    this.active.set(taskId, controller);
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    try {
      this.transitionTask(taskId, 'planning');
      this.transitionTask(taskId, 'running');
      const remaining = deadlineMs - this.now().getTime();
      if (remaining <= 0) {
        timedOut = true;
        controller.abort();
        throw new DeadlineExceeded();
      }
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new DeadlineExceeded());
        }, remaining);
      });
      const result = await Promise.race([
        worker({
          taskId,
          deadline: options.deadline,
          signal: controller.signal,
          saveCheckpoint: (key, value) => this.saveCheckpoint(taskId, key, value),
          loadCheckpoint: key => this.loadCheckpoint(taskId, key),
          reportProgress: progress => this.recordProgress(taskId, progress)
        }),
        timeout
      ]);
      const current = this.getTask(taskId);
      if (current.state === 'cancelling') return this.confirmCancellation(taskId);
      if (current.state === 'waiting_reconciliation') return current;
      this.transitionTask(taskId, 'verifying');
      return this.transitionTask(taskId, 'succeeded', {
        resultSummary: result.resultSummary,
        evidenceRefs: result.evidenceRefs ?? []
      });
    } catch (error) {
      const current = this.getTask(taskId);
      if (timedOut) {
        if (options.sideEffect === 'external_write') {
          return this.transitionTask(taskId, 'waiting_reconciliation', {
            error: {code: 'RESULT_UNKNOWN', message: 'External write exceeded its deadline; verify before retrying', retryable: false}
          });
        }
        return this.transitionTask(taskId, 'failed', {
          error: {code: 'TIMEOUT', message: 'Task exceeded its deadline', retryable: false}
        });
      }
      if (controller.signal.aborted && current.state === 'cancelling') return this.confirmCancellation(taskId);
      if (current.state === 'waiting_reconciliation') return current;
      return this.transitionTask(taskId, 'failed', {
        error: {
          code: error instanceof RuntimeError ? error.code : 'EXTERNAL_FAILURE',
          message: error instanceof Error ? error.message : 'Task worker failed',
          retryable: false
        }
      });
    } finally {
      if (timer) clearTimeout(timer);
      this.active.delete(taskId);
    }
  }

  recoverInterruptedTasks(): TaskSnapshot[] {
    const placeholders = interrupted.map(() => '?').join(', ');
    const rows = this.db.prepare('SELECT task_id FROM tasks WHERE state IN (' + placeholders + ') ORDER BY task_id').all(...interrupted) as unknown as {task_id: string}[];
    return rows.map(row => this.transitionTask(row.task_id, 'waiting_reconciliation', {
      error: {code: 'RESULT_UNKNOWN', message: 'Runtime stopped before the task result was confirmed', retryable: false}
    }));
  }

  reconcileTask(taskId: string, outcome: 'confirmed' | 'not_performed'): TaskSnapshot {
    const task = this.getTask(taskId);
    if (task.state !== 'waiting_reconciliation') throw new RuntimeError('REVISION_CONFLICT', 'Task is not waiting for reconciliation');
    if (outcome === 'confirmed') {
      this.transitionTask(taskId, 'verifying');
      return this.transitionTask(taskId, 'succeeded', {resultSummary: 'Reconciliation confirmed the earlier result'});
    }
    if (task.cancelRequested) return this.transitionTask(taskId, 'cancelled', {cancelRequested: true});
    return this.transitionTask(taskId, 'failed', {
      error: {code: 'EXTERNAL_FAILURE', message: 'Reconciliation found no completed result', retryable: false}
    });
  }

  readEvents(afterSequence = 0): Event[] {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new RuntimeError('INVALID_ARGUMENT', 'Invalid event cursor');
    const last = this.db.prepare('SELECT max(sequence) AS value FROM task_events').get() as unknown as {value: number | null};
    if (afterSequence > (last.value ?? 0)) throw new RuntimeError('INVALID_ARGUMENT', 'Event cursor is ahead of the stream');
    const rows = this.db.prepare('SELECT sequence, event_id, stream_id, task_id, type, occurred_at, payload_json FROM task_events WHERE stream_id = ? AND sequence > ? ORDER BY sequence').all('tasks', afterSequence) as unknown as EventRow[];
    return rows.map(row => parseEvent({
      kind: 'event',
      protocolVersion: '1.0.0',
      eventId: row.event_id,
      streamId: row.stream_id,
      sequence: row.sequence,
      ...(row.task_id ? {taskId: row.task_id} : {}),
      type: row.type,
      occurredAt: row.occurred_at,
      payload: JSON.parse(row.payload_json)
    }));
  }

  createSchedule(input: ScheduleInput): ScheduleSnapshot {
    requireText(input.scheduleId, 'scheduleId');
    requireText(input.goal, 'goal');
    requireText(input.conversationId, 'conversationId');
    requireText(input.taskIdempotencyKey, 'taskIdempotencyKey');
    parseTime(input.runAt, 'runAt');
    try {
      new Intl.DateTimeFormat('en', {timeZone: input.timeZone}).format(this.now());
    } catch {
      throw new RuntimeError('INVALID_ARGUMENT', 'timeZone must be a supported IANA zone');
    }
    const previous = this.db.prepare('SELECT schedule_id, goal, conversation_id, run_at, time_zone, missed_run_policy, task_idempotency_key, status, task_id FROM task_schedules WHERE schedule_id = ?').get(input.scheduleId) as unknown as ScheduleRow | undefined;
    if (previous) {
      const current = scheduleFromRow(previous);
      const comparable: ScheduleInput = {
        scheduleId: current.scheduleId,
        goal: current.goal,
        conversationId: current.conversationId,
        runAt: current.runAt,
        timeZone: current.timeZone,
        missedRunPolicy: current.missedRunPolicy,
        taskIdempotencyKey: current.taskIdempotencyKey
      };
      if (canonical(comparable) !== canonical(input)) throw new RuntimeError('REVISION_CONFLICT', 'Schedule ID was reused with different input');
      return structuredClone(current);
    }
    this.db.prepare('INSERT INTO task_schedules (schedule_id, goal, conversation_id, run_at, time_zone, missed_run_policy, task_idempotency_key, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      input.scheduleId,
      input.goal,
      input.conversationId,
      input.runAt,
      input.timeZone,
      input.missedRunPolicy,
      input.taskIdempotencyKey,
      'pending'
    );
    return this.getSchedule(input.scheduleId);
  }

  getSchedule(scheduleId: string): ScheduleSnapshot {
    const row = this.db.prepare('SELECT schedule_id, goal, conversation_id, run_at, time_zone, missed_run_policy, task_idempotency_key, status, task_id FROM task_schedules WHERE schedule_id = ?').get(requireText(scheduleId, 'scheduleId')) as unknown as ScheduleRow | undefined;
    if (!row) throw new RuntimeError('NOT_FOUND', 'Schedule not found');
    return structuredClone(scheduleFromRow(row));
  }

  private processDue(recovery: boolean): ScheduleDispatch[] {
    const now = this.timestamp();
    const rows = this.db.prepare('SELECT schedule_id FROM task_schedules WHERE status = ? AND run_at <= ? ORDER BY run_at, schedule_id').all('pending', now) as unknown as {schedule_id: string}[];
    return rows.map(({schedule_id}) => this.transaction(() => {
      const schedule = this.getSchedule(schedule_id);
      if (recovery && schedule.missedRunPolicy === 'skip') {
        this.db.prepare('UPDATE task_schedules SET status = ? WHERE schedule_id = ?').run('skipped', schedule.scheduleId);
        return {scheduleId: schedule.scheduleId, status: 'skipped'} as const;
      }
      const task = this.submitInTransaction({
        goal: schedule.goal,
        conversationId: schedule.conversationId,
        idempotencyKey: schedule.taskIdempotencyKey
      });
      this.db.prepare('UPDATE task_schedules SET status = ?, task_id = ? WHERE schedule_id = ?').run('fired', task.taskId, schedule.scheduleId);
      return {scheduleId: schedule.scheduleId, status: 'fired', task} as const;
    }));
  }

  dispatchDueSchedules(): ScheduleDispatch[] {
    return structuredClone(this.processDue(false));
  }

  recoverMissedSchedules(): ScheduleDispatch[] {
    return structuredClone(this.processDue(true));
  }
}
