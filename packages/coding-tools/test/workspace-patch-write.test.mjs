import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {InMemoryAuthorizationPolicy} from '@personal-agent/policy';
import {ToolGateway, toolArgumentsDigest} from '@personal-agent/tool-gateway';
import {
  WORKSPACE_PATCH_WRITE_SCOPE,
  WORKSPACE_READ_SCOPE,
  createWorkspacePatchWriteTool,
  registerWorkspacePatchWrite,
} from '../dist/index.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const context = (overrides = {}) => ({
  taskId: 'task-synthetic',
  runId: 'run-synthetic',
  authorizationRef: 'authorization-synthetic',
  scopes: [WORKSPACE_READ_SCOPE, WORKSPACE_PATCH_WRITE_SCOPE],
  signal: new AbortController().signal,
  deadline: new Date(Date.now() + 60_000).toISOString(),
  ...overrides,
});

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'personal-agent-patch-write-'));
  const root = join(base, 'workspace');
  const outside = join(base, 'outside');
  await mkdir(join(root, 'src'), {recursive: true});
  await mkdir(outside);
  t.after(() => rm(base, {recursive: true, force: true}));
  return {root, outside};
}

test('writes one approved candidate and confirms the new file bytes', async t => {
  const {root} = await fixture(t);
  const file = join(root, 'src', 'note.txt');
  await writeFile(file, '你好 before\n');
  const tool = createWorkspacePatchWriteTool({rootPath: root});
  assert.equal(tool.descriptor.sideEffect, 'local_write');
  assert.deepEqual(tool.descriptor.requiredScopes, [WORKSPACE_READ_SCOPE, WORKSPACE_PATCH_WRITE_SCOPE]);
  assert.equal(tool.descriptor.recoverySupport, false);
  const input = {
    path: 'src/note.txt',
    expectedSha256: hash('你好 before\n'),
    edits: [{oldText: 'before', newText: 'after'}],
  };
  const policy = new InMemoryAuthorizationPolicy();
  const gateway = new ToolGateway({policy});
  gateway.register(tool);
  const invocation = {
    toolName: tool.descriptor.name,
    toolVersion: tool.descriptor.version,
    arguments: input,
    taskId: 'task-synthetic',
    runId: 'run-synthetic',
    authorizationRef: 'authorization-synthetic',
    signal: new AbortController().signal,
    deadline: new Date(Date.now() + 60_000).toISOString(),
  };
  await assert.rejects(gateway.invoke(invocation), {code: 'UNAUTHORIZED'});
  assert.equal(await readFile(file, 'utf8'), '你好 before\n');
  policy.grant({
    authorizationRef: invocation.authorizationRef,
    taskId: invocation.taskId,
    toolName: invocation.toolName,
    scopes: [WORKSPACE_READ_SCOPE, WORKSPACE_PATCH_WRITE_SCOPE],
    argumentsDigest: toolArgumentsDigest(input),
    expiresAt: invocation.deadline,
    maxUses: 1,
  });
  const result = await gateway.invoke(invocation);
  assert.deepEqual(result, {
    path: 'src/note.txt',
    beforeSha256: hash('你好 before\n'),
    afterSha256: hash('你好 after\n'),
    byteLength: Buffer.byteLength('你好 after\n'),
    changed: true,
  });
  assert.equal(await readFile(file, 'utf8'), '你好 after\n');
  assert.equal(policy.get(invocation.authorizationRef).usesRemaining, 0);
  assert.deepEqual(await readdir(join(root, 'src')), ['note.txt']);
});

test('stale hashes, missing write scope, cancellation and traversal preserve original bytes', async t => {
  const {root, outside} = await fixture(t);
  const file = join(root, 'src', 'note.txt');
  await writeFile(file, 'user edited\n');
  await writeFile(join(outside, 'note.txt'), 'outside\n');
  const tool = createWorkspacePatchWriteTool({rootPath: root});
  const input = {
    path: 'src/note.txt',
    expectedSha256: hash('old version\n'),
    edits: [{oldText: 'old version', newText: 'new version'}],
  };
  await assert.rejects(tool.execute(input, context()), {code: 'REVISION_CONFLICT'});
  await assert.rejects(tool.execute(input, context({scopes: [WORKSPACE_READ_SCOPE]})), {code: 'SCOPE_DENIED'});
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(tool.execute(input, context({signal: controller.signal})), {code: 'CANCELLED'});
  await assert.rejects(tool.execute({...input, path: '../outside/note.txt'}, context()), {code: 'INVALID_ARGUMENT'});
  assert.equal(await readFile(file, 'utf8'), 'user edited\n');
  assert.equal(await readFile(join(outside, 'note.txt'), 'utf8'), 'outside\n');
  assert.deepEqual(await readdir(join(root, 'src')), ['note.txt']);
});

test('rejects linked write targets and uses the existing ToolHost registration lifecycle', async t => {
  const {root, outside} = await fixture(t);
  const target = join(root, 'src', 'target.txt');
  await writeFile(target, 'before\n');
  const tools = new Map();
  const host = {register(tool) {
    tools.set(tool.descriptor.name, tool);
    return () => tools.delete(tool.descriptor.name);
  }};
  const dispose = registerWorkspacePatchWrite(host, {rootPath: root});
  const tool = tools.get('workspace.apply_text_patch');
  assert.ok(tool);
  const linked = join(root, 'src', 'linked.txt');
  try {
    await symlink(target, linked, 'file');
    await assert.rejects(tool.execute({
      path: 'src/linked.txt',
      expectedSha256: hash('before\n'),
      edits: [{oldText: 'before', newText: 'after'}],
    }, context()), {code: 'SCOPE_DENIED'});
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) throw error;
  }
  await assert.rejects(tool.execute({
    path: 'src/target.txt',
    expectedSha256: hash('before\n'),
    edits: [{oldText: 'before', newText: 'after'}],
  }, context({deadline: new Date(Date.now() - 1).toISOString()})), {code: 'TIMEOUT'});
  assert.equal(await readFile(target, 'utf8'), 'before\n');
  assert.equal(await readdir(outside).then(items => items.length), 0);
  dispose();
  assert.equal(tools.size, 0);
});
