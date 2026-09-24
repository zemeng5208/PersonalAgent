import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {Client, EventCursor} from '@personal-agent/client';
import {ProtocolError} from '@personal-agent/contracts';
import {InMemoryAuthorizationPolicy} from '@personal-agent/policy';
import {ToolGateway} from '@personal-agent/tool-gateway';
import {RuntimeError, TaskRuntime} from '../dist/index.js';

const root = fileURLToPath(new URL('../../../.cache/runtime-tests/', import.meta.url));
mkdirSync(root, {recursive: true});
const file = () => join(mkdtempSync(join(root, 'case-')), 'runtime.sqlite');

function fixture(path = file(), start = '2026-09-06T02:00:00.000Z') {
  let current = Date.parse(start);
  let sequence = 0;
  const options = {
    now: () => new Date(current),
    idFactory: () => 'fixture-' + ++sequence
  };
  return {
    path,
    options,
    setNow(value) { current = Date.parse(value); },
    open() { return new TaskRuntime(path, options); }
  };
}

const submission = {
  goal: 'verify a persisted task',
  conversationId: 'conversation-1',
  idempotencyKey: 'submit-1'
};

test('submission is durable and idempotency keys reject different input', () => {
  const setup = fixture();
  const runtime = setup.open();
  try {
    const first = runtime.submitTask(submission);
    const repeated = runtime.submitTask(submission);
    assert.deepEqual(repeated, first);
    assert.throws(
      () => runtime.submitTask({...submission, goal: 'different'}),
      error => error instanceof RuntimeError && error.code === 'REVISION_CONFLICT'
    );
  } finally {
    runtime.close();
  }
  const reopened = setup.open();
  try {
    assert.equal(reopened.getTask('fixture-1').state, 'created');
  } finally {
    reopened.close();
  }
});

test('public Client negotiates and uses the persisted Runtime task operations', async () => {
  const setup = fixture();
  const runtime = setup.open();
  try {
    const client = new Client(runtime, () => Date.parse('2026-09-06T02:00:00.000Z'));
    const handshake = await client.connect();
    assert.deepEqual(handshake.capabilities, ['system.handshake', 'task.submit', 'task.get', 'task.list', 'conversation.list', 'approval.list', 'task.cancel', 'event.subscribe']);
    const submitted = await client.call('task.submit', {
      goal: 'submit through public client',
      conversationId: 'conversation-client'
    }, {idempotencyKey: 'client-submit'});
    assert.equal((await client.call('task.get', {taskId: submitted.taskId})).state, 'created');
    assert.equal((await client.call('task.cancel', {taskId: submitted.taskId})).state, 'cancelling');
    runtime.confirmCancellation(submitted.taskId);
    const subscription = await client.call('event.subscribe', {streamId: 'tasks', afterSequence: 0});
    assert.equal(subscription.replayFrom, 1);
    const cursor = new EventCursor('tasks');
    assert.equal(cursor.accept(runtime.readEvents()).at(-1).type, 'task.cancelled');
    await assert.rejects(client.call('capability.list', {}), {code: 'UNSUPPORTED_CAPABILITY'});
  } finally {
    runtime.close();
  }
});

test('public Client discovers and invokes a policy-checked tool', async () => {
  const setup = fixture();
  const policy = new InMemoryAuthorizationPolicy();
  const gateway = new ToolGateway({policy, now: () => setup.options.now().getTime()});
  gateway.register({
    descriptor: {
      name: 'fixture.echo',
      version: '1.0.0',
      inputSchema: {type: 'object', required: ['value'], additionalProperties: false, properties: {value: {type: 'string'}}},
      outputSchema: {type: 'object', required: ['value'], additionalProperties: false, properties: {value: {type: 'string'}}},
      sideEffect: 'read',
      requiredScopes: ['fixture:read'],
      idempotencySupport: true,
      recoverySupport: true,
      requiresPresence: false,
    },
    execute: async (input, context) => {
      assert.deepEqual(context.scopes, ['fixture:read']);
      return input;
    },
  });
  gateway.register({
    descriptor: {
      name: 'fixture.unknown-write',
      version: '1.0.0',
      inputSchema: {type: 'object', additionalProperties: false},
      outputSchema: {type: 'object'},
      sideEffect: 'external_write',
      requiredScopes: ['fixture:write'],
      idempotencySupport: false,
      recoverySupport: true,
      requiresPresence: false,
    },
    execute: async () => {
      throw new ProtocolError('RESULT_UNKNOWN', 'External write result requires reconciliation');
    },
  });
  const runtime = new TaskRuntime(setup.path, {...setup.options, toolGateway: gateway});
  try {
    const client = new Client(runtime, () => setup.options.now().getTime());
    const handshake = await client.connect();
    assert.equal(handshake.capabilities.includes('capability.list'), true);
    assert.equal(handshake.capabilities.includes('tool.invoke'), true);
    const task = await client.call('task.submit', {
      goal: 'invoke an authorized fixture tool',
      conversationId: 'conversation-tool',
    }, {idempotencyKey: 'tool-task'});
    runtime.transitionTask(task.taskId, 'planning');
    runtime.transitionTask(task.taskId, 'running');
    policy.grant({
      authorizationRef: 'auth-tool',
      taskId: task.taskId,
      toolName: 'fixture.echo',
      scopes: ['fixture:read'],
      expiresAt: '2026-09-06T02:01:00.000Z',
    });
    const capabilities = await client.call('capability.list', {kind: 'tool'});
    assert.equal(capabilities.manifests[0].name, 'fixture.echo');
    assert.deepEqual(capabilities.health, [
      {id: 'fixture.echo', state: 'ready'},
      {id: 'fixture.unknown-write', state: 'ready'},
    ]);
    const result = await client.call('tool.invoke', {
      toolName: 'fixture.echo',
      toolVersion: '1.0.0',
      arguments: {value: 'verified'},
      scopeRef: 'auth-tool',
    }, {taskId: task.taskId});
    assert.equal(result.state, 'confirmed');
    assert.deepEqual(result.result, {value: 'verified'});
    assert.equal(runtime.readEvents().at(-1).type, 'tool.completed');
    assert.equal(runtime.readEvents().at(-1).taskId, task.taskId);
    await assert.rejects(client.call('tool.invoke', {
      toolName: 'fixture.echo',
      toolVersion: '1.0.0',
      arguments: {value: 'forged'},
      scopeRef: 'forged',
    }, {taskId: task.taskId}), {code: 'UNAUTHORIZED'});

    policy.grant({
      authorizationRef: 'auth-unknown',
      taskId: task.taskId,
      toolName: 'fixture.unknown-write',
      scopes: ['fixture:write'],
      expiresAt: '2026-09-06T02:01:00.000Z',
    });
    const unknown = await client.call('tool.invoke', {
      toolName: 'fixture.unknown-write',
      toolVersion: '1.0.0',
      arguments: {},
      scopeRef: 'auth-unknown',
    }, {taskId: task.taskId});
    assert.equal(unknown.state, 'unknown');
    assert.equal(runtime.getTask(task.taskId).state, 'waiting_reconciliation');
    assert.equal(runtime.getTask(task.taskId).error.code, 'RESULT_UNKNOWN');
    assert.equal(runtime.readEvents().at(-1).type, 'tool.completed');
    await assert.rejects(client.call('tool.invoke', {
      toolName: 'fixture.unknown-write',
      toolVersion: '1.0.0',
      arguments: {},
      scopeRef: 'auth-unknown',
    }, {taskId: task.taskId}), {code: 'REVISION_CONFLICT'});

    const inactive = runtime.submitTask({...submission, idempotencyKey: 'inactive-tool-task'});
    policy.grant({
      authorizationRef: 'auth-inactive',
      taskId: inactive.taskId,
      toolName: 'fixture.echo',
      scopes: ['fixture:read'],
      expiresAt: '2026-09-06T02:01:00.000Z',
    });
    await assert.rejects(client.call('tool.invoke', {
      toolName: 'fixture.echo',
      toolVersion: '1.0.0',
      arguments: {value: 'must not run'},
      scopeRef: 'auth-inactive',
    }, {taskId: inactive.taskId}), {code: 'REVISION_CONFLICT'});
  } finally {
    runtime.close();
  }
});

test('runTask, progress and events form a complete truthful lifecycle', async () => {
  const runtime = fixture().open();
  try {
    const task = runtime.submitTask(submission);
    const complete = await runtime.runTask(task.taskId, async context => {
      context.reportProgress({stepId: 'step-1', label: 'fixture work', completedUnits: 1, totalUnits: 1});
      return {resultSummary: 'verified fixture result'};
    }, {deadline: '2026-09-06T02:01:00.000Z', sideEffect: 'read'});
    assert.equal(complete.resultSummary, 'verified fixture result');
    assert.throws(
      () => runtime.transitionTask(task.taskId, 'running'),
      error => error instanceof RuntimeError && error.code === 'REVISION_CONFLICT'
    );
    const events = runtime.readEvents();
    assert.deepEqual(events.map(event => event.sequence), events.map((_, index) => index + 1));
    assert.deepEqual(events.map(event => event.type), [
      'task.created',
      'task.state_changed',
      'task.state_changed',
      'task.progress',
      'task.state_changed',
      'task.state_changed',
      'task.completed'
    ]);
  } finally {
    runtime.close();
  }
});

test('cancellation reaches the running worker before cancelled is emitted', async () => {
  const runtime = fixture().open();
  try {
    const task = runtime.submitTask(submission);
    let start;
    const started = new Promise(resolve => { start = resolve; });
    let sawAbort = false;
    const running = runtime.runTask(task.taskId, async ({signal}) => {
      start();
      await new Promise((_, reject) => signal.addEventListener('abort', () => {
        sawAbort = true;
        reject(new Error('worker stopped'));
      }, {once: true}));
      return {resultSummary: 'unreachable'};
    }, {deadline: '2026-09-06T02:01:00.000Z', sideEffect: 'read'});
    await started;
    const accepted = runtime.requestCancel(task.taskId, 'test cancellation');
    assert.equal(accepted.state, 'cancelling');
    assert.equal(accepted.cancelAccepted, true);
    const cancelled = await running;
    assert.equal(sawAbort, true);
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(runtime.readEvents().at(-1).type, 'task.cancelled');
  } finally {
    runtime.close();
  }
});

test('restart preserves checkpoints and moves interrupted work to reconciliation', () => {
  const setup = fixture();
  let runtime = setup.open();
  const task = runtime.submitTask(submission);
  runtime.transitionTask(task.taskId, 'planning');
  runtime.transitionTask(task.taskId, 'running');
  runtime.saveCheckpoint(task.taskId, 'step-1', {cursor: 7});
  const before = runtime.readEvents().length;
  runtime.close();

  runtime = setup.open();
  try {
    assert.deepEqual(runtime.loadCheckpoint(task.taskId, 'step-1'), {cursor: 7});
    const recovered = runtime.recoverInterruptedTasks();
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].state, 'waiting_reconciliation');
    assert.equal(recovered[0].error.code, 'RESULT_UNKNOWN');
    assert.equal(runtime.readEvents().length, before + 1);
    assert.equal(runtime.recoverInterruptedTasks().length, 0);
    assert.equal(runtime.reconcileTask(task.taskId, 'not_performed').state, 'failed');
  } finally {
    runtime.close();
  }
});

test('timed out external writes stay unknown and are never invoked again automatically', async () => {
  const runtime = fixture().open();
  try {
    const task = runtime.submitTask(submission);
    let calls = 0;
    const result = await runtime.runTask(task.taskId, async ({signal}) => {
      calls++;
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), {once: true}));
      return {resultSummary: 'unreachable'};
    }, {deadline: '2026-09-06T02:00:00.010Z', sideEffect: 'external_write'});
    assert.equal(calls, 1);
    assert.equal(result.state, 'waiting_reconciliation');
    assert.equal(result.error.code, 'RESULT_UNKNOWN');
    assert.equal(runtime.recoverInterruptedTasks().length, 0);
    assert.equal(calls, 1);
    await assert.rejects(
      runtime.runTask(task.taskId, async () => ({resultSummary: 'must not retry'}), {
        deadline: '2026-09-06T02:01:00.000Z',
        sideEffect: 'external_write'
      }),
      error => error instanceof RuntimeError && error.code === 'REVISION_CONFLICT'
    );
    assert.equal(runtime.reconcileTask(task.taskId, 'confirmed').state, 'succeeded');
    assert.equal(calls, 1);
  } finally {
    runtime.close();
  }
});

test('timed out local writes preserve an already applied effect for reconciliation', async () => {
  const setup = fixture();
  const effectPath = `${setup.path}.effect`;
  const runtime = setup.open();
  let applied = 0;
  let taskId;
  try {
    taskId = runtime.submitTask(submission).taskId;
    const result = await runtime.runTask(taskId, async ({signal}) => {
      writeFileSync(effectPath, 'applied', 'utf8');
      applied++;
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), {once: true}));
      return {resultSummary: 'unreachable'};
    }, {deadline: '2026-09-06T02:00:00.010Z', sideEffect: 'local_write'});
    assert.equal(applied, 1);
    assert.equal(readFileSync(effectPath, 'utf8'), 'applied');
    assert.equal(result.state, 'waiting_reconciliation');
    assert.equal(result.error.code, 'RESULT_UNKNOWN');
  } finally {
    runtime.close();
  }

  const reopened = setup.open();
  try {
    assert.equal(reopened.getTask(taskId).state, 'waiting_reconciliation');
    await assert.rejects(
      reopened.runTask(taskId, async () => {
        applied++;
        return {resultSummary: 'must not repeat the write'};
      }, {deadline: '2026-09-06T02:01:00.000Z', sideEffect: 'local_write'}),
      error => error instanceof RuntimeError && error.code === 'REVISION_CONFLICT'
    );
    assert.equal(applied, 1);
    assert.equal(readFileSync(effectPath, 'utf8'), 'applied');
  } finally {
    reopened.close();
  }
});

test('one-shot schedules apply explicit run-once or skip recovery policy', () => {
  const setup = fixture();
  let runtime = setup.open();
  runtime.createSchedule({
    scheduleId: 'schedule-run',
    goal: 'run after restart',
    conversationId: 'conversation-1',
    runAt: '2026-09-06T02:01:00.000Z',
    timeZone: 'Asia/Shanghai',
    missedRunPolicy: 'run_once',
    taskIdempotencyKey: 'schedule-task-run'
  });
  runtime.createSchedule({
    scheduleId: 'schedule-skip',
    goal: 'skip after restart',
    conversationId: 'conversation-1',
    runAt: '2026-09-06T02:01:00.000Z',
    timeZone: 'Asia/Shanghai',
    missedRunPolicy: 'skip',
    taskIdempotencyKey: 'schedule-task-skip'
  });
  runtime.createSchedule({
    scheduleId: 'schedule-normal',
    goal: 'run during normal dispatch',
    conversationId: 'conversation-1',
    runAt: '2026-09-06T02:06:00.000Z',
    timeZone: 'Asia/Shanghai',
    missedRunPolicy: 'skip',
    taskIdempotencyKey: 'schedule-task-normal'
  });
  runtime.close();

  setup.setNow('2026-09-06T02:05:00.000Z');
  runtime = setup.open();
  try {
    const recovered = runtime.recoverMissedSchedules();
    assert.deepEqual(recovered.map(item => item.status), ['fired', 'skipped']);
    assert.equal(recovered[0].task.state, 'created');
    assert.equal(runtime.getSchedule('schedule-skip').status, 'skipped');
    assert.deepEqual(runtime.recoverMissedSchedules(), []);
    setup.setNow('2026-09-06T02:07:00.000Z');
    const normal = runtime.dispatchDueSchedules();
    assert.equal(normal.length, 1);
    assert.equal(normal[0].status, 'fired');
    assert.equal(runtime.getSchedule('schedule-normal').status, 'fired');
  } finally {
    runtime.close();
  }
});

test('public queries page task and conversation snapshots and redact approvals', async () => {
  const setup = fixture();
  const runtime = setup.open();
  try {
    const client = new Client(runtime, () => setup.options.now().getTime());
    await client.connect();
    const first = await client.call('task.submit', {goal: 'first', conversationId: 'conversation-a'}, {idempotencyKey: 'query-1'});
    await client.call('task.submit', {goal: 'second', conversationId: 'conversation-a'}, {idempotencyKey: 'query-2'});
    await client.call('task.submit', {goal: 'third', conversationId: 'conversation-b'}, {idempotencyKey: 'query-3'});
    const firstPage = await client.call('task.list', {limit: 2});
    assert.equal(firstPage.items.length, 2);
    assert.equal(typeof firstPage.nextBeforeSequence, 'number');
    const secondPage = await client.call('task.list', {limit: 2, beforeSequence: firstPage.nextBeforeSequence, snapshotSequence: firstPage.snapshotSequence});
    assert.equal(secondPage.items.length, 1);
    assert.equal(secondPage.items[0].goal, 'first');
    const conversations = await client.call('conversation.list', {conversationId: 'conversation-a'});
    assert.equal(conversations.items[0].taskCount, 2);
    assert.deepEqual(conversations.items[0].tasks.map(task => task.goal), ['first', 'second']);

    runtime.transitionTask(first.taskId, 'planning');
    runtime.transitionTask(first.taskId, 'running');
    runtime.requestToolApproval('approval-query', first.taskId, {
      name: 'fixture.read', version: '1.0.0', inputSchema: {}, outputSchema: {}, sideEffect: 'read',
      requiredScopes: ['fixture:read'], idempotencySupport: true, recoverySupport: true, requiresPresence: false,
    }, '2026-09-06T02:01:00.000Z', 'a'.repeat(64));
    const approvals = await client.call('approval.list', {approvalId: 'approval-query'});
    assert.equal(approvals.items.length, 1);
    assert.equal(approvals.items[0].argumentSummary, 'redacted');
    assert.equal(approvals.items[0].argumentsDigest, 'a'.repeat(64));
    assert.equal('arguments' in approvals.items[0], false);
  } finally {
    runtime.close();
  }
});
