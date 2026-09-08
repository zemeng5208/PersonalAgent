import {createHash, randomUUID} from 'node:crypto';
import type {DatabaseSync, SQLInputValue} from 'node:sqlite';
import {parseEvent, parseRequest, parseResponse, PROTOCOL_VERSION, ProtocolError, validateContract} from '@personal-agent/contracts';
import type {Event, Operation, Request, Response, Result, TaskSnapshot, ToolDescriptor} from '@personal-agent/contracts';
import {openStorage} from '@personal-agent/storage';
import type {Migration} from '@personal-agent/storage';
import {AuthorizationPolicy} from '@personal-agent/policy';
import {SqliteAuthorizationStore} from './authorization-store.js';

type TaskState = TaskSnapshot['state'];
type TaskError = NonNullable<TaskSnapshot['error']>;
type SideEffect = 'read' | 'local_write' | 'external_write';

export interface ToolExecutionRecord {
  protocolVersion: string;
  policyDecision: 'not_evaluated' | 'allow' | 'deny';
  executionStarted: boolean;
  inputDigest: string;
  evidenceId: string;
  requestId: string;
  taskId: string;
  toolName: string;
  toolVersion: string;
  startedAt: string;
  finishedAt?: string;
  state: 'started' | 'confirmed' | 'failed' | 'unknown';
  errorCode?: string;
}

export interface SubmitTaskInput {
  goal: string;
  conversationId: string;
  attachmentRefs?: readonly string[];
  idempotencyKey: string;
}

export interface ConversationTurn {
  taskId: string;
  goal: string;
  resultSummary: string;
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
  resume?: boolean;
}

export interface ToolApproval {
  argumentsDigest: string;
  approvalId: string;
  taskId: string;
  toolName: string;
  scopes: string[];
  expiresAt: string;
  revision: number;
  state: 'pending' | 'allowed' | 'denied';
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
  onAuthorized?: () => void;
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
  createToolGateway?: (policy: AuthorizationPolicy) => RuntimeToolGateway;
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
  goal: string;
  conversation_id: string;
  attachment_refs_json: string;
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
const baseCapabilities: Operation[] = ['system.handshake', 'task.submit', 'task.get', 'task.list', 'conversation.list', 'approval.list', 'task.cancel', 'event.subscribe'];
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
}, {
  version: 2,
  sql: 'CREATE TABLE authorization_grants (authorization_ref TEXT PRIMARY KEY, value_json TEXT NOT NULL) STRICT;'
}, {
  version: 3,
  sql: 'CREATE TABLE tool_execution_records (evidence_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(task_id), record_json TEXT NOT NULL) STRICT; CREATE INDEX tool_execution_task ON tool_execution_records(task_id);'
}, {
  version: 4,
  sql: 'CREATE TABLE tool_approvals (approval_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(task_id), value_json TEXT NOT NULL) STRICT;'
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
    evidenceRefs: JSON.parse(row.evidence_refs_json) as string[],
    goal: row.goal,
    conversationId: row.conversation_id,
    attachmentRefs: JSON.parse(row.attachment_refs_json) as string[]
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
  readonly policy: AuthorizationPolicy;
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
    this.policy = new AuthorizationPolicy(new SqliteAuthorizationStore(this.db));
    this.toolGateway = options.createToolGateway?.(this.policy) ?? options.toolGateway;
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
    const row = this.db.prepare('SELECT task_id, goal, conversation_id, attachment_refs_json, state, revision, updated_at, steps_json, evidence_refs_json, result_summary, error_json, cancel_requested FROM tasks WHERE task_id = ?').get(taskId) as unknown as TaskRow | undefined;
    if (!row) throw new RuntimeError('NOT_FOUND', 'Task not found');
    return row;
  }

  getTask(taskId: string): TaskSnapshot {
    return structuredClone(taskFromRow(this.taskRow(requireText(taskId, 'taskId'))));
  }

  private snapshotSequence(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM task_events').get() as {sequence: number};
    return row.sequence;
  }

  listTasks(input: {conversationId?: string; states?: TaskState[]; beforeSequence?: number; snapshotSequence?: number; limit?: number}): Result<'task.list'> {
    const limit = input.limit ?? 50;
    const latestSequence = this.snapshotSequence();
    const snapshotSequence = input.snapshotSequence ?? latestSequence;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RuntimeError('INVALID_ARGUMENT', 'limit must be between 1 and 100');
    if (!Number.isSafeInteger(snapshotSequence) || snapshotSequence < 0 || snapshotSequence > latestSequence) throw new RuntimeError('INVALID_ARGUMENT', 'Invalid snapshot sequence');
    const clauses = ["e.type = 'task.created'", 'e.sequence <= ?'];
    const params: SQLInputValue[] = [snapshotSequence];
    if (input.beforeSequence !== undefined) { clauses.push('e.sequence < ?'); params.push(input.beforeSequence); }
    if (input.conversationId !== undefined) { clauses.push('t.conversation_id = ?'); params.push(requireText(input.conversationId, 'conversationId')); }
    if (input.states?.length) { clauses.push(`t.state IN (${input.states.map(() => '?').join(', ')})`); params.push(...input.states); }
    const rows = this.db.prepare(`SELECT t.task_id, t.goal, t.conversation_id, t.attachment_refs_json, t.state, t.revision, t.updated_at, t.steps_json, t.evidence_refs_json, t.result_summary, t.error_json, t.cancel_requested, e.sequence AS created_sequence FROM tasks t JOIN task_events e ON e.task_id = t.task_id WHERE ${clauses.join(' AND ')} ORDER BY e.sequence DESC LIMIT ?`).all(...params, limit + 1) as unknown as Array<TaskRow & {created_sequence: number}>;
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    return {items: page.map(taskFromRow), snapshotSequence, ...(more ? {nextBeforeSequence: page.at(-1)!.created_sequence} : {})};
  }

  listConversations(input: {conversationId?: string; beforeSequence?: number; snapshotSequence?: number; limit?: number}): Result<'conversation.list'> {
    const limit = input.limit ?? 20;
    const latestSequence = this.snapshotSequence();
    const snapshotSequence = input.snapshotSequence ?? latestSequence;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RuntimeError('INVALID_ARGUMENT', 'limit must be between 1 and 100');
    if (!Number.isSafeInteger(snapshotSequence) || snapshotSequence < 0 || snapshotSequence > latestSequence) throw new RuntimeError('INVALID_ARGUMENT', 'Invalid snapshot sequence');
    const rows = this.db.prepare(`SELECT t.task_id, t.goal, t.conversation_id, t.attachment_refs_json, t.state, t.revision, t.updated_at, t.steps_json, t.evidence_refs_json, t.result_summary, t.error_json, t.cancel_requested, e.sequence AS created_sequence FROM tasks t JOIN task_events e ON e.task_id = t.task_id AND e.type = 'task.created' WHERE e.sequence <= ? ORDER BY e.sequence DESC`).all(snapshotSequence) as unknown as Array<TaskRow & {created_sequence: number}>;
    const grouped = new Map<string, {sequence: number; tasks: TaskSnapshot[]}>();
    const conversationId = input.conversationId === undefined ? undefined : requireText(input.conversationId, 'conversationId');
    for (const row of rows) {
      if (conversationId !== undefined && row.conversation_id !== conversationId) continue;
      const current = grouped.get(row.conversation_id) ?? {sequence: row.created_sequence, tasks: []};
      current.tasks.push(taskFromRow(row)); grouped.set(row.conversation_id, current);
    }
    const conversations = [...grouped.entries()].filter(([, value]) => input.beforeSequence === undefined || value.sequence < input.beforeSequence).sort((a, b) => b[1].sequence - a[1].sequence);
    const more = conversations.length > limit;
    const page = conversations.slice(0, limit);
    return {items: page.map(([id, value]) => ({conversationId: id, updatedAt: value.tasks.reduce((latest, task) => task.updatedAt > latest ? task.updatedAt : latest, value.tasks[0]!.updatedAt), taskCount: value.tasks.length, tasks: value.tasks.reverse()})), snapshotSequence, ...(more ? {nextBeforeSequence: page.at(-1)![1].sequence} : {})};
  }

  listApprovals(input: {approvalId?: string; taskId?: string; state?: 'pending' | 'allowed' | 'denied'; beforeRowId?: number; limit?: number}): Result<'approval.list'> {
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RuntimeError('INVALID_ARGUMENT', 'limit must be between 1 and 100');
    const clauses: string[] = []; const params: SQLInputValue[] = [];
    if (input.approvalId !== undefined) { clauses.push('approval_id = ?'); params.push(requireText(input.approvalId, 'approvalId')); }
    if (input.taskId !== undefined) { clauses.push('task_id = ?'); params.push(requireText(input.taskId, 'taskId')); }
    if (input.state !== undefined) { clauses.push("json_extract(value_json, '$.state') = ?"); params.push(input.state); }
    if (input.beforeRowId !== undefined) { clauses.push('rowid < ?'); params.push(input.beforeRowId); }
    const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
    const rows = this.db.prepare(`SELECT rowid, value_json FROM tool_approvals${where} ORDER BY rowid DESC LIMIT ?`).all(...params, limit + 1) as Array<{rowid: number; value_json: string}>;
    const approvals = rows.map(row => ({rowId: row.rowid, value: JSON.parse(row.value_json) as ToolApproval}));
    const more = approvals.length > limit; const page = approvals.slice(0, limit);
    return {items: page.map(({value}) => ({approvalId: value.approvalId, taskId: value.taskId, revision: value.revision, action: value.toolName, scopes: [...value.scopes], expiresAt: value.expiresAt, state: value.state, argumentsDigest: value.argumentsDigest, argumentSummary: 'redacted' as const})), snapshotSequence: this.snapshotSequence(), ...(more ? {nextBeforeRowId: page.at(-1)!.rowId} : {})};
  }

  readConversationHistory(conversationId: string, beforeTaskId: string, limit = 20): ConversationTurn[] {
    const normalizedConversationId = requireText(conversationId, 'conversationId');
    const normalizedTaskId = requireText(beforeTaskId, 'beforeTaskId');
    if (!Number.isInteger(limit) || limit <= 0) throw new Error('limit must be a positive integer');

    this.getTask(normalizedTaskId);
    const currentEvent = this.db.prepare(
      `SELECT sequence FROM task_events
       WHERE task_id = ? AND type = 'task.created'
       ORDER BY sequence ASC LIMIT 1`,
    ).get(normalizedTaskId) as {sequence?: number} | undefined;
    if (!currentEvent || typeof currentEvent.sequence !== 'number') return [];

    const rows = this.db.prepare(
      `SELECT t.task_id AS taskId, t.goal, t.result_summary AS resultSummary
       FROM tasks t
       JOIN task_events e ON e.task_id = t.task_id AND e.type = 'task.created'
       WHERE t.conversation_id = ?
         AND t.state = 'succeeded'
         AND t.result_summary IS NOT NULL
         AND e.sequence < ?
       ORDER BY e.sequence DESC LIMIT ?`,
    ).all(normalizedConversationId, currentEvent.sequence, limit) as unknown as ConversationTurn[];

    return rows.reverse().map(row => ({
      taskId: row.taskId,
      goal: row.goal,
      resultSummary: row.resultSummary,
    }));
  }

  readToolExecutions(taskId: string): ToolExecutionRecord[] {
    this.getTask(taskId);
    return this.db.prepare('SELECT record_json FROM tool_execution_records WHERE task_id = ? ORDER BY rowid').all(taskId).map(row => JSON.parse(row.record_json as string) as ToolExecutionRecord);
  }

  readEvidence(taskId: string): import('@personal-agent/contracts').ProtocolContracts['evidence'][] {
    return this.readToolExecutions(taskId).map(record => {
      const evidence: import('@personal-agent/contracts').ProtocolContracts['evidence'] = {
        evidenceId: record.evidenceId, kind: 'execution', sourceRef: record.toolName,
        capturedAt: record.finishedAt ?? record.startedAt,
        summary: 'Tool execution ' + record.state + '; policy=' + record.policyDecision,
        verification: 'conditional', sensitivity: 'internal',
      };
      validateContract('evidence', evidence);
      return evidence;
    });
  }

  getApproval(approvalId: string): ToolApproval {
    const row = this.db.prepare('SELECT value_json FROM tool_approvals WHERE approval_id = ?').get(approvalId);
    if (!row) throw new RuntimeError('NOT_FOUND', 'Approval not found');
    return JSON.parse(row.value_json as string) as ToolApproval;
  }

  requestToolApproval(approvalId: string, taskId: string, tool: ToolDescriptor, expiresAt: string, argumentsDigest: string): ToolApproval {
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT value_json FROM tool_approvals WHERE approval_id = ?').get(approvalId);
      if (existing) {
        const approval = JSON.parse(existing.value_json as string) as ToolApproval;
        if (approval.taskId !== taskId || approval.toolName !== tool.name || approval.argumentsDigest !== argumentsDigest) throw new RuntimeError('REVISION_CONFLICT', 'Approval identity conflict');
        return approval;
      }
      if (this.getTask(taskId).state !== 'running') throw new RuntimeError('REVISION_CONFLICT', 'Task is not running');
      const approval: ToolApproval = {approvalId, taskId, toolName: tool.name, scopes: [...tool.requiredScopes], expiresAt, revision: 1, state: 'pending', argumentsDigest};
      this.db.prepare('INSERT INTO tool_approvals (approval_id, task_id, value_json) VALUES (?, ?, ?)').run(approvalId, taskId, JSON.stringify(approval));
      this.updateTask(taskId, 'waiting_approval', {}, true);
      this.emit('approval.requested', {approvalId, taskId, revision: 1, action: tool.name}, taskId);
      return approval;
    });
  }

  respondApproval(approvalId: string, decision: 'allow_once' | 'deny', expectedRevision: number): {accepted: boolean; approvalState: 'allowed' | 'denied'} {
    return this.transaction(() => {
      const approval = this.getApproval(approvalId);
      const state = decision === 'allow_once' ? 'allowed' : 'denied';
      if (approval.state !== 'pending') {
        if (approval.state !== state || expectedRevision !== approval.revision - 1) throw new RuntimeError('REVISION_CONFLICT', 'Approval was already resolved');
        return {accepted: true, approvalState: state};
      }
      if (approval.revision !== expectedRevision) throw new RuntimeError('REVISION_CONFLICT', 'Approval revision mismatch');
      if (this.getTask(approval.taskId).state !== 'waiting_approval') throw new RuntimeError('REVISION_CONFLICT', 'Task is not awaiting approval');
      if (Date.parse(approval.expiresAt) <= this.now().getTime()) throw new RuntimeError('TIMEOUT', 'Approval expired');
      approval.state = state;
      approval.revision++;
      if (state === 'allowed') this.policy.grant({authorizationRef: approvalId, taskId: approval.taskId, toolName: approval.toolName, scopes: approval.scopes, expiresAt: approval.expiresAt, maxUses: 1, argumentsDigest: approval.argumentsDigest});
      this.db.prepare('UPDATE tool_approvals SET value_json = ? WHERE approval_id = ?').run(JSON.stringify(approval), approvalId);
      if (state === 'denied') {
        const evidenceId = approvalId + '-decision';
        const record: ToolExecutionRecord = {evidenceId, inputDigest: createHash('sha256').update(approvalId).digest('hex'), protocolVersion: PROTOCOL_VERSION,
          requestId: approvalId, taskId: approval.taskId, toolName: approval.toolName, toolVersion: 'approval',
          startedAt: this.timestamp(), finishedAt: this.timestamp(), state: 'failed', errorCode: 'SCOPE_DENIED', policyDecision: 'deny', executionStarted: false};
        this.db.prepare('INSERT INTO tool_execution_records (evidence_id, task_id, record_json) VALUES (?, ?, ?)').run(evidenceId, approval.taskId, JSON.stringify(record));
        this.updateTask(approval.taskId, 'cancelled', {evidenceRefs: [...this.getTask(approval.taskId).evidenceRefs, evidenceId]}, true);
      }
      return {accepted: true, approvalState: state};
    });
  }

  private saveToolExecution(record: ToolExecutionRecord, result?: unknown): void {
    this.transaction(() => {
      if (record.state === 'confirmed') this.saveCheckpoint(record.taskId, 'tool-result-' + record.evidenceId, {result: result ?? null});
      this.db.prepare('INSERT INTO tool_execution_records (evidence_id, task_id, record_json) VALUES (?, ?, ?) ON CONFLICT(evidence_id) DO UPDATE SET record_json = excluded.record_json').run(record.evidenceId, record.taskId, JSON.stringify(record));
      const task = taskFromRow(this.taskRow(record.taskId));
      if (!task.evidenceRefs.includes(record.evidenceId)) task.evidenceRefs.push(record.evidenceId);
      task.revision++;
      task.updatedAt = this.timestamp();
      this.writeSnapshot(task);
    });
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
            capabilities: this.toolGateway ? [...baseCapabilities, 'capability.list', 'tool.invoke', 'authorization.respond'] : baseCapabilities,
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
        case 'task.list':
          data = this.listTasks(request.payload);
          break;
        case 'conversation.list':
          data = this.listConversations(request.payload);
          break;
        case 'approval.list':
          data = this.listApprovals(request.payload);
          break;
        case 'task.cancel':
          data = this.requestCancel(request.payload.taskId, request.payload.reason);
          break;
        case 'authorization.respond':
          data = this.respondApproval(request.payload.approvalId, request.payload.decision, request.payload.expectedRevision);
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
          const runId = request.idempotencyKey ?? this.idFactory();
          const inputDigest = createHash('sha256').update(canonical({taskId: request.taskId, payload: request.payload})).digest('hex');
          const previousRow = this.db.prepare('SELECT record_json FROM tool_execution_records WHERE evidence_id = ?').get(runId);
          if (previousRow) {
            const previous = JSON.parse(previousRow.record_json as string) as ToolExecutionRecord;
            if (previous.inputDigest !== inputDigest) throw new RuntimeError('REVISION_CONFLICT', 'Tool run ID was reused with different input');
            if (previous.state === 'confirmed') {
              const saved = this.loadCheckpoint(request.taskId, 'tool-result-' + runId) as {result: unknown};
              data = {runId, state: 'confirmed', result: saved.result, evidenceRefs: [runId]};
            } else if (previous.state === 'failed') {
              throw new RuntimeError('EXTERNAL_FAILURE', 'Previous tool attempt failed; it will not be repeated automatically');
            } else {
              this.transitionTask(request.taskId, 'waiting_reconciliation');
              data = {runId, state: 'unknown', evidenceRefs: [runId]};
            }
            break;
          }
          const record: ToolExecutionRecord = {
            protocolVersion: PROTOCOL_VERSION, policyDecision: 'not_evaluated', executionStarted: false,
            inputDigest,
            evidenceId: runId, requestId: request.requestId, taskId: request.taskId,
            toolName: request.payload.toolName, toolVersion: request.payload.toolVersion,
            startedAt: this.timestamp(), state: 'started',
          };
          this.saveToolExecution(record);
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
              onAuthorized: () => { record.policyDecision = 'allow'; record.executionStarted = true; this.saveToolExecution(record); },
            });
            this.saveToolExecution({...record, state: 'confirmed', finishedAt: this.timestamp()}, result);
            data = {runId, state: 'confirmed', result, evidenceRefs: [runId]};
            this.emit('tool.completed', {runId, state: 'confirmed', evidenceRefs: [runId]}, request.taskId);
          } catch (error) {
            const errorCode = error instanceof ProtocolError ? error.code : 'EXTERNAL_FAILURE';
            if (!record.executionStarted) record.policyDecision = 'deny';
            this.saveToolExecution({...record, state: errorCode === 'RESULT_UNKNOWN' ? 'unknown' : 'failed', errorCode, finishedAt: this.timestamp()});
            if (error instanceof ProtocolError && error.code === 'RESULT_UNKNOWN') {
              this.transitionTask(request.taskId, 'waiting_reconciliation', {
                error: {code: 'RESULT_UNKNOWN', message: error.message, retryable: false}
              });
              data = {runId, state: 'unknown', evidenceRefs: [runId]};
              this.emit('tool.completed', {runId, state: 'unknown', evidenceRefs: [runId]}, request.taskId);
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
    const wasWaitingApproval = this.getTask(taskId).state === 'waiting_approval';
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
    if (wasWaitingApproval && !this.active.has(taskId) && result.state === 'cancelling') {
      return {taskId, state: this.confirmCancellation(taskId).state, cancelAccepted: true};
    }
    return result;
  }

  confirmCancellation(taskId: string): TaskSnapshot {
    return this.transitionTask(taskId, 'cancelled', {cancelRequested: true});
  }

  async runTask(taskId: string, worker: (context: WorkerContext) => Promise<WorkerResult>, options: RunOptions): Promise<TaskSnapshot> {
    const deadlineMs = parseTime(options.deadline, 'deadline');
    const initial = this.getTask(taskId);
    if ((initial.state !== 'created' && !(options.resume && initial.state === 'waiting_approval')) || this.active.has(taskId)) {
      throw new RuntimeError('REVISION_CONFLICT', 'Task is not ready to start');
    }
    const controller = new AbortController();
    this.active.set(taskId, controller);
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    try {
      if (initial.state === 'created') this.transitionTask(taskId, 'planning');
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
      if (current.state === 'waiting_reconciliation' || current.state === 'waiting_approval' || terminal.has(current.state)) return current;
      this.transitionTask(taskId, 'verifying');
      return this.transitionTask(taskId, 'succeeded', {
        resultSummary: result.resultSummary,
        evidenceRefs: [...new Set([...current.evidenceRefs, ...(result.evidenceRefs ?? [])])]
      });
    } catch (error) {
      const current = this.getTask(taskId);
      if (terminal.has(current.state)) return current;
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
          code: error instanceof RuntimeError || error instanceof ProtocolError ? error.code as TaskError['code'] : 'EXTERNAL_FAILURE',
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
