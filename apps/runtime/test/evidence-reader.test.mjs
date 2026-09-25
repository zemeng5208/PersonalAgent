import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {ToolGateway} from '@personal-agent/tool-gateway';
import {TaskRuntime} from '../dist/index.js';
import {ScopedEvidenceReader} from '../dist/application/evidence-reader.js';

const root = fileURLToPath(new URL('../../../.cache/evidence-reader-tests/', import.meta.url));
mkdirSync(root, {recursive: true});
const database = () => join(mkdtempSync(join(root, 'case-')), 'runtime.sqlite');
const descriptor = {
  name: 'private.tool.secret-key', version: '1', inputSchema: {type: 'object'},
  outputSchema: {type: 'object'}, sideEffect: 'read', requiredScopes: ['private:read'],
  idempotencySupport: true, recoverySupport: true, requiresPresence: false
};

function deniedEvidence(runtime, conversationId, idempotencyKey, approvalId) {
  const task = runtime.submitTask({goal: 'private goal', conversationId, idempotencyKey});
  runtime.transitionTask(task.taskId, 'planning');
  runtime.transitionTask(task.taskId, 'running');
  runtime.requestToolApproval(approvalId, task.taskId, descriptor, new Date(Date.now() + 60_000).toISOString(), 'private-input-digest');
  runtime.respondApproval(approvalId, 'deny', 1);
  return task.taskId;
}

test('fixed host scope, authorization and pagination survive restart without private content', async () => {
  const path = database();
  let runtime = new TaskRuntime(path);
  const taskId = deniedEvidence(runtime, 'conversation-a', 'task-a', 'approval-a');
  deniedEvidence(runtime, 'conversation-b', 'task-b', 'approval-b');
  const scope = {subjectRef: 'user-a', conversationId: 'conversation-a', taskId};
  let permitted = true;
  let checks = 0;
  const reader = new ScopedEvidenceReader({runtime, ...scope, authorize: current => {
    checks++;
    assert.deepEqual(current, scope);
    return permitted;
  }});

  const first = await reader.list({limit: 1});
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].evidenceId, 'approval-a-decision');
  assert.equal(first.items[0].verification, 'conditional');
  assert.deepEqual(await reader.get('approval-a-decision'), first.items[0]);
  assert.doesNotMatch(JSON.stringify(first), /private\.tool|secret-key|private-input-digest|private goal/);
  await assert.rejects(reader.get('approval-b-decision'), {code: 'NOT_FOUND'});
  await assert.rejects(reader.list({limit: 51}), {code: 'INVALID_ARGUMENT'});
  await assert.rejects(reader.list({beforeEvidenceId: 'approval-b-decision'}), {code: 'NOT_FOUND'});
  assert.equal(checks, 4);

  permitted = false;
  await assert.rejects(reader.list(), {code: 'UNAUTHORIZED'});
  runtime.close();
  runtime = new TaskRuntime(path);
  const reopened = new ScopedEvidenceReader({runtime, ...scope, authorize: () => true});
  assert.deepEqual((await reopened.list()).items, first.items);
  const wrongConversation = new ScopedEvidenceReader({runtime, ...scope, conversationId: 'conversation-b', authorize: () => true});
  await assert.rejects(wrongConversation.list(), {code: 'UNAUTHORIZED'});
  const wrongSubject = new ScopedEvidenceReader({runtime, ...scope, subjectRef: 'user-b', authorize: () => false});
  await assert.rejects(wrongSubject.get('approval-a-decision'), {code: 'UNAUTHORIZED'});
  runtime.close();
});

test('confirmed tool results stay private while metadata pages remain stable', async () => {
  const path = database();
  const runtime = new TaskRuntime(path, {createToolGateway: policy => {
    const gateway = new ToolGateway({policy});
    gateway.register({descriptor: {...descriptor, name: 'test.read'}, execute: async () => ({credential: 'Bearer secret-key'})});
    return gateway;
  }});
  const task = runtime.submitTask({goal: 'private goal', conversationId: 'conversation-a', idempotencyKey: 'list-test'});
  runtime.transitionTask(task.taskId, 'planning');
  runtime.transitionTask(task.taskId, 'running');
  runtime.policy.grant({authorizationRef: 'read-grant', taskId: task.taskId, toolName: 'test.read', scopes: descriptor.requiredScopes,
    expiresAt: new Date(Date.now() + 60_000).toISOString(), maxUses: 2});
  for (const runId of ['run-1', 'run-2']) {
    const response = await runtime.send({kind: 'request', protocolVersion: '1.0.0', requestId: `request-${runId}`,
      taskId: task.taskId, idempotencyKey: runId, deadline: new Date(Date.now() + 60_000).toISOString(),
      operation: 'tool.invoke', payload: {toolName: 'test.read', toolVersion: '1', arguments: {}, scopeRef: 'read-grant'}},
    new AbortController().signal);
    assert.equal(response.outcome, 'ok');
  }
  const reader = new ScopedEvidenceReader({runtime, subjectRef: 'user-a', conversationId: 'conversation-a', taskId: task.taskId,
    authorize: () => true});
  const first = await reader.list({limit: 1});
  assert.equal(first.items[0].evidenceId, 'run-2');
  assert.equal(first.nextBeforeEvidenceId, 'run-2');
  const second = await reader.list({limit: 1, beforeEvidenceId: first.nextBeforeEvidenceId});
  assert.equal(second.items[0].evidenceId, 'run-1');
  assert.equal(second.nextBeforeEvidenceId, undefined);
  assert.doesNotMatch(JSON.stringify([first, second, await reader.get('run-1')]), /Bearer|secret-key|credential|private goal/);
  runtime.close();
});
