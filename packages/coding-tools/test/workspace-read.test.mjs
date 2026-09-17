import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  WORKSPACE_READ_SCOPE,
  WORKSPACE_READ_TOOL_NAME,
  createWorkspaceReadTool,
  register,
} from '../dist/index.js';

const context = (overrides = {}) => ({
  taskId: 'task-synthetic',
  runId: 'run-synthetic',
  authorizationRef: 'authorization-synthetic',
  scopes: [WORKSPACE_READ_SCOPE],
  signal: new AbortController().signal,
  deadline: new Date(Date.now() + 60_000).toISOString(),
  ...overrides,
});

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'personal-agent-coding-tools-'));
  const root = join(base, 'workspace');
  const sibling = join(base, 'workspace-sibling');
  await mkdir(join(root, 'src'), {recursive: true});
  await mkdir(sibling, {recursive: true});
  t.after(() => rm(base, {recursive: true, force: true}));
  return {base, root, sibling};
}

test('reads only bounded UTF-8 text and returns no absolute host path', async t => {
  const {root} = await fixture(t);
  await writeFile(join(root, 'src', 'hello.ts'), 'export const greeting = "你好";\n', 'utf8');
  const tool = createWorkspaceReadTool({rootPath: root, maxReadBytes: 4096});

  const result = await tool.execute({path: 'src/hello.ts', maxBytes: 1024}, context());

  assert.deepEqual(result, {
    path: 'src/hello.ts',
    encoding: 'utf-8',
    byteLength: Buffer.byteLength('export const greeting = "你好";\n'),
    content: 'export const greeting = "你好";\n',
  });
  assert.equal(JSON.stringify(result).includes(root), false);
  assert.deepEqual(tool.descriptor.requiredScopes, [WORKSPACE_READ_SCOPE]);
  assert.equal(tool.descriptor.sideEffect, 'read');
});

test('exact input schema rejects missing and additional fields', async t => {
  const {root} = await fixture(t);
  await writeFile(join(root, 'src', 'hello.ts'), 'ok\n');
  const tool = createWorkspaceReadTool({rootPath: root});

  await assert.rejects(tool.execute({}, context()), {code: 'INVALID_ARGUMENT'});
  await assert.rejects(tool.execute({path: 'src/hello.ts', unexpected: true}, context()), {code: 'INVALID_ARGUMENT'});
  await assert.rejects(tool.execute({path: 'src/hello.ts', maxBytes: 0}, context()), {code: 'INVALID_ARGUMENT'});
});

test('rejects parent, absolute, drive, UNC, device, ADS and reserved-device paths', async t => {
  const {root} = await fixture(t);
  const tool = createWorkspaceReadTool({rootPath: root});
  const invalidPaths = [
    '../workspace-sibling/secret.txt',
    '/etc/passwd',
    'C:\\Windows\\system.ini',
    'C:relative.txt',
    '\\\\server\\share\\file.txt',
    '\\\\?\\C:\\Windows\\system.ini',
    '\\\\.\\PhysicalDrive0',
    'src/file.ts:secret',
    'src/NUL.txt',
  ];

  for (const path of invalidPaths) {
    await assert.rejects(tool.execute({path}, context()), {code: 'INVALID_ARGUMENT'}, path);
  }
});

test('rejects sibling-prefix and symlink or junction escape', async t => {
  const {root, sibling} = await fixture(t);
  await writeFile(join(sibling, 'secret.txt'), 'synthetic secret\n');
  await mkdir(join(root, '.ssh'), {recursive: true});
  await writeFile(join(root, '.ssh', 'id_rsa'), 'synthetic credential\n');
  const tool = createWorkspaceReadTool({rootPath: root});

  await assert.rejects(tool.execute({path: '../workspace-sibling/secret.txt'}, context()), {code: 'INVALID_ARGUMENT'});

  const link = join(root, 'workspace-sibling-link');
  try {
    await symlink(sibling, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES' || error?.code === 'ENOSYS') {
      t.skip(`platform cannot create the synthetic symlink/junction fixture: ${error.code}`);
      return;
    }
    throw error;
  }
  await assert.rejects(tool.execute({path: 'workspace-sibling-link/secret.txt'}, context()), {code: 'SCOPE_DENIED'});

  const sensitiveAlias = join(root, 'safe-looking-link');
  await symlink(join(root, '.ssh'), sensitiveAlias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(tool.execute({path: 'safe-looking-link/id_rsa'}, context()), {code: 'SCOPE_DENIED'});
});

test('default policy denies environment, credential and private-key material', async t => {
  const {root} = await fixture(t);
  await writeFile(join(root, '.env'), 'TOKEN=synthetic\n');
  await writeFile(join(root, 'credentials.json'), '{"token":"synthetic"}\n');
  await writeFile(join(root, 'src', 'looks-safe.txt'), '-----BEGIN PRIVATE KEY-----\nsynthetic\n');
  const tool = createWorkspaceReadTool({rootPath: root});

  await assert.rejects(tool.execute({path: '.env'}, context()), {code: 'SCOPE_DENIED'});
  await assert.rejects(tool.execute({path: 'credentials.json'}, context()), {code: 'SCOPE_DENIED'});
  await assert.rejects(tool.execute({path: 'src/looks-safe.txt'}, context()), {code: 'SCOPE_DENIED'});
});

test('rejects files above the host or request ceiling and rejects binary content', async t => {
  const {root} = await fixture(t);
  await writeFile(join(root, 'src', 'large.txt'), 'x'.repeat(65));
  await writeFile(join(root, 'src', 'binary.bin'), Buffer.from([0x00, 0x01, 0x02, 0x03]));
  const tool = createWorkspaceReadTool({rootPath: root, maxReadBytes: 64});

  await assert.rejects(tool.execute({path: 'src/large.txt'}, context()), {code: 'INVALID_ARGUMENT'});
  await assert.rejects(tool.execute({path: 'src/large.txt', maxBytes: 32}, context()), {code: 'INVALID_ARGUMENT'});
  await assert.rejects(tool.execute({path: 'src/binary.bin'}, context()), {code: 'INVALID_ARGUMENT'});
});

test('requires policy-derived scope and enforces pre-read cancellation and deadline', async t => {
  const {root} = await fixture(t);
  await writeFile(join(root, 'src', 'hello.ts'), 'ok\n');
  const tool = createWorkspaceReadTool({rootPath: root});
  const cancelled = new AbortController();
  cancelled.abort();

  await assert.rejects(tool.execute({path: 'src/hello.ts'}, context({scopes: []})), {code: 'SCOPE_DENIED'});
  await assert.rejects(tool.execute({path: 'src/hello.ts'}, context({signal: cancelled.signal})), {code: 'CANCELLED'});
  await assert.rejects(tool.execute({path: 'src/hello.ts'}, context({deadline: new Date(Date.now() - 1).toISOString()})), {code: 'TIMEOUT'});
});

test('cancellation and deadline are checked between bounded read chunks', async t => {
  const {root} = await fixture(t);
  await writeFile(join(root, 'src', 'many-chunks.txt'), 'x'.repeat(32 * 1024));

  const controller = new AbortController();
  const cancellable = createWorkspaceReadTool({rootPath: root, maxReadBytes: 64 * 1024, readChunkBytes: 1});
  const pending = cancellable.execute({path: 'src/many-chunks.txt'}, context({signal: controller.signal}));
  setImmediate(() => controller.abort());
  await assert.rejects(pending, {code: 'CANCELLED'});

  let tick = 0;
  const deadlineBound = createWorkspaceReadTool({
    rootPath: root,
    maxReadBytes: 64 * 1024,
    readChunkBytes: 1,
    now: () => tick++,
  });
  await assert.rejects(deadlineBound.execute(
    {path: 'src/many-chunks.txt'},
    context({deadline: new Date(5).toISOString()}),
  ), {code: 'TIMEOUT'});
});

test('register uses the existing ToolHost lifecycle and dispose unregisters', async t => {
  const {root} = await fixture(t);
  const tools = new Map();
  const host = {
    register(tool) {
      tools.set(tool.descriptor.name, tool);
      return () => tools.delete(tool.descriptor.name);
    },
  };

  const dispose = register(host, {rootPath: root});
  assert.equal(tools.has(WORKSPACE_READ_TOOL_NAME), true);
  dispose();
  assert.equal(tools.has(WORKSPACE_READ_TOOL_NAME), false);
});
