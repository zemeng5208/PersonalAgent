import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import {Client} from '@personal-agent/client';
import {toolArgumentsDigest} from '@personal-agent/tool-gateway';
import {createRuntimeApplication} from '../dist/application.js';

const descriptor = {name: 'mail.inbox', version: '0.1.0-alpha.1', sideEffect: 'read',
  requiredScopes: ['mail:read'], requiresPresence: false, idempotencySupport: true, recoverySupport: true,
  inputSchema: {type: 'object', additionalProperties: false, required: ['account', 'folder', 'limit'],
    properties: {account: {type: 'string'}, folder: {enum: ['INBOX']}, limit: {type: 'integer'}, cursor: {type: 'string'}}},
  outputSchema: {type: 'object', additionalProperties: true}};
async function idle(app) {
  for (let i = 0; i < 200; i++) {if (!app.activeTaskCount) return; await new Promise(resolve => setTimeout(resolve, 5));}
  assert.fail('Runtime did not become idle');
}
test('one inbox consent reads confirmed pages with Policy/Evidence and blocks expired/restarted grants', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pa-mail-lease-'));
  let time = Date.now(), calls = 0;
  const seen = [];
  const options = {path: path.join(directory, 'runtime.sqlite'), profile: 'huawei_ict_agentarts',
    hostUserNamespace: 'fixture-mail-user', now: () => new Date(time), tools: [{descriptor,
      execute: async (input, context) => {
        calls++; seen.push(input); assert.deepEqual(context.scopes, ['mail:read']);
        return {account: 'fixture', folder: 'INBOX', items: [], nextCursor: input.cursor ? '1:200' : '1:100', hasMore: !input.cursor};
      }}]};
  let app = createRuntimeApplication(options);
  const consent = () => ({accountRef: 'fixture', folder: 'INBOX', expiresAt: new Date(time + 60000).toISOString()});
  try {
    assert.throws(() => app.startMailReadSession({...consent(), folder: 'Sent'}), {code: 'INVALID_ARGUMENT'});
    assert.throws(() => app.startMailReadSession({...consent(), cursor: 'invalid'}), {code: 'INVALID_ARGUMENT'});
    const session = app.startMailReadSession(consent());
    const first = app.nextMailReadSession(session.sessionId);
    assert.equal(first.state, 'submitted'); await idle(app);
    const firstRead = app.readHostToolTask(first.page.task.taskId);
    assert.equal(firstRead.task.state, 'succeeded'); assert.equal(firstRead.approval, undefined);
    assert.equal(app.runtime.readToolExecutions(firstRead.task.taskId)[0].policyDecision, 'allow');
    assert.equal(app.runtime.policy.get(firstRead.confirmed.runId).usesRemaining, 0);
    const second = app.nextMailReadSession(session.sessionId); await idle(app);
    assert.equal(second.state, 'submitted');
    assert.deepEqual(seen, [{account: 'fixture', folder: 'INBOX', limit: 100},
      {account: 'fixture', folder: 'INBOX', limit: 100, cursor: '1:100'}]);
    assert.equal(app.nextMailReadSession(session.sessionId).state, 'done');
    app.stopMailReadSession(session.sessionId);
    const resumed = app.startMailReadSession({...consent(), cursor: '1:200'});
    app.nextMailReadSession(resumed.sessionId); await idle(app);
    assert.deepEqual(seen.at(-1), {account:'fixture', folder:'INBOX', limit:100, cursor:'1:200'});
    app.stopMailReadSession(resumed.sessionId);
    const expired = app.startMailReadSession(consent()); time += 60000;
    assert.throws(() => app.nextMailReadSession(expired.sessionId), {code: 'TIMEOUT'});
    time = Date.now();
    const persisted = app.startMailReadSession(consent());
    const task = app.runtime.submitTaskWithCheckpoint({goal: 'interrupted inbox', conversationId: 'fixture', idempotencyKey: 'interrupted-mail'},
      'mail-read-session', persisted.sessionId);
    const ref = `host-tool-${task.taskId}`, args = {account: 'fixture', folder: 'INBOX', limit: 100};
    app.runtime.policy.grant({authorizationRef: ref, taskId: task.taskId, toolName: descriptor.name,
      scopes: ['mail:read'], expiresAt: consent().expiresAt, maxUses: 1, argumentsDigest: toolArgumentsDigest(args)});
    app.runtime.transitionTask(task.taskId, 'planning'); app.runtime.transitionTask(task.taskId, 'running');
    app.close(); app = createRuntimeApplication(options);
    const client = new Client(app); await client.connect();
    await assert.rejects(client.call('tool.invoke', {toolName: descriptor.name, toolVersion: descriptor.version,
      arguments: args, scopeRef: ref}, {taskId: task.taskId, idempotencyKey: ref}), {code: 'UNAUTHORIZED'});
    assert.equal(calls, 3);
  } finally {await idle(app); app.close(); await rm(directory, {recursive: true, force: true});}
});

test('revoking inbox consent aborts an inflight read and removes its grant', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pa-mail-cancel-'));
  let signal;
  const app = createRuntimeApplication({path: path.join(directory, 'runtime.sqlite'),
    profile: 'huawei_ict_agentarts', hostUserNamespace: 'fixture-mail-user', tools: [{descriptor,
      execute: async (_args, context) => {
        signal = context.signal;
        return new Promise((_resolve, reject) => context.signal.addEventListener('abort', () => reject(Error('cancelled')), {once: true}));
      }}]});
  try {
    const session = app.startMailReadSession({accountRef: 'fixture', folder: 'INBOX', expiresAt: new Date(Date.now() + 60000).toISOString()});
    const page = app.nextMailReadSession(session.sessionId);
    for (let i = 0; i < 100 && !signal; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(signal); app.stopMailReadSession(session.sessionId); await idle(app);
    assert.equal(signal.aborted, true);
    assert.equal(app.runtime.policy.get(`host-tool-${page.page.task.taskId}`), undefined);
    assert.throws(() => app.nextMailReadSession(session.sessionId), {code: 'UNAUTHORIZED'});
  } finally {await idle(app); app.close(); await rm(directory, {recursive: true, force: true});}
});
