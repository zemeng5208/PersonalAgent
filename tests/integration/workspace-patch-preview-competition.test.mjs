import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {Client} from '@personal-agent/client';
import {
  createWorkspacePatchPreviewTool,
  WORKSPACE_PATCH_PREVIEW_TOOL_NAME,
  WORKSPACE_PATCH_PREVIEW_TOOL_VERSION,
} from '@personal-agent/coding-tools';
import {FakeCoordinationPort} from '@personal-agent/coordination/testing';
import {createRuntimeApplication} from '@personal-agent/runtime/application';
import {toolArgumentsDigest} from '@personal-agent/tool-gateway';

const originalText = 'export const greeting = "hello";\n';
const previewText = 'export const greeting = "你好";\n';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function directorySnapshot(root) {
  return {
    root: (await readdir(root)).sort(),
    source: (await readdir(join(root, 'src'))).sort(),
  };
}

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'personal-agent-patch-competition-'));
  const root = join(base, 'workspace');
  const file = join(root, 'src', 'fixture.ts');
  await mkdir(join(root, 'src'), {recursive: true});
  await writeFile(file, originalText, 'utf8');
  return {base, root, file, database: join(base, 'runtime.sqlite')};
}

async function waitForState(app, taskId, states) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const task = app.runtime.getTask(taskId);
    if (states.includes(task.state)) return task;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Task ${taskId} did not reach ${states.join(' or ')}`);
}

test('Competition approves one real local patch preview without changing the synthetic workspace', async t => {
  const {base, root, file, database} = await fixture();
  const originalBytes = await readFile(file);
  const originalDirectory = await directorySnapshot(root);
  const expectedBeforeSha256 = sha256(originalBytes);
  const expectedAfterSha256 = sha256(Buffer.from(previewText, 'utf8'));
  const proposalArguments = {
    path: 'src/fixture.ts',
    expectedSha256: expectedBeforeSha256,
    edits: [{oldText: '"hello"', newText: '"你好"'}],
  };
  const preview = createWorkspacePatchPreviewTool({
    rootPath: root,
    maxReadBytes: 4096,
    maxPreviewBytes: 4096,
  });
  let executions = 0;
  const countedPreview = {
    descriptor: preview.descriptor,
    execute: async (input, context) => {
      executions++;
      return preview.execute(input, context);
    },
  };
  const port = new FakeCoordinationPort(request => {
    if (request.continuation === undefined) {
      return {
        kind: 'tool_proposal',
        proposalId: 'workspace-patch-preview-proposal',
        toolName: WORKSPACE_PATCH_PREVIEW_TOOL_NAME,
        toolVersion: WORKSPACE_PATCH_PREVIEW_TOOL_VERSION,
        arguments: proposalArguments,
        verification: 'mock',
      };
    }
    assert.deepEqual(request.continuation, {
      proposalId: 'workspace-patch-preview-proposal',
      state: 'confirmed',
      result: {
        path: 'src/fixture.ts',
        beforeSha256: expectedBeforeSha256,
        afterSha256: expectedAfterSha256,
        changed: true,
        previewText,
      },
    });
    return {kind: 'text', text: '合成补丁预览已由本地可信工具确认', verification: 'mock'};
  });
  const app = createRuntimeApplication({
    path: database,
    profile: 'huawei_ict_agentarts',
    coordination: port,
    tools: [countedPreview],
  });
  t.after(async () => {
    app.close();
    await rm(base, {recursive: true, force: true});
  });
  const client = new Client(app, Date.now);
  await client.connect();

  const capabilities = await client.call('capability.list', {kind: 'tool'});
  assert.deepEqual(capabilities, {
    manifests: [preview.descriptor],
    health: [{id: WORKSPACE_PATCH_PREVIEW_TOOL_NAME, state: 'ready'}],
  });
  const {taskId} = await client.call('task.submit', {
    goal: '预览合成工作区中的文本替换，但不要写入文件',
    conversationId: 'workspace-patch-competition-synthetic',
  }, {idempotencyKey: 'workspace-patch-competition-success'});
  assert.equal((await waitForState(app, taskId, ['waiting_approval', 'failed'])).state, 'waiting_approval');
  assert.equal(executions, 0);
  assert.equal(port.requests.length, 1);
  assert.deepEqual(await readFile(file), originalBytes);
  assert.deepEqual(await directorySnapshot(root), originalDirectory);

  const approvals = await client.call('approval.list', {taskId, state: 'pending'});
  assert.equal(approvals.items.length, 1);
  const approval = approvals.items[0];
  assert.equal(approval.action, WORKSPACE_PATCH_PREVIEW_TOOL_NAME);
  assert.equal('arguments' in approval, false);
  assert.equal(approval.argumentsDigest, toolArgumentsDigest(proposalArguments));
  const approvalRequest = {
    approvalId: approval.approvalId,
    expectedRevision: approval.revision,
    decision: 'allow_once',
  };
  await client.call('authorization.respond', approvalRequest);

  const completed = await waitForState(app, taskId, ['succeeded', 'failed']);
  assert.equal(completed.state, 'succeeded');
  assert.match(completed.resultSummary, /合成补丁预览已由本地可信工具确认/u);
  assert.equal(executions, 1);
  assert.equal(port.requests.length, 2);
  assert.deepEqual(completed.evidenceRefs, [approval.approvalId]);
  assert.deepEqual(await readFile(file), originalBytes);
  assert.deepEqual(await directorySnapshot(root), originalDirectory);

  const executionsMetadata = app.runtime.readToolExecutions(taskId);
  assert.equal(executionsMetadata.length, 1);
  const [execution] = executionsMetadata;
  assert.equal(execution.evidenceId, approval.approvalId);
  assert.equal(execution.taskId, taskId);
  assert.equal(execution.toolName, WORKSPACE_PATCH_PREVIEW_TOOL_NAME);
  assert.equal(execution.toolVersion, WORKSPACE_PATCH_PREVIEW_TOOL_VERSION);
  assert.equal(execution.policyDecision, 'allow');
  assert.equal(execution.executionStarted, true);
  assert.equal(execution.state, 'confirmed');
  assert.match(execution.inputDigest, /^[0-9a-f]{64}$/u);
  assert.equal('errorCode' in execution, false);
  assert.deepEqual(app.runtime.readEvidence(taskId), [{
    evidenceId: approval.approvalId,
    kind: 'execution',
    sourceRef: WORKSPACE_PATCH_PREVIEW_TOOL_NAME,
    capturedAt: execution.finishedAt,
    summary: 'Tool execution confirmed; policy=allow',
    verification: 'conditional',
    sensitivity: 'internal',
  }]);

  const replay = await client.call('authorization.respond', approvalRequest);
  assert.deepEqual(replay, {accepted: true, approvalState: 'allowed'});
  assert.equal(executions, 1, 'idempotent approval replay must not preview the file again');
  assert.equal(app.runtime.readToolExecutions(taskId).length, 1);
  assert.equal(port.requests.length, 2);
  assert.deepEqual(await readFile(file), originalBytes);
  assert.deepEqual(await directorySnapshot(root), originalDirectory);
});
