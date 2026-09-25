import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {
  MAX_WORKSPACE_PATCH_EDITS,
  WORKSPACE_PATCH_PREVIEW_TOOL_NAME,
  WORKSPACE_READ_SCOPE,
  createWorkspacePatchPreviewTool,
  registerWorkspacePatchPreview,
} from '../dist/index.js';

const hash = value => createHash('sha256').update(value).digest('hex');
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
  const base = await mkdtemp(join(tmpdir(), 'personal-agent-patch-preview-'));
  const root = join(base, 'workspace');
  const sibling = join(base, 'sibling');
  await mkdir(join(root, 'src'), {recursive: true});
  await mkdir(sibling, {recursive: true});
  t.after(() => rm(base, {recursive: true, force: true}));
  return {base, root, sibling};
}

test('previews ordered non-ASCII edits from an immutable input snapshot without writing', async t => {
  const {root} = await fixture(t);
  const source = 'export const greeting = "你好";\n';
  const preview = 'export const greeting = "再见";\n';
  const file = join(root, 'src', 'greeting.ts');
  await writeFile(file, source, 'utf8');
  const tool = createWorkspacePatchPreviewTool({rootPath: root, maxReadBytes: 4096});
  const input = {
    path: 'src/greeting.ts',
    expectedSha256: hash(Buffer.from(source)),
    edits: [{oldText: '"你好"', newText: '"再见"'}],
  };

  const pending = tool.execute(input, context());
  input.path = '../outside.ts';
  input.expectedSha256 = '0'.repeat(64);
  input.edits[0].oldText = 'missing';
  input.edits.push({oldText: 'export', newText: 'mutated'});
  const result = await pending;

  assert.deepEqual(result, {
    path: 'src/greeting.ts',
    beforeSha256: hash(Buffer.from(source)),
    afterSha256: hash(Buffer.from(preview)),
    changed: true,
    previewText: preview,
  });
  assert.equal(await readFile(file, 'utf8'), source);
  assert.deepEqual(tool.descriptor.requiredScopes, [WORKSPACE_READ_SCOPE]);
  assert.equal(tool.descriptor.name, WORKSPACE_PATCH_PREVIEW_TOOL_NAME);
  assert.equal(tool.descriptor.version, '1.0.0');
  assert.equal(tool.descriptor.sideEffect, 'read');
});

test('rejects a stale byte hash and leaves the file unchanged', async t => {
  const {root} = await fixture(t);
  const source = 'alpha\n';
  const file = join(root, 'src', 'stale.txt');
  await writeFile(file, source, 'utf8');
  const tool = createWorkspacePatchPreviewTool({rootPath: root});

  await assert.rejects(tool.execute({
    path: 'src/stale.txt',
    expectedSha256: '0'.repeat(64),
    edits: [{oldText: 'alpha', newText: 'beta'}],
  }, context()), {code: 'REVISION_CONFLICT'});
  assert.equal(await readFile(file, 'utf8'), source);
});

test('rejects missing, ambiguous, repeated and sequentially ambiguous edits', async t => {
  const {root} = await fixture(t);
  const source = 'alpha beta alpha\n';
  await writeFile(join(root, 'src', 'rules.txt'), source, 'utf8');
  const tool = createWorkspacePatchPreviewTool({rootPath: root});
  const request = edits => ({
    path: 'src/rules.txt',
    expectedSha256: hash(Buffer.from(source)),
    edits,
  });

  await assert.rejects(tool.execute(request([{oldText: 'missing', newText: 'value'}]), context()),
    {code: 'INVALID_ARGUMENT'});
  await assert.rejects(tool.execute(request([{oldText: 'alpha', newText: 'value'}]), context()),
    {code: 'INVALID_ARGUMENT'});
  await assert.rejects(tool.execute(request([
    {oldText: 'beta', newText: 'first'},
    {oldText: 'beta', newText: 'second'},
  ]), context()), {code: 'INVALID_ARGUMENT'});
  await assert.rejects(tool.execute(request([
    {oldText: 'beta', newText: 'alpha'},
    {oldText: 'alpha', newText: 'value'},
  ]), context()), {code: 'INVALID_ARGUMENT'});
  assert.equal(await readFile(join(root, 'src', 'rules.txt'), 'utf8'), source);
});

test('inherits path, sensitive, link, UTF-8 and bounded input/output rejection', async t => {
  const {root, sibling} = await fixture(t);
  await writeFile(join(root, '.env'), 'TOKEN=synthetic\n');
  await writeFile(join(root, 'src', 'invalid.bin'), Buffer.from([0xc3, 0x28]));
  await writeFile(join(root, 'src', 'bom.txt'), Buffer.from([0xef, 0xbb, 0xbf, 0x6f, 0x6b]));
  await writeFile(join(root, 'src', 'small.txt'), 'small\n');
  await writeFile(join(sibling, 'outside.txt'), 'outside\n');
  const tool = createWorkspacePatchPreviewTool({rootPath: root, maxPreviewBytes: 32});
  const preview = (path, bytes, edits) => ({path, expectedSha256: hash(bytes), edits});

  await assert.rejects(tool.execute(preview('../sibling/outside.txt', Buffer.from('outside\n'), [
    {oldText: 'outside', newText: 'inside'},
  ]), context()), {code: 'INVALID_ARGUMENT'});
  await assert.rejects(tool.execute(preview('.env', Buffer.from('TOKEN=synthetic\n'), [
    {oldText: 'synthetic', newText: 'replacement'},
  ]), context()), {code: 'SCOPE_DENIED'});
  await assert.rejects(tool.execute(preview('src/invalid.bin', Buffer.from([0xc3, 0x28]), [
    {oldText: 'x', newText: 'y'},
  ]), context()), {code: 'INVALID_ARGUMENT'});
  await assert.rejects(tool.execute(preview('src/bom.txt', Buffer.from([0xef, 0xbb, 0xbf, 0x6f, 0x6b]), [
    {oldText: 'ok', newText: 'yes'},
  ]), context()), {code: 'INVALID_ARGUMENT'});
  await assert.rejects(tool.execute(preview('src/small.txt', Buffer.from('small\n'), [
    {oldText: 'small', newText: '你'.repeat(16)},
  ]), context()), {code: 'INVALID_ARGUMENT'});
  await assert.rejects(tool.execute(preview('src/small.txt', Buffer.from('small\n'), [
    {oldText: 'small', newText: '\ud800'},
  ]), context()), {code: 'INVALID_ARGUMENT'});
  await assert.rejects(tool.execute(preview('src/small.txt', Buffer.from('small\n'), [
    {oldText: 'small', newText: 'binary\u0001text'},
  ]), context()), {code: 'INVALID_ARGUMENT'});
  await assert.rejects(tool.execute({
    ...preview('src/small.txt', Buffer.from('small\n'), [{oldText: 'small', newText: 'large'}]),
    extra: true,
  }, context()), {code: 'INVALID_ARGUMENT'});
  await assert.rejects(tool.execute(preview('src/small.txt', Buffer.from('small\n'),
    Array.from({length: MAX_WORKSPACE_PATCH_EDITS + 1}, (_, index) => ({oldText: `old-${index}`, newText: 'x'}))),
  context()), {code: 'INVALID_ARGUMENT'});
  await assert.rejects(tool.execute(preview(
    'src/small.txt',
    Buffer.from('small\n'),
    new Array(2 ** 32 - 1),
  ), context()), {code: 'INVALID_ARGUMENT'});

  let getterReads = 0;
  const getterInput = {
    expectedSha256: hash(Buffer.from('small\n')),
    edits: [{oldText: 'small', newText: 'large'}],
  };
  Object.defineProperty(getterInput, 'path', {enumerable: true, get() { getterReads += 1; return 'src/small.txt'; }});
  await assert.rejects(tool.execute(getterInput, context()), {code: 'INVALID_ARGUMENT'});
  assert.equal(getterReads, 0, 'data-only capture must reject accessors without invoking them');

  const link = join(root, 'outside-link');
  try {
    await symlink(sibling, link, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(tool.execute(preview('outside-link/outside.txt', Buffer.from('outside\n'), [
      {oldText: 'outside', newText: 'inside'},
    ]), context()), {code: 'SCOPE_DENIED'});
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) throw error;
  }
});

test('reuses read scope, cancellation, deadline and ToolHost disposal semantics', async t => {
  const {root} = await fixture(t);
  const source = 'before\n';
  await writeFile(join(root, 'src', 'context.txt'), source, 'utf8');
  const tool = createWorkspacePatchPreviewTool({rootPath: root});
  const input = {
    path: 'src/context.txt',
    expectedSha256: hash(Buffer.from(source)),
    edits: [{oldText: 'before', newText: 'after'}],
  };
  const cancelled = new AbortController();
  cancelled.abort();

  await assert.rejects(tool.execute(input, context({scopes: []})), {code: 'SCOPE_DENIED'});
  await assert.rejects(tool.execute(input, context({signal: cancelled.signal})), {code: 'CANCELLED'});
  await assert.rejects(tool.execute(input, context({deadline: new Date(Date.now() - 1).toISOString()})),
    {code: 'TIMEOUT'});

  const tools = new Map();
  const host = {register(value) { tools.set(value.descriptor.name, value); return () => tools.delete(value.descriptor.name); }};
  const dispose = registerWorkspacePatchPreview(host, {rootPath: root});
  assert.equal(tools.has(WORKSPACE_PATCH_PREVIEW_TOOL_NAME), true);
  dispose();
  assert.equal(tools.has(WORKSPACE_PATCH_PREVIEW_TOOL_NAME), false);
});
