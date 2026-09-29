import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {Client} from '@personal-agent/client';
import {createRuntimeApplication} from '../dist/application.js';

const descriptor = {
  name: 'fixture.goal_create', version: '1.0.0',
  inputSchema: {type: 'object', required: ['title'], additionalProperties: false,
    properties: {title: {type: 'string', minLength: 1}}},
  outputSchema: {type: 'object', required: ['revision'], additionalProperties: false,
    properties: {revision: {type: 'integer', minimum: 1}}},
  sideEffect: 'local_write', requiredScopes: ['goal:write'], idempotencySupport: true,
  recoverySupport: true, requiresPresence: false,
};

const request = (commandId = 'create-1', title = 'Prepare demo') => ({
  commandId, toolName: descriptor.name, toolVersion: descriptor.version,
  arguments: {title}, deadline: new Date(Date.now() + 60_000).toISOString(),
});

async function waitFor(application, taskId, state) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const task = application.runtime.getTask(taskId);
    if (task.state === state) return task;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Task did not reach ${state}`);
}

async function waitForIdle(application) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (application.activeTaskCount === 0) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Runtime Application did not finish active task cleanup');
}

test('trusted host prepares task ID before target observation and freezes arguments at revision', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'personal-agent-host-prepare-'));
  const targetDescriptor = {...descriptor, name: 'fixture.notepad_target',
    inputSchema: {type: 'object', required: ['targetRef', 'title'], additionalProperties: false,
      properties: {targetRef: {type: 'string', minLength: 16}, title: {type: 'string', minLength: 1}}}};
  let executions = 0;
  const app = createRuntimeApplication({path: path.join(directory, 'runtime.sqlite'),
    profile: 'huawei_ict_agentarts', hostUserNamespace: 'user-1',
    tools: [{descriptor: targetDescriptor, execute: async () => { executions++; return {revision: 2}; }}]});
  try {
    const preparation = {commandId: 'notepad-1', toolName: targetDescriptor.name,
      toolVersion: targetDescriptor.version, deadline: new Date(Date.now() + 60_000).toISOString()};
    const prepared = app.prepareHostToolTask(preparation);
    assert.equal(prepared.state, 'created');
    assert.equal(app.prepareHostToolTask(preparation).taskId, prepared.taskId);
    assert.throws(() => app.prepareHostToolTask({...preparation,
      deadline: new Date(Date.now() + 90_000).toISOString()}), {code: 'REVISION_CONFLICT'});
    assert.deepEqual(app.runtime.readToolExecutions(prepared.taskId), []);
    assert.equal(executions, 0);
    const arguments_ = {targetRef: 'observed_target_123456', title: 'New text'};
    assert.throws(() => app.submitHostToolTask({...preparation, arguments: arguments_}),
      {code: 'REVISION_CONFLICT'});
    assert.throws(() => app.finalizeHostToolTask({taskId: prepared.taskId,
      commandId: preparation.commandId, expectedTaskRevision: prepared.revision + 1,
      arguments: arguments_}), {code: 'REVISION_CONFLICT'});
    assert.equal(app.runtime.getTask(prepared.taskId).state, 'created');
    app.finalizeHostToolTask({taskId: prepared.taskId, commandId: preparation.commandId,
      expectedTaskRevision: prepared.revision, arguments: arguments_});
    await waitFor(app, prepared.taskId, 'waiting_approval');
    assert.equal(executions, 0);
    assert.throws(() => app.cancelPreparedHostToolTask(prepared.taskId,
      preparation.commandId, prepared.revision), {code: 'REVISION_CONFLICT'});
    assert.throws(() => app.finalizeHostToolTask({taskId: prepared.taskId,
      commandId: preparation.commandId, expectedTaskRevision: prepared.revision,
      arguments: {...arguments_, targetRef: 'other_target_1234567'}}), {code: 'REVISION_CONFLICT'});
    const approval = app.readHostToolTask(prepared.taskId).approval;
    const client = new Client(app, Date.now);
    await client.connect();
    await client.call('authorization.respond', {approvalId: approval.approvalId,
      expectedRevision: approval.revision, decision: 'allow_once'});
    await waitFor(app, prepared.taskId, 'succeeded');
    assert.equal(executions, 1);
    assert.equal(app.runtime.readEvidence(prepared.taskId)[0].verification, 'conditional');
    assert.deepEqual(app.readHostToolTask(prepared.taskId).confirmed.result, {revision: 2});
  } finally {
    await waitForIdle(app);
    app.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('cancelled prepared host task cannot freeze arguments or execute', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'personal-agent-host-prepare-'));
  let executions = 0;
  const app = createRuntimeApplication({path: path.join(directory, 'runtime.sqlite'),
    profile: 'huawei_ict_agentarts', hostUserNamespace: 'user-1',
    tools: [{descriptor, execute: async () => { executions++; return {revision: 2}; }}]});
  try {
    const preparation = {commandId: 'notepad-cancel', toolName: descriptor.name,
      toolVersion: descriptor.version, deadline: new Date(Date.now() + 60_000).toISOString()};
    const prepared = app.prepareHostToolTask(preparation);
    const cancelled = app.cancelPreparedHostToolTask(prepared.taskId,
      preparation.commandId, prepared.revision);
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(app.cancelPreparedHostToolTask(prepared.taskId,
      preparation.commandId, prepared.revision).state, 'cancelled');
    assert.throws(() => app.finalizeHostToolTask({taskId: prepared.taskId,
      commandId: preparation.commandId, expectedTaskRevision: prepared.revision,
      arguments: {title: 'never write'}}), {code: 'REVISION_CONFLICT'});
    assert.equal(executions, 0);
    assert.deepEqual(app.runtime.readToolExecutions(prepared.taskId), []);
  } finally {
    app.close();
    await rm(directory, {recursive: true, force: true});
  }
});
test('trusted host tool task persists approval and resumes once after restart', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'personal-agent-host-tool-'));
  const databasePath = path.join(directory, 'runtime.sqlite');
  let writes = 0;
  const tool = {descriptor, execute: async () => { writes++; return {revision: 2}; }};
  const input = request();
  let app = createRuntimeApplication({path: databasePath, profile: 'huawei_ict_agentarts',
    hostUserNamespace: 'user-1', tools: [tool]});
  let taskId;
  try {
    const first = app.submitHostToolTask(input);
    taskId = first.task.taskId;
    await waitFor(app, taskId, 'waiting_approval');
    const pending = app.readHostToolTask(taskId);
    assert.deepEqual([pending.commandId, pending.toolName, pending.toolVersion],
      [input.commandId, descriptor.name, descriptor.version]);
    assert.equal(pending.approval.state, 'pending');
    assert.equal(writes, 0);
    assert.throws(() => app.submitHostToolTask({...input, arguments: {title: 'Changed'}}),
      {code: 'REVISION_CONFLICT'});
    await waitForIdle(app);
    app.close();

    app = createRuntimeApplication({path: databasePath, profile: 'huawei_ict_agentarts',
      hostUserNamespace: 'user-1', tools: [tool]});
    const duplicate = app.submitHostToolTask(input);
    assert.equal(duplicate.task.taskId, taskId);
    assert.deepEqual([duplicate.commandId, duplicate.toolName, duplicate.toolVersion],
      [input.commandId, descriptor.name, descriptor.version]);
    const client = new Client(app, Date.now);
    await client.connect();
    await assert.rejects(client.call('authorization.respond', {approvalId: pending.approval.approvalId,
      expectedRevision: 0, decision: 'allow_once'}), {code: 'REVISION_CONFLICT'});
    assert.equal(writes, 0);
    await client.call('authorization.respond', {approvalId: pending.approval.approvalId,
      expectedRevision: 1, decision: 'allow_once'});
    await waitFor(app, taskId, 'succeeded');
    const readback = app.readHostToolTask(taskId);
    assert.deepEqual(readback.confirmed.result, {revision: 2});
    assert.deepEqual(readback.confirmed.evidenceRefs, [`host-tool-${taskId}`]);
    assert.equal(writes, 1);
    assert.equal(app.submitHostToolTask(input).task.taskId, taskId);
    assert.equal(writes, 1);
  } finally {
    await waitForIdle(app);
    app.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('denied or unknown writes never replay, and other host namespaces cannot read', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'personal-agent-host-tool-'));
  const databasePath = path.join(directory, 'runtime.sqlite');
  let writes = 0;
  const tool = {descriptor, execute: async () => { writes++; throw new Error('write outcome uncertain'); }};
  let app = createRuntimeApplication({path: databasePath, profile: 'huawei_ict_agentarts',
    hostUserNamespace: 'user-1', tools: [tool]});
  try {
    const client = new Client(app, Date.now);
    await client.connect();
    const denied = app.submitHostToolTask(request('denied'));
    await waitFor(app, denied.task.taskId, 'waiting_approval');
    const denial = app.readHostToolTask(denied.task.taskId).approval;
    await client.call('authorization.respond', {approvalId: denial.approvalId,
      expectedRevision: denial.revision, decision: 'deny'});
    assert.equal(app.runtime.getTask(denied.task.taskId).state, 'cancelled');
    assert.equal(writes, 0);

    const cancelled = app.submitHostToolTask(request('cancelled'));
    await waitFor(app, cancelled.task.taskId, 'waiting_approval');
    const stale = app.readHostToolTask(cancelled.task.taskId).approval;
    const cancellation = await client.call('task.cancel', {taskId: cancelled.task.taskId});
    assert.equal(cancellation.cancelAccepted, true);
    await waitFor(app, cancelled.task.taskId, 'cancelled');
    await assert.rejects(client.call('authorization.respond', {approvalId: stale.approvalId,
      expectedRevision: stale.revision, decision: 'allow_once'}), {code: 'REVISION_CONFLICT'});
    assert.equal(writes, 0);

    const unknownInput = request('unknown');
    const submitted = app.submitHostToolTask(unknownInput);
    await waitFor(app, submitted.task.taskId, 'waiting_approval');
    const approval = app.readHostToolTask(submitted.task.taskId).approval;
    await client.call('authorization.respond', {approvalId: approval.approvalId,
      expectedRevision: approval.revision, decision: 'allow_once'});
    await waitFor(app, submitted.task.taskId, 'waiting_reconciliation');
    assert.equal(writes, 1);
    await waitForIdle(app);
    app.close();
    app = createRuntimeApplication({path: databasePath, profile: 'huawei_ict_agentarts',
      hostUserNamespace: 'user-1', tools: [tool]});
    assert.equal(app.submitHostToolTask(unknownInput).task.state, 'waiting_reconciliation');
    assert.equal(writes, 1);
    app.close();
    app = createRuntimeApplication({path: databasePath, profile: 'huawei_ict_agentarts',
      hostUserNamespace: 'user-2', tools: [tool]});
    assert.throws(() => app.readHostToolTask(submitted.task.taskId), {code: 'NOT_FOUND'});
  } finally {
    await waitForIdle(app);
    app.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('approval persisted before dispatch resumes after restart without a second grant', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'personal-agent-host-tool-'));
  const databasePath = path.join(directory, 'runtime.sqlite');
  let writes = 0;
  const tool = {descriptor, execute: async () => { writes++; return {revision: 3}; }};
  const input = request('crash-gap');
  let app = createRuntimeApplication({path: databasePath, profile: 'huawei_ict_agentarts',
    hostUserNamespace: 'user-1', tools: [tool]});
  try {
    const submitted = app.submitHostToolTask(input);
    await waitFor(app, submitted.task.taskId, 'waiting_approval');
    await waitForIdle(app);
    const approval = app.readHostToolTask(submitted.task.taskId).approval;
    // Simulate the process stopping after the durable approval transaction and
    // before RuntimeApplication.send can dispatch the resumed worker.
    app.runtime.respondApproval(approval.approvalId, 'allow_once', approval.revision);
    app.close();
    app = createRuntimeApplication({path: databasePath, profile: 'huawei_ict_agentarts',
      hostUserNamespace: 'user-1', tools: [tool]});
    assert.equal(app.readHostToolTask(submitted.task.taskId).approval.state, 'allowed');
    app.resumeHostToolTask(submitted.task.taskId);
    await waitFor(app, submitted.task.taskId, 'succeeded');
    assert.equal(writes, 1);
    assert.deepEqual(app.readHostToolTask(submitted.task.taskId).confirmed.result, {revision: 3});
  } finally {
    await waitForIdle(app);
    app.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('distinct namespace and command ID pairs cannot share an idempotency key', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'personal-agent-host-tool-'));
  const databasePath = path.join(directory, 'runtime.sqlite');
  const tool = {descriptor, execute: async () => ({revision: 1})};
  let app = createRuntimeApplication({path: databasePath, profile: 'huawei_ict_agentarts',
    hostUserNamespace: 'a:b', tools: [tool]});
  try {
    const first = app.submitHostToolTask(request('c'));
    await waitFor(app, first.task.taskId, 'waiting_approval');
    await waitForIdle(app);
    app.close();
    app = createRuntimeApplication({path: databasePath, profile: 'huawei_ict_agentarts',
      hostUserNamespace: 'a', tools: [tool]});
    const second = app.submitHostToolTask(request('b:c'));
    await waitFor(app, second.task.taskId, 'waiting_approval');
    assert.notEqual(second.task.taskId, first.task.taskId);
    assert.throws(() => app.readHostToolTask(first.task.taskId), {code: 'NOT_FOUND'});
  } finally {
    await waitForIdle(app);
    app.close();
    await rm(directory, {recursive: true, force: true});
  }
});
test('host task rejects numbers that JSON persistence would silently change', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'personal-agent-host-tool-'));
  const nullable = {...descriptor, name: 'fixture.nullable', inputSchema: {type: 'object',
    required: ['value'], additionalProperties: false,
    properties: {value: {type: ['number', 'null']}}}};
  const app = createRuntimeApplication({path: path.join(directory, 'runtime.sqlite'),
    profile: 'huawei_ict_agentarts', hostUserNamespace: 'user-1',
    tools: [{descriptor: nullable, execute: async () => ({revision: 1})}]});
  try {
    assert.throws(() => app.submitHostToolTask({commandId: 'lossy', toolName: nullable.name,
      toolVersion: nullable.version, arguments: {value: Number.NaN},
      deadline: new Date(Date.now() + 60_000).toISOString()}), {code: 'INVALID_ARGUMENT'});
    assert.equal(app.runtime.listTasks({conversationId: 'host-tool:user-1'}).items.length, 0);
  } finally {
    app.close();
    await rm(directory, {recursive: true, force: true});
  }
});
