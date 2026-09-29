import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {Client} from '@personal-agent/client';
import {
  createWorkspaceReadTool,
  WORKSPACE_READ_TOOL_NAME,
  WORKSPACE_READ_TOOL_VERSION,
} from '@personal-agent/coding-tools';
import {FakeCoordinationPort} from '@personal-agent/coordination/testing';
import {createRuntimeApplication} from '@personal-agent/runtime/application';

const content = 'export const fixture = "synthetic workspace";\n';

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'personal-agent-workspace-competition-'));
  const root = join(base, 'workspace');
  await mkdir(join(root, 'src'), {recursive: true});
  await writeFile(join(root, 'src', 'fixture.ts'), content, 'utf8');
  await writeFile(join(base, 'outside.txt'), 'outside synthetic content\n', 'utf8');
  return {base, root, database: join(base, 'runtime.sqlite')};
}

async function waitForState(app, taskId, states) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const task = app.runtime.getTask(taskId);
    if (states.includes(task.state)) return task;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Task ${taskId} did not reach ${states.join(' or ')}`);
}

async function approveOnce(client, taskId) {
  const approvals = await client.call('approval.list', {taskId, state: 'pending'});
  assert.equal(approvals.items.length, 1);
  const approval = approvals.items[0];
  assert.equal(approval.action, WORKSPACE_READ_TOOL_NAME);
  assert.equal('arguments' in approval, false);
  const request = {
    approvalId: approval.approvalId,
    expectedRevision: approval.revision,
    decision: 'allow_once',
  };
  await client.call('authorization.respond', request);
  return {approval, request};
}

test('Competition discovers, approves and reads through the real workspace provider exactly once', async t => {
  const {base, root, database} = await fixture();
  const workspace = createWorkspaceReadTool({rootPath: root, maxReadBytes: 4096});
  let executions = 0;
  const countedWorkspace = {
    descriptor: workspace.descriptor,
    execute: async (input, context) => {
      executions++;
      return workspace.execute(input, context);
    },
  };
  const port = new FakeCoordinationPort(request => {
    if (request.continuation === undefined) {
      return {
        kind: 'tool_proposal',
        proposalId: 'workspace-read-proposal',
        toolName: WORKSPACE_READ_TOOL_NAME,
        toolVersion: WORKSPACE_READ_TOOL_VERSION,
        arguments: {path: 'src/fixture.ts', maxBytes: 1024},
        verification: 'mock',
      };
    }
    assert.deepEqual(request.continuation, {
      proposalId: 'workspace-read-proposal',
      state: 'confirmed',
      result: {
        path: 'src/fixture.ts',
        encoding: 'utf-8',
        byteLength: Buffer.byteLength(content),
        content,
      },
    });
    return {kind: 'text', text: '合成源码已通过本地只读工具读取', verification: 'mock'};
  });
  const app = createRuntimeApplication({
    path: database,
    profile: 'huawei_ict_agentarts',
    coordination: port,
    tools: [countedWorkspace],
  });
  t.after(async () => {
    app.close();
    await rm(base, {recursive: true, force: true});
  });
  const client = new Client(app, Date.now);
  await client.connect();

  const capabilities = await client.call('capability.list', {kind: 'tool'});
  assert.deepEqual(capabilities, {
    manifests: [workspace.descriptor],
    health: [{id: WORKSPACE_READ_TOOL_NAME, state: 'ready'}],
  });
  const {taskId} = await client.call('task.submit', {
    goal: '读取合成工作区中的 src/fixture.ts',
    conversationId: 'workspace-competition-synthetic',
  }, {idempotencyKey: 'workspace-competition-success'});
  assert.equal((await waitForState(app, taskId, ['waiting_approval', 'failed'])).state, 'waiting_approval');
  assert.equal(executions, 0);
  assert.equal(port.requests.length, 1);

  const {approval, request: approvalRequest} = await approveOnce(client, taskId);
  const completed = await waitForState(app, taskId, ['succeeded', 'failed']);
  assert.equal(completed.state, 'succeeded');
  assert.match(completed.resultSummary, /合成源码已通过本地只读工具读取/);
  assert.equal(executions, 1);
  assert.equal(port.requests.length, 2);
  assert.deepEqual(completed.evidenceRefs, [approval.approvalId]);

  const executionsMetadata = app.runtime.readToolExecutions(taskId);
  assert.equal(executionsMetadata.length, 1);
  const [execution] = executionsMetadata;
  assert.equal(execution.evidenceId, approval.approvalId);
  assert.equal(execution.taskId, taskId);
  assert.equal(execution.toolName, WORKSPACE_READ_TOOL_NAME);
  assert.equal(execution.toolVersion, WORKSPACE_READ_TOOL_VERSION);
  assert.equal(execution.policyDecision, 'allow');
  assert.equal(execution.executionStarted, true);
  assert.equal(execution.state, 'confirmed');
  assert.match(execution.inputDigest, /^[0-9a-f]{64}$/u);
  assert.equal('errorCode' in execution, false);
  assert.deepEqual(app.runtime.readEvidence(taskId), [{
    evidenceId: approval.approvalId,
    kind: 'execution',
    sourceRef: WORKSPACE_READ_TOOL_NAME,
    capturedAt: execution.finishedAt,
    summary: 'Tool execution confirmed; policy=allow',
    verification: 'conditional',
    sensitivity: 'internal',
  }]);

  const replay = await client.call('authorization.respond', approvalRequest);
  assert.deepEqual(replay, {accepted: true, approvalState: 'allowed'});
  assert.equal(executions, 1, 'idempotent approval replay must not read the file again');
  assert.equal(app.runtime.readToolExecutions(taskId).length, 1);
  assert.equal(port.requests.length, 2);
});

test('an invalid parent path produces no read result or Competition continuation', async t => {
  const {base, root, database} = await fixture();
  const workspace = createWorkspaceReadTool({rootPath: root});
  let executions = 0;
  const port = new FakeCoordinationPort(() => ({
    kind: 'tool_proposal',
    proposalId: 'workspace-escape-proposal',
    toolName: WORKSPACE_READ_TOOL_NAME,
    toolVersion: WORKSPACE_READ_TOOL_VERSION,
    arguments: {path: '../outside.txt'},
    verification: 'mock',
  }));
  const app = createRuntimeApplication({
    path: database,
    profile: 'huawei_ict_agentarts',
    coordination: port,
    tools: [{
      descriptor: workspace.descriptor,
      execute: async (input, context) => {
        executions++;
        return workspace.execute(input, context);
      },
    }],
  });
  t.after(async () => {
    app.close();
    await rm(base, {recursive: true, force: true});
  });
  const client = new Client(app, Date.now);
  await client.connect();
  const {taskId} = await client.call('task.submit', {
    goal: '尝试读取合成根目录外文件',
    conversationId: 'workspace-competition-synthetic',
  }, {idempotencyKey: 'workspace-competition-invalid-path'});
  assert.equal((await waitForState(app, taskId, ['waiting_approval', 'failed'])).state, 'waiting_approval');
  const {approval} = await approveOnce(client, taskId);
  const failed = await waitForState(app, taskId, ['failed']);
  assert.equal(failed.error.code, 'INVALID_ARGUMENT');
  assert.equal(executions, 1, 'the registered provider validates the path before filesystem access');
  assert.equal(port.requests.length, 1, 'a rejected read must not be returned to coordination');
  assert.equal(app.runtime.loadCheckpoint(taskId, `tool-result-${approval.approvalId}`), undefined);
  const [execution] = app.runtime.readToolExecutions(taskId);
  assert.equal(execution.state, 'failed');
  assert.equal(execution.errorCode, 'INVALID_ARGUMENT');
  assert.equal(execution.policyDecision, 'allow');
  assert.equal(execution.executionStarted, true);
});

test('Competition without a trusted tool registration stays unsupported', async t => {
  const {base, database} = await fixture();
  const port = new FakeCoordinationPort(() => ({
    kind: 'tool_proposal',
    proposalId: 'workspace-unregistered-proposal',
    toolName: WORKSPACE_READ_TOOL_NAME,
    toolVersion: WORKSPACE_READ_TOOL_VERSION,
    arguments: {path: 'src/fixture.ts'},
    verification: 'mock',
  }));
  const app = createRuntimeApplication({
    path: database,
    profile: 'huawei_ict_agentarts',
    coordination: port,
  });
  t.after(async () => {
    app.close();
    await rm(base, {recursive: true, force: true});
  });
  const client = new Client(app, Date.now);
  await client.connect();
  await assert.rejects(client.call('capability.list', {kind: 'tool'}), {code: 'UNSUPPORTED_CAPABILITY'});
  const {taskId} = await client.call('task.submit', {
    goal: '读取未注册工作区',
    conversationId: 'workspace-competition-synthetic',
  }, {idempotencyKey: 'workspace-competition-unregistered'});
  const failed = await waitForState(app, taskId, ['failed']);
  assert.equal(failed.error.code, 'UNSUPPORTED_CAPABILITY');
  assert.deepEqual(failed.evidenceRefs, []);
  assert.equal(port.requests.length, 1);
});
