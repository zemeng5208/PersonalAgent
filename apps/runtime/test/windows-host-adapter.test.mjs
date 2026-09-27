import assert from 'node:assert/strict';
import {test} from 'node:test';
import {toolArgumentsDigest} from '@personal-agent/tool-gateway';
import {createWindowsHostNotepadAdapter} from '../dist/application/windows-host-adapter.js';

const targetRef = 'notepad_target_123456789';
const deadline = () => new Date(Date.now() + 30000).toISOString();
const input = {targetRef, expectedText: 'old', replacementText: 'new'};
const context = () => ({taskId: 'task-1', runId: 'run-1', authorizationRef: 'grant-1',
  deadline: deadline(), signal: new AbortController().signal, scopes: ['computer:notepad:write']});
const base = frame => ({protocolVersion: frame.protocolVersion, requestId: frame.requestId,
  sessionId: frame.sessionId});

function fixture({executeState = 'verified', statusState = 'not_found', readback = true,
  presence = true, onRecord, observationError, now} = {}) {
  const sent = [];
  const attempts = new Map();
  let sessions = 0;
  let verifiedReads = 0;
  const transport = {
    async openVerifiedConnection() {
      const sessionId = 'session_' + ++sessions;
      return {
        async send(frame) { sent.push(frame); },
        async exchange(frame) {
          sent.push(frame);
          if (frame.kind === 'hello') return {kind: 'hello_ack', protocolVersion: frame.protocolVersion,
            requestId: frame.requestId, clientNonce: frame.clientNonce,
            hostNonce: 'a'.repeat(32), sessionId};
          if (frame.kind === 'observe') return observationError
            ? {kind: 'observation_refused', ...base(frame), errorCode: observationError}
            : {kind: 'observed', ...base(frame), targetRef,
              expiresAt: deadline(), source: 'windows-uia'};
          if (frame.kind === 'execute') return {kind: 'result', ...base(frame), taskId: frame.taskId,
            runId: frame.runId, toolName: frame.toolName, toolVersion: frame.toolVersion,
            argumentsDigest: frame.argumentsDigest, targetRef: frame.targetRef, state: executeState,
            startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
            ...(executeState === 'verified' ? {evidenceRef: 'host-evidence'} : {errorCode: 'RESULT_UNKNOWN'})};
          if (frame.kind === 'status') return {kind: 'status_reply', ...base(frame),
            taskId: frame.taskId, runId: frame.runId, state: statusState};
          throw Error('Unexpected frame ' + frame.kind);
        },
        async close() {},
      };
    },
  };
  const adapter = createWindowsHostNotepadAdapter({transport, now,
    attempts: {
      async record(identity) {
        if (attempts.has(identity.runId)) throw Error('duplicate run');
        attempts.set(identity.runId, structuredClone(identity));
        await onRecord?.();
      },
      async read(taskId, runId) {
        const identity = attempts.get(runId);
        return identity?.taskId === taskId ? identity : undefined;
      },
    },
    async authorizePresence(value) {
      assert.equal(value.taskId, 'task-1');
      return presence;
    },
    async verifyTarget(value) {
      verifiedReads++;
      assert.equal(value.replacementText, 'new');
      return readback;
    },
  });
  return {adapter, sent, attempts, get verifiedReads() {return verifiedReads;}};
}

test('registered Notepad tool binds observed target and run identity, then requires readback', async () => {
  const f = fixture();
  assert.equal(f.adapter.tool.descriptor.name, 'computer.notepad.replace_text');
  assert.equal(f.adapter.tool.descriptor.sideEffect, 'local_write');
  assert.equal(f.adapter.tool.descriptor.requiresPresence, false);
  await f.adapter.observe('task-1', deadline(), new AbortController().signal);
  const result = await f.adapter.tool.execute(input, context());
  assert.deepEqual(result, {state: 'verified', hostEvidenceRef: 'host-evidence'});
  assert.equal(f.verifiedReads, 1);
  const execute = f.sent.find(frame => frame.kind === 'execute');
  assert.equal(execute.taskId, 'task-1');
  assert.equal(execute.runId, 'run-1');
  assert.equal(execute.authorizationRef, 'grant-1');
  assert.equal(execute.argumentsDigest, toolArgumentsDigest(input));
  assert.equal(execute.targetRef, targetRef);
  assert.equal(f.attempts.get('run-1').argumentsDigest, execute.argumentsDigest);
  assert.deepEqual(f.sent.slice(0, 4).map(frame => frame.kind), ['hello', 'bind', 'observe', 'execute']);
});

test('trusted presence callback is mandatory and denial prevents observation or execution', async () => {
  assert.throws(() => createWindowsHostNotepadAdapter({transport: {}, attempts: {}, verifyTarget: async () => true}),
    {code: 'UNSUPPORTED_CAPABILITY'});
  const f = fixture({presence: false});
  await assert.rejects(f.adapter.observe('task-1', deadline(), new AbortController().signal),
    {code: 'UNAUTHORIZED'});
  assert.equal(f.sent.length, 0);
  await assert.rejects(f.adapter.tool.execute(input, context()), {code: 'UNAUTHORIZED'});
  assert.equal(f.sent.filter(frame => frame.kind === 'execute').length, 0);
});

test('Host-specific observation refusals map to public conservative codes', async () => {
  for (const [host, expected] of [['TARGET_AMBIGUOUS', 'UNAUTHORIZED'], ['TARGET_STALE', 'NOT_FOUND']]) {
    const f = fixture({observationError: host});
    await assert.rejects(f.adapter.observe('task-1', deadline(), new AbortController().signal),
      {code: expected});
    assert.equal(f.sent.filter(frame => frame.kind === 'execute').length, 0);
  }
});

test('late abort after durable attempt is recorded never sends execute', async () => {
  const controller = new AbortController();
  const f = fixture({onRecord: () => controller.abort()});
  await f.adapter.observe('task-1', deadline(), new AbortController().signal);
  await assert.rejects(f.adapter.tool.execute(input, {...context(), signal: controller.signal}),
    {code: 'CANCELLED'});
  assert.equal(f.attempts.has('run-1'), true);
  assert.equal(f.sent.filter(frame => frame.kind === 'execute').length, 0);
});

test('deadline after durable attempt is recorded never sends execute', async () => {
  let time = Date.now();
  const f = fixture({now: () => time, onRecord: () => { time += 6000; }});
  await f.adapter.observe('task-1', deadline(), new AbortController().signal);
  const expiredContext = {...context(), deadline: new Date(time + 5000).toISOString()};
  await assert.rejects(f.adapter.tool.execute(input, expiredContext), {code: 'TIMEOUT'});
  assert.equal(f.attempts.has('run-1'), true);
  assert.equal(f.sent.filter(frame => frame.kind === 'execute').length, 0);
});

test('missing observation and changed target never reach Host execute', async () => {
  const f = fixture();
  await assert.rejects(f.adapter.tool.execute(input, context()), {code: 'UNAUTHORIZED'});
  await f.adapter.observe('task-1', deadline(), new AbortController().signal);
  await assert.rejects(f.adapter.tool.execute({...input, targetRef: 'other_target_123456'}, context()), {code: 'UNAUTHORIZED'});
  assert.equal(f.sent.filter(frame => frame.kind === 'execute').length, 0);
});

test('one adapter serializes Host sessions until the observed target is consumed', async () => {
  const f = fixture();
  await f.adapter.observe('task-1', deadline(), new AbortController().signal);
  await assert.rejects(f.adapter.observe('task-2', deadline(), new AbortController().signal),
    {code: 'REVISION_CONFLICT'});
  await assert.rejects(f.adapter.recover('task-1', 'run-1'), {code: 'REVISION_CONFLICT'});
  await f.adapter.tool.execute(input, context());
  const recovered = await f.adapter.recover('task-1', 'run-1');
  assert.deepEqual(recovered, {state: 'unknown', reason: 'not_found'});
});

test('Host verified without independent readback remains result unknown', async () => {
  const f = fixture({readback: false});
  await f.adapter.observe('task-1', deadline(), new AbortController().signal);
  await assert.rejects(f.adapter.tool.execute(input, context()), {code: 'RESULT_UNKNOWN'});
  assert.equal(f.sent.filter(frame => frame.kind === 'execute').length, 1);
});

test('recovery polls original identity in a new session; not_found is unknown and never replays', async () => {
  const f = fixture({executeState: 'result_unknown'});
  await f.adapter.observe('task-1', deadline(), new AbortController().signal);
  await assert.rejects(f.adapter.tool.execute(input, context()), {code: 'RESULT_UNKNOWN'});
  const result = await f.adapter.recover('task-1', 'run-1');
  assert.deepEqual(result, {state: 'unknown', reason: 'not_found'});
  const execute = f.sent.find(frame => frame.kind === 'execute');
  const status = f.sent.findLast(frame => frame.kind === 'status');
  assert.notEqual(status.sessionId, execute.sessionId);
  for (const key of ['taskId', 'runId', 'toolName', 'toolVersion', 'argumentsDigest', 'targetRef']) {
    assert.equal(status[key], execute[key]);
  }
  assert.equal(f.sent.filter(frame => frame.kind === 'execute').length, 1);
});
