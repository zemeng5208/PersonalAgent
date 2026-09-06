import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {Client, EventCursor} from '@personal-agent/client';
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
    assert.deepEqual(handshake.capabilities, ['system.handshake', 'task.submit', 'task.get', 'task.cancel', 'event.subscribe']);
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
