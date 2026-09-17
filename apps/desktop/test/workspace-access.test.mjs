import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {Client} from '@personal-agent/client';
import {FakeCoordinationPort} from '@personal-agent/coordination/testing';
import {createRuntimeApplication} from '@personal-agent/runtime/application';
import {WorkspaceAccess, validateWorkspaceRoot} from '../electron/workspace-access.js';

const content = 'export const selectedWorkspace = true;\n';

async function fixture() {
  const base = await mkdtemp(path.join(tmpdir(), 'personal-agent-desktop-workspace-'));
  const rootA = path.join(base, 'workspace-a');
  const rootB = path.join(base, 'workspace-b');
  const protectedRoot = path.join(base, 'protected');
  await Promise.all([rootA, rootB, protectedRoot].map(directory => mkdir(directory, {recursive: true})));
  await writeFile(path.join(rootA, 'selected.ts'), content, 'utf8');
  await writeFile(path.join(rootB, 'selected.ts'), 'export const selectedWorkspace = "b";\n', 'utf8');
  return {base, rootA, rootB, protectedRoot, database: path.join(base, 'runtime.sqlite')};
}

function toolContext(scopes = ['workspace:read']) {
  return {
    runId: 'desktop-workspace-test-run',
    taskId: 'desktop-workspace-test-task',
    authorizationRef: 'desktop-workspace-test-authorization',
    deadline: new Date(Date.now() + 60_000).toISOString(),
    scopes,
    signal: new AbortController().signal,
  };
}

async function waitForState(app, taskId, states) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const task = app.runtime.getTask(taskId);
    if (states.includes(task.state)) return task;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw Error(`Task ${taskId} did not reach ${states.join(' or ')}`);
}

async function waitForIdle(app) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (app.activeTaskCount === 0) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw Error('Runtime application did not become idle');
}

test('native selection is the only root source; cancellation and busy state do not expand access', async t => {
  const {base, rootA, protectedRoot} = await fixture();
  t.after(() => rm(base, {recursive: true, force: true}));
  let selected;
  let calls = 0;
  const access = new WorkspaceAccess({
    selectDirectory: async () => { calls += 1; return selected; },
    protectedRoots: [protectedRoot],
    broadRoots: [],
  });

  assert.deepEqual(access.tools(), []);
  assert.equal(access.snapshot().configured, false);
  assert.equal((await access.select()).cancelled, true);
  assert.equal(calls, 1);

  selected = rootA;
  await assert.rejects(access.select({isBusy: () => true}), /存在未结束任务/u);
  assert.equal(calls, 1, 'busy selection must be rejected before opening the native dialog');
  await assert.rejects(
    access.select({rendererPayload: {rootPath: rootA}}),
    /只能由主进程原生目录选择器提供/u,
  );
  assert.equal(calls, 1, 'Renderer-provided paths must never reach the native selector');

  const granted = await access.select();
  assert.equal(granted.configured, true);
  assert.equal(granted.label, path.basename(rootA));
  assert.equal(JSON.stringify(granted).includes(rootA), false, 'snapshots must not expose the absolute root');
  assert.deepEqual(access.tools().map(tool => tool.descriptor.name), [
    'workspace.read_text',
    'workspace.list_entries',
    'workspace.preview_text_patch',
  ]);
  assert.deepEqual(access.tools().map(tool => tool.descriptor.requiredScopes), [
    ['workspace:read'],
    ['workspace:list'],
    ['workspace:read'],
  ]);
});

test('late native picker results stay stale after revoke or a newer selection', async t => {
  const {base, rootA, rootB} = await fixture();
  t.after(() => rm(base, {recursive: true, force: true}));
  const resolvers = [];
  const access = new WorkspaceAccess({
    selectDirectory: () => new Promise(resolve => resolvers.push(resolve)),
    protectedRoots: [],
    broadRoots: [],
  });

  const pendingAfterRevoke = access.select();
  access.revoke();
  resolvers.shift()(rootA);
  const revokedResult = await pendingAfterRevoke;
  assert.equal(revokedResult.stale, true);
  assert.equal(access.snapshot().configured, false);
  assert.equal(access.snapshot().revision, 0);

  const older = access.select();
  const newer = access.select();
  const [resolveOlder, resolveNewer] = resolvers.splice(0, 2);
  resolveNewer(rootB);
  const newerResult = await newer;
  assert.equal(newerResult.configured, true);
  const committedRevision = access.snapshot().revision;
  resolveOlder(rootA);
  const stale = await older;
  assert.equal(stale.stale, true);
  assert.equal(access.snapshot().label, path.basename(rootB));
  assert.equal(access.snapshot().revision, committedRevision);
  const readTool = access.tools().find(tool => tool.descriptor.name === 'workspace.read_text');
  assert.match((await readTool.execute({path: 'selected.ts'}, toolContext())).content, /"b"/u);
});

test('a task that starts while the native picker is open blocks commit and preserves the old grant', async t => {
  const {base, rootA, rootB} = await fixture();
  t.after(() => rm(base, {recursive: true, force: true}));
  const access = new WorkspaceAccess({
    selectDirectory: async () => rootA,
    protectedRoots: [],
    broadRoots: [],
  });
  await access.select();
  const oldTools = access.tools();
  const oldRevision = access.snapshot().revision;
  let resolvePicker;
  let busy = false;
  let commits = 0;
  access.selectDirectory = () => new Promise(resolve => { resolvePicker = resolve; });
  const pending = access.select({
    isBusy: () => busy,
    beforeCommit: () => { commits += 1; },
  });
  busy = true;
  resolvePicker(rootB);
  await assert.rejects(pending, /目录选择期间任务已开始/u);
  assert.equal(commits, 0);
  assert.equal(access.snapshot().label, path.basename(rootA));
  assert.equal(access.snapshot().revision, oldRevision);
  assert.deepEqual(access.tools(), oldTools);
});

test('volume, broad and protected roots are rejected and a failed replacement never revives the old root', async t => {
  const {base, rootA, protectedRoot} = await fixture();
  t.after(() => rm(base, {recursive: true, force: true}));
  assert.throws(
    () => validateWorkspaceRoot(path.parse(base).root, {protectedRoots: [], broadRoots: []}),
    /整个磁盘/u,
  );
  assert.throws(
    () => validateWorkspaceRoot(base, {protectedRoots: [], broadRoots: [base]}),
    /过宽/u,
  );
  assert.throws(
    () => validateWorkspaceRoot(protectedRoot, {protectedRoots: [protectedRoot], broadRoots: []}),
    /系统保护目录/u,
  );

  let selected = rootA;
  const access = new WorkspaceAccess({
    selectDirectory: async () => selected,
    protectedRoots: [protectedRoot],
    broadRoots: [],
  });
  await access.select();
  selected = protectedRoot;
  await assert.rejects(access.select(), /系统保护目录/u);
  assert.equal(access.snapshot().configured, false);
  assert.deepEqual(access.tools(), []);
});

test('revocation and A-to-B replacement invalidate old wrappers and discard late content', async t => {
  const {base, rootA, rootB} = await fixture();
  t.after(() => rm(base, {recursive: true, force: true}));
  let selected = rootA;
  const access = new WorkspaceAccess({
    selectDirectory: async () => selected,
    protectedRoots: [],
    broadRoots: [],
  });
  await access.select();
  const oldTools = new Map(access.tools().map(tool => [tool.descriptor.name, tool]));
  const sourceSha256 = createHash('sha256').update(content).digest('hex');
  assert.equal((await oldTools.get('workspace.read_text').execute({path: 'selected.ts'}, toolContext())).content, content);

  selected = rootB;
  await access.select();
  await assert.rejects(
    oldTools.get('workspace.read_text').execute({path: 'selected.ts'}, toolContext()),
    /cancel|撤销/iu,
  );
  await assert.rejects(
    oldTools.get('workspace.list_entries').execute({path: '.'}, toolContext(['workspace:list'])),
    /cancel|撤销/iu,
  );
  await assert.rejects(oldTools.get('workspace.preview_text_patch').execute({
    path: 'selected.ts',
    expectedSha256: sourceSha256,
    edits: [{oldText: 'true', newText: 'false'}],
  }, toolContext()), /cancel|撤销/iu);
  const currentTools = new Map(access.tools().map(tool => [tool.descriptor.name, tool]));
  assert.match((await currentTools.get('workspace.read_text').execute({path: 'selected.ts'}, toolContext())).content, /"b"/u);

  access.revoke();
  await assert.rejects(
    currentTools.get('workspace.read_text').execute({path: 'selected.ts'}, toolContext()),
    /cancel|撤销/iu,
  );
  await assert.rejects(
    currentTools.get('workspace.list_entries').execute({path: '.'}, toolContext(['workspace:list'])),
    /cancel|撤销/iu,
  );
  await assert.rejects(currentTools.get('workspace.preview_text_patch').execute({
    path: 'selected.ts',
    expectedSha256: sourceSha256,
    edits: [{oldText: 'true', newText: 'false'}],
  }, toolContext()), /cancel|撤销/iu);
  assert.deepEqual(access.tools(), []);

  let release;
  const late = new WorkspaceAccess({
    selectDirectory: async () => rootA,
    protectedRoots: [],
    broadRoots: [],
    toolFactory: () => ({
      descriptor: {name: 'workspace.read_text', version: '1.0.0'},
      execute: async () => new Promise(resolve => { release = () => resolve({content: 'late private content'}); }),
    }),
  });
  await late.select();
  const pending = late.tools()[0].execute({path: 'selected.ts'}, toolContext());
  late.revoke();
  release();
  await assert.rejects(pending, /结果已丢弃/u);
});

test('selected root enters the existing Competition approval loop and the same database survives revocation', async t => {
  const {base, rootA, database} = await fixture();
  let app;
  let reopened;
  t.after(async () => {
    try { app?.close(); } catch {}
    try { reopened?.close(); } catch {}
    await rm(base, {recursive: true, force: true});
  });
  const access = new WorkspaceAccess({
    selectDirectory: async () => rootA,
    protectedRoots: [],
    broadRoots: [],
  });
  await access.select();
  const directoryBefore = await readdir(rootA);
  const sourceFile = path.join(rootA, 'selected.ts');
  const originalBytes = await readFile(sourceFile);
  const candidate = content.replace('true', 'false');
  const beforeSha256 = createHash('sha256').update(originalBytes).digest('hex');
  const afterSha256 = createHash('sha256').update(candidate).digest('hex');
  const port = new FakeCoordinationPort(request => {
    if (request.continuation === undefined) {
      return {
        kind: 'tool_proposal',
        proposalId: 'desktop-workspace-preview-proposal',
        toolName: 'workspace.preview_text_patch',
        toolVersion: '1.0.0',
        arguments: {
          path: 'selected.ts',
          expectedSha256: beforeSha256,
          edits: [{oldText: 'true', newText: 'false'}],
        },
        verification: 'mock',
      };
    }
    assert.deepEqual(request.continuation, {
      proposalId: 'desktop-workspace-preview-proposal',
      state: 'confirmed',
      result: {
        path: 'selected.ts',
        beforeSha256,
        afterSha256,
        changed: true,
        previewText: candidate,
      },
    });
    return {kind: 'text', text: '本地补丁预览已确认，文件未写入', verification: 'mock'};
  });
  app = createRuntimeApplication({
    path: database,
    profile: 'huawei_ict_agentarts',
    coordination: port,
    tools: access.tools(),
  });
  const client = new Client(app, Date.now);
  await client.connect();
  const capabilities = await client.call('capability.list', {kind: 'tool'});
  assert.deepEqual(capabilities.manifests.map(item => item.name), [
    'workspace.read_text',
    'workspace.list_entries',
    'workspace.preview_text_patch',
  ]);
  assert.deepEqual(capabilities.health, [
    {id: 'workspace.read_text', state: 'ready'},
    {id: 'workspace.list_entries', state: 'ready'},
    {id: 'workspace.preview_text_patch', state: 'ready'},
  ]);
  const {taskId} = await client.call('task.submit', {
    goal: '预览显式选择的合成工作区文件修改，但不要写入',
    conversationId: 'desktop-workspace-access',
  }, {idempotencyKey: 'desktop-workspace-access'});
  assert.equal((await waitForState(app, taskId, ['waiting_approval', 'failed'])).state, 'waiting_approval');
  const approvals = await client.call('approval.list', {taskId, state: 'pending'});
  assert.equal(approvals.items.length, 1);
  assert.equal(approvals.items[0].action, 'workspace.preview_text_patch');
  assert.equal('arguments' in approvals.items[0], false, 'Desktop approval snapshots stay redacted');
  await client.call('authorization.respond', {
    approvalId: approvals.items[0].approvalId,
    expectedRevision: approvals.items[0].revision,
    decision: 'allow_once',
  });
  const completed = await waitForState(app, taskId, ['succeeded', 'failed']);
  assert.equal(completed.state, 'succeeded');
  assert.match(completed.resultSummary, /本地补丁预览已确认，文件未写入/u);
  assert.equal(port.requests.length, 2);
  assert.equal(app.runtime.readToolExecutions(taskId).length, 1);
  assert.equal(app.runtime.readToolExecutions(taskId)[0].toolName, 'workspace.preview_text_patch');
  assert.deepEqual(await readFile(sourceFile), originalBytes);
  assert.deepEqual(await readdir(rootA), directoryBefore);
  await waitForIdle(app);
  app.close();
  app = undefined;

  access.revoke();
  reopened = createRuntimeApplication({
    path: database,
    profile: 'huawei_ict_agentarts',
    coordination: new FakeCoordinationPort(() => ({kind: 'text', text: 'unused', verification: 'mock'})),
  });
  const reopenedClient = new Client(reopened, Date.now);
  await reopenedClient.connect();
  await assert.rejects(reopenedClient.call('capability.list', {kind: 'tool'}), {code: 'UNSUPPORTED_CAPABILITY'});
  const persisted = await reopenedClient.call('task.list', {conversationId: 'desktop-workspace-access', limit: 10});
  assert.equal(persisted.items.length, 1);
  assert.equal(persisted.items[0].taskId, taskId);
  assert.equal(persisted.items[0].state, 'succeeded');
});
