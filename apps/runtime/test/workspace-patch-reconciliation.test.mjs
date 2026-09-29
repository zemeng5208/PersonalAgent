import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ProtocolError} from '@personal-agent/contracts';
import {Client} from '@personal-agent/client';
import {createRuntimeApplication} from '../dist/application.js';

const descriptor = {
  name: 'workspace.apply_text_patch', version: '1.0.0',
  inputSchema: {type: 'object', required: ['path', 'expectedSha256', 'edits'], additionalProperties: false,
    properties: {path: {type: 'string', minLength: 1}, expectedSha256: {type: 'string', minLength: 64},
      edits: {type: 'array', minItems: 1}}},
  outputSchema: {type: 'object'}, sideEffect: 'local_write', requiredScopes: ['workspace:write'],
  idempotencySupport: true, recoverySupport: true, requiresPresence: false,
};

const hashes = {beforeSha256: 'a'.repeat(64), afterSha256: 'b'.repeat(64), currentSha256: 'b'.repeat(64)};
const request = (commandId = 'patch-1') => ({commandId, toolName: descriptor.name, toolVersion: descriptor.version,
  arguments: {path: 'src/app.js', expectedSha256: hashes.beforeSha256, edits: [{start: 0, end: 0, replacement: 'x'}]},
  deadline: new Date(Date.now() + 60_000).toISOString()});

async function waitFor(app, taskId, state) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const task = app.runtime.getTask(taskId);
    if (task.state === state) return task;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Task did not reach ${state}`);
}

async function waitForIdle(app) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (app.activeTaskCount === 0) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Runtime Application did not finish active task cleanup');
}

async function fixture(resultFactory) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'personal-agent-patch-reconcile-'));
  const calls = {tool: 0, reconcile: 0, paths: []};
  const app = createRuntimeApplication({path: path.join(directory, 'runtime.sqlite'),
    profile: 'huawei_ict_agentarts', hostUserNamespace: 'user-1',
    tools: [{descriptor, execute: async () => {
      calls.tool++;
      throw new ProtocolError('RESULT_UNKNOWN', 'helper outcome is unknown');
    }}],
    workspacePatchReconciliation: {reconcile: async input => {
      calls.reconcile++;
      calls.paths.push(input.relativePath);
      return resultFactory();
    }},
  });
  return {directory, app, calls};
}

async function startUnknown(f, commandId = 'patch-1') {
  const submitted = f.app.submitHostToolTask(request(commandId));
  await waitFor(f.app, submitted.task.taskId, 'waiting_approval');
  const approval = f.app.readHostToolTask(submitted.task.taskId).approval;
  const client = new Client(f.app, Date.now);
  await client.connect();
  await client.call('authorization.respond', {approvalId: approval.approvalId,
    expectedRevision: approval.revision, decision: 'allow_once'});
  await waitFor(f.app, submitted.task.taskId, 'waiting_reconciliation');
  await waitForIdle(f.app);
  return submitted.task.taskId;
}

test('workspace patch reconciliation projects applied once and preserves the original run', async () => {
  const f = await fixture(() => ({path: 'src/app.js', state: 'reconciled', outcome: 'applied', ...hashes}));
  try {
    const taskId = await startUnknown(f);
    const originalIntent = f.app.runtime.loadCheckpoint(taskId, 'host-tool-intent');
    const duplicateSubmission = f.app.submitHostToolTask({...request(), deadline: originalIntent.deadline});
    assert.equal(duplicateSubmission.task.taskId, taskId);
    await waitFor(f.app, taskId, 'succeeded');
    const first = await f.app.reconcileWorkspacePatchTask(taskId);
    assert.equal(first.result.outcome, 'applied');
    assert.equal(first.task.state, 'succeeded');
    assert.equal(f.calls.tool, 1);
    assert.deepEqual(f.calls.paths, ['src/app.js']);
    const record = f.app.runtime.readToolExecutions(taskId)[0];
    assert.equal(record.state, 'confirmed');
    assert.equal(record.reconciliationOutcome, 'applied');
    assert.match(f.app.runtime.readEvidence(taskId)[0].summary, /reconciliation=applied/);
    assert.equal(f.app.readHostToolTask(taskId).confirmed.result.outcome, 'applied');
    const second = await f.app.reconcileWorkspacePatchTask(taskId);
    assert.equal(second.result.outcome, 'applied');
    assert.equal(f.calls.reconcile, 1, 'duplicate reconciliation must not call the helper API again');
  } finally {
    await waitForIdle(f.app);
    f.app.close();
    await rm(f.directory, {recursive: true, force: true});
  }
});

test('not_applied is terminal and unknown stays in reconciliation without reopening or replaying', async () => {
  const f = await fixture(() => ({path: 'src/app.js', state: 'reconciled', outcome: 'not_applied', ...hashes}));
  try {
    const taskId = await startUnknown(f, 'patch-not-applied');
    const result = await f.app.reconcileWorkspacePatchTask(taskId);
    assert.equal(result.task.state, 'failed');
    assert.equal(f.app.runtime.readToolExecutions(taskId)[0].reconciliationOutcome, 'not_applied');
    assert.equal(f.calls.tool, 1);
    assert.equal(f.calls.reconcile, 1);
  } finally {
    await waitForIdle(f.app);
    f.app.close();
    await rm(f.directory, {recursive: true, force: true});
  }

  const unknown = await fixture(() => ({path: 'src/app.js', state: 'reconciled', outcome: 'unknown', ...hashes}));
  try {
    const taskId = await startUnknown(unknown, 'patch-unknown');
    const result = await unknown.app.reconcileWorkspacePatchTask(taskId);
    assert.equal(result.task.state, 'waiting_reconciliation');
    assert.equal(unknown.app.runtime.readToolExecutions(taskId)[0].reconciliationOutcome, 'unknown');
    assert.match(unknown.app.runtime.readEvidence(taskId)[0].summary, /reconciliation=unknown/);
    assert.equal(unknown.calls.tool, 1);
  } finally {
    await waitForIdle(unknown.app);
    unknown.app.close();
    await rm(unknown.directory, {recursive: true, force: true});
  }
});

test('running, absent marker and changed intent remain conservative', async () => {
  const running = await fixture(() => ({path: 'src/app.js', state: 'in_progress', pid: 42, ...hashes}));
  try {
    const taskId = await startUnknown(running, 'patch-running');
    const result = await running.app.reconcileWorkspacePatchTask(taskId);
    assert.equal(result.result.state, 'in_progress');
    assert.equal(result.task.state, 'waiting_reconciliation');
    assert.equal(running.app.runtime.readToolExecutions(taskId)[0].reconciliationOutcome, undefined);
  } finally {
    await waitForIdle(running.app);
    running.app.close();
    await rm(running.directory, {recursive: true, force: true});
  }

  const absent = await fixture(() => ({path: 'src/app.js', state: 'clear'}));
  try {
    const taskId = await startUnknown(absent, 'patch-absent');
    await assert.rejects(absent.app.reconcileWorkspacePatchTask(taskId), {code: 'REVISION_CONFLICT'});
    assert.equal(absent.app.runtime.getTask(taskId).state, 'waiting_reconciliation');
  } finally {
    await waitForIdle(absent.app);
    absent.app.close();
    await rm(absent.directory, {recursive: true, force: true});
  }

  const changed = await fixture(() => ({path: 'src/app.js', state: 'reconciled', outcome: 'applied', ...hashes}));
  try {
    const taskId = await startUnknown(changed, 'patch-changed');
    const intent = changed.app.runtime.loadCheckpoint(taskId, 'host-tool-intent');
    changed.app.runtime.saveCheckpoint(taskId, 'host-tool-intent', {...intent, arguments: {...intent.arguments, path: 'src/other.js'}});
    await assert.rejects(changed.app.reconcileWorkspacePatchTask(taskId), {code: 'REVISION_CONFLICT'});
    assert.equal(changed.calls.reconcile, 0);
    assert.equal(changed.app.runtime.getTask(taskId).state, 'waiting_reconciliation');
  } finally {
    await waitForIdle(changed.app);
    changed.app.close();
    await rm(changed.directory, {recursive: true, force: true});
  }
});
