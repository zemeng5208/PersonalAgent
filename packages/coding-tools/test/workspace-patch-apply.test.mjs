import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync, realpathSync} from 'node:fs';
import {link, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {InMemoryAuthorizationPolicy} from '@personal-agent/policy';
import {ToolGateway, toolArgumentsDigest} from '@personal-agent/tool-gateway';
import {
  createWorkspacePatchApplyTool,
  registerWorkspacePatchApply,
  WORKSPACE_PATCH_APPLY_SCOPE,
  WORKSPACE_PATCH_APPLY_TOOL_NAME,
  WORKSPACE_PATCH_APPLY_TOOL_VERSION,
} from '../dist/index.js';

const sha = text => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const powerShellPath = process.env.PA_TEST_PWSH
  ?? join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
const unavailable = process.platform !== 'win32' || !existsSync(powerShellPath)
  ? 'Windows PowerShell 7 helper is unavailable' : false;

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'personal-agent-apply-'));
  const root = join(base, 'workspace');
  const recoveryRootPath = join(base, 'trusted-recovery');
  await mkdir(join(root, 'src'), {recursive: true});
  await mkdir(recoveryRootPath);
  const source = join(root, 'src', 'note.txt');
  await writeFile(source, 'before\n');
  t.after(() => rm(base, {recursive: true, force: true}));
  return {root, recoveryRootPath, source};
}

const context = (overrides = {}) => ({
  taskId: 'task-apply-synthetic',
  runId: 'run-apply-synthetic',
  authorizationRef: 'authorization-apply-synthetic',
  scopes: ['workspace:read', 'workspace:write', WORKSPACE_PATCH_APPLY_SCOPE],
  signal: new AbortController().signal,
  deadline: new Date(Date.now() + 60_000).toISOString(),
  ...overrides,
});

const request = expectedSha256 => ({
  path: 'src/note.txt', expectedSha256,
  edits: [{oldText: 'before', newText: 'after'}],
});

test('exclusive helper applies exact preview bytes and reads back before releasing the source', {skip: unavailable}, async t => {
  const {root, recoveryRootPath, source} = await fixture(t);
  const tool = createWorkspacePatchApplyTool({rootPath: root, recoveryRootPath, powerShellPath});
  const result = await tool.execute(request(sha('before\n')), context());
  assert.deepEqual(result, {
    path: 'src/note.txt', beforeSha256: sha('before\n'), afterSha256: sha('after\n'),
    byteLength: Buffer.byteLength('after\n'), changed: true, applied: true,
  });
  assert.equal(await readFile(source, 'utf8'), 'after\n');
  assert.deepEqual(await readdir(recoveryRootPath), []);
});

test('stale source and an already open file are rejected without overwriting concurrent edits', {skip: unavailable}, async t => {
  const {root, recoveryRootPath, source} = await fixture(t);
  const tool = createWorkspacePatchApplyTool({rootPath: root, recoveryRootPath, powerShellPath});
  await writeFile(source, 'user edit\n');
  await assert.rejects(tool.execute(request(sha('before\n')), context()), {code: 'REVISION_CONFLICT'});
  assert.equal(await readFile(source, 'utf8'), 'user edit\n');

  await writeFile(source, 'before\n');
  const held = await open(source, 'r');
  try {
    await assert.rejects(tool.execute(request(sha('before\n')), context()), {code: 'REVISION_CONFLICT'});
    assert.equal(await readFile(source, 'utf8'), 'before\n');
  } finally {
    await held.close();
  }
  assert.deepEqual(await readdir(recoveryRootPath), []);
});

test('apply has a separate scope and cannot modify the file after cancellation', {skip: unavailable}, async t => {
  const {root, recoveryRootPath, source} = await fixture(t);
  const tool = createWorkspacePatchApplyTool({rootPath: root, recoveryRootPath, powerShellPath});
  await assert.rejects(tool.execute(request(sha('before\n')), context({scopes: ['workspace:read', 'workspace:write']})), {code: 'SCOPE_DENIED'});
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(tool.execute(request(sha('before\n')), context({signal: controller.signal})), {code: 'CANCELLED'});
  await link(source, join(root, 'src', 'hardlink.txt'));
  await assert.rejects(tool.execute(request(sha('before\n')), context()), {code: 'SCOPE_DENIED'});
  assert.equal(await readFile(source, 'utf8'), 'before\n');
  assert.deepEqual(await readdir(recoveryRootPath), []);
});

test('failed durable backup creation cannot reach the first source write', {skip: unavailable}, async t => {
  const {root, recoveryRootPath, source} = await fixture(t);
  const tool = createWorkspacePatchApplyTool({rootPath: root, recoveryRootPath, powerShellPath});
  await rm(recoveryRootPath, {recursive: true});
  await assert.rejects(tool.execute(request(sha('before\n')), context()), {code: 'RESULT_UNKNOWN'});
  assert.equal(await readFile(source, 'utf8'), 'before\n');
});

test('Policy and ToolGateway require a parameter-bound one-use apply grant', {skip: unavailable}, async t => {
  const {root, recoveryRootPath, source} = await fixture(t);
  const policy = new InMemoryAuthorizationPolicy();
  const gateway = new ToolGateway({policy});
  const dispose = registerWorkspacePatchApply(gateway, {rootPath: root, recoveryRootPath, powerShellPath});
  const argumentsValue = request(sha('before\n'));
  const invocation = {
    toolName: WORKSPACE_PATCH_APPLY_TOOL_NAME,
    toolVersion: WORKSPACE_PATCH_APPLY_TOOL_VERSION,
    arguments: argumentsValue,
    taskId: 'task-apply-synthetic', runId: 'run-apply-gateway',
    authorizationRef: 'authorization-apply-gateway',
    deadline: new Date(Date.now() + 60_000).toISOString(),
    signal: new AbortController().signal,
  };
  await assert.rejects(gateway.invoke(invocation), {code: 'UNAUTHORIZED'});
  assert.equal(await readFile(source, 'utf8'), 'before\n');
  policy.grant({
    authorizationRef: invocation.authorizationRef,
    taskId: invocation.taskId,
    toolName: invocation.toolName,
    scopes: ['workspace:read', 'workspace:write', WORKSPACE_PATCH_APPLY_SCOPE],
    argumentsDigest: toolArgumentsDigest(argumentsValue),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    maxUses: 1,
  });
  await assert.rejects(gateway.invoke({...invocation, arguments: {...argumentsValue, path: 'src/other.txt'}}), {code: 'SCOPE_DENIED'});
  assert.equal((await gateway.invoke(invocation)).applied, true);
  await assert.rejects(gateway.invoke(invocation), {code: 'UNAUTHORIZED'});
  dispose();
  await assert.rejects(gateway.invoke(invocation), {code: 'UNSUPPORTED_CAPABILITY'});
  assert.equal(await readFile(source, 'utf8'), 'after\n');
});

test('an unresolved helper marker prevents another apply to the same source', {skip: unavailable}, async t => {
  const {root, recoveryRootPath, source} = await fixture(t);
  const tool = createWorkspacePatchApplyTool({rootPath: root, recoveryRootPath, powerShellPath});
  const sourceKey = sha(`${realpathSync.native(root)}\nsrc/note.txt`).slice(0, 32);
  const marker = join(recoveryRootPath, `${sourceKey}.inflight`);
  await writeFile(marker, 'unresolved synthetic helper');
  await assert.rejects(tool.execute(request(sha('before\n')), context()), {code: 'RESULT_UNKNOWN'});
  assert.equal(await readFile(source, 'utf8'), 'before\n');
  assert.equal(await readFile(marker, 'utf8'), 'unresolved synthetic helper');
});
