import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runFixedSyntheticBatch} from './fixed-synthetic-batch.mjs';

const futureDeadline = milliseconds => new Date(Date.now() + milliseconds).toISOString();
const fixedReplies = ['RECHECK', 'KEEP', 'REJECT'];

test('runs the fixed cases sequentially once with unique task IDs and one caller deadline', async () => {
  const deadline = futureDeadline(10_000);
  const requests = [];
  let active = 0;
  let maximumActive = 0;
  const port = {
    async execute(request) {
      active++;
      maximumActive = Math.max(maximumActive, active);
      const reply = fixedReplies[requests.length];
      requests.push(request);
      await Promise.resolve();
      active--;
      return {kind: 'text', text: reply, verification: 'mock'};
    },
  };

  const result = await runFixedSyntheticBatch(port, {
    deadline,
    signal: new AbortController().signal,
  });

  assert.equal(maximumActive, 1);
  assert.equal(requests.length, 3);
  assert.equal(new Set(requests.map(request => request.taskId)).size, 3);
  assert.ok(requests.every(request => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(request.taskId)));
  assert.ok(requests.every(request => request.revision === 1 && request.deadline === deadline));
  for (const request of requests) {
    assert.doesNotMatch(request.goal, /required output|expected (?:output|label)|correct label|answer is/i);
    const [rubric, scenario, extra] = request.goal.split('\n\nSynthetic case:\n');
    assert.equal(extra, undefined);
    assert.match(rubric, /KEEP:/);
    assert.match(rubric, /RECHECK:/);
    assert.match(rubric, /REJECT:/);
    assert.doesNotMatch(scenario, /\b(?:KEEP|RECHECK|REJECT)\b/);
  }
  assert.deepEqual(result.counts, {total: 3, passed: 3, failed: 0, error: 0, notRun: 0});
  assert.ok(result.cases.every(item => item.status === 'passed' && item.errorCode === 'NONE'));
  assert.equal(result.schemaVersion, '1.0');
  assert.equal(result.profile, 'huawei_ict_agentarts');
  assert.equal(result.synthetic, true);
  assert.ok(Number.isInteger(result.durationMs) && result.durationMs >= 0);
});

test('scores only exact fixed classifications and exposes no response text', async () => {
  let call = 0;
  const replies = ['RECHECK', 'KEEP with explanation', 'REJECT'];
  const result = await runFixedSyntheticBatch({
    async execute() {
      return {kind: 'text', text: replies[call++], verification: 'unverified'};
    },
  }, {
    deadline: futureDeadline(10_000),
    signal: new AbortController().signal,
  });

  assert.deepEqual(result.counts, {total: 3, passed: 2, failed: 1, error: 0, notRun: 0});
  assert.equal(result.cases[1].errorCode, 'CLASSIFICATION_MISMATCH');
  assert.equal(JSON.stringify(result).includes('KEEP with explanation'), false);
  assert.deepEqual(Object.keys(result.cases[0]), ['caseId', 'status', 'verification', 'errorCode']);
});

test('sanitizes ordinary failures and continues the remaining fixed cases without retry', async () => {
  const calls = [];
  const result = await runFixedSyntheticBatch({
    async execute(request) {
      calls.push(request.taskId);
      if (calls.length === 1) throw new Error('private-response-and-credential');
      return {kind: 'text', text: fixedReplies[calls.length - 1], verification: 'mock'};
    },
  }, {
    deadline: futureDeadline(10_000),
    signal: new AbortController().signal,
  });

  assert.equal(calls.length, 3);
  assert.deepEqual(result.counts, {total: 3, passed: 2, failed: 0, error: 1, notRun: 0});
  assert.equal(result.cases[0].errorCode, 'EXTERNAL_FAILURE');
  assert.equal(JSON.stringify(result).includes('private-response-and-credential'), false);
});

test('cancellation stops subsequent cases and does not retry a non-cooperative port', async () => {
  let calls = 0;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const controller = new AbortController();
  const pending = runFixedSyntheticBatch({
    async execute() {
      calls++;
      started();
      return new Promise(() => {});
    },
  }, {
    deadline: futureDeadline(10_000),
    signal: controller.signal,
  });
  await ready;
  controller.abort();
  const result = await pending;

  assert.equal(calls, 1);
  assert.deepEqual(result.counts, {total: 3, passed: 0, failed: 0, error: 1, notRun: 2});
  assert.equal(result.cases[0].errorCode, 'CANCELLED');
  assert.ok(result.cases.slice(1).every(item => item.status === 'not_run' && item.errorCode === 'BATCH_CANCELLED'));
});

test('deadline stops subsequent cases and does not retry a non-cooperative port', async () => {
  let calls = 0;
  const result = await runFixedSyntheticBatch({
    async execute() {
      calls++;
      return new Promise(() => {});
    },
  }, {
    deadline: futureDeadline(120),
    signal: new AbortController().signal,
  });

  assert.equal(calls, 1);
  assert.deepEqual(result.counts, {total: 3, passed: 0, failed: 0, error: 1, notRun: 2});
  assert.equal(result.cases[0].errorCode, 'TIMEOUT');
  assert.ok(result.cases.slice(1).every(item => item.status === 'not_run' && item.errorCode === 'BATCH_TIMEOUT'));
});

test('requires an explicit canonical future UTC deadline and signal before invoking the port', async () => {
  let calls = 0;
  const port = {async execute() { calls++; return {kind: 'text', text: 'KEEP', verification: 'mock'}; }};
  for (const options of [
    {},
    {deadline: 'tomorrow', signal: new AbortController().signal},
    {deadline: '2000-01-01T00:00:00.000Z', signal: new AbortController().signal},
    {deadline: futureDeadline(10_000), signal: {}},
    {deadline: futureDeadline(10_000), signal: new AbortController().signal, privateInput: 'forbidden'},
  ]) {
    await assert.rejects(runFixedSyntheticBatch(port, options), {code: 'INVALID_ARGUMENT'});
  }
  const hostileOptions = Object.defineProperties({}, {
    deadline: {enumerable: true, get() { throw new Error('private-deadline'); }},
    signal: {enumerable: true, value: new AbortController().signal},
  });
  await assert.rejects(
    runFixedSyntheticBatch(port, hostileOptions),
    error => error.code === 'INVALID_ARGUMENT' && !error.message.includes('private-deadline'),
  );
  assert.equal(calls, 0);
});
