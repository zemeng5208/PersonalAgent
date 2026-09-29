import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {
  DEFAULT_WORKSPACE_LIST_LIMIT,
  WORKSPACE_LIST_SCOPE,
  WORKSPACE_LIST_TOOL_NAME,
  createWorkspaceListTool,
  registerWorkspaceList,
} from '../dist/index.js';

const context = (overrides = {}) => ({
  taskId: 'task-list-synthetic',
  runId: 'run-list-synthetic',
  authorizationRef: 'authorization-list-synthetic',
  scopes: [WORKSPACE_LIST_SCOPE],
  signal: new AbortController().signal,
  deadline: new Date(Date.now() + 60_000).toISOString(),
  ...overrides,
});

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'personal-agent-coding-tools-list-'));
  const root = join(base, 'workspace');
  const sibling = join(base, 'workspace-sibling');
  await mkdir(root, {recursive: true});
  await mkdir(sibling, {recursive: true});
  t.after(() => rm(base, {recursive: true, force: true}));
  return {base, root, sibling};
}

test("lists only direct children in stable order and marks a bounded result truncated", async t => {
  const {root} = await fixture(t);
  await mkdir(join(root, 'z-dir'));
  await mkdir(join(root, 'a-dir'));
  await writeFile(join(root, 'a-dir', 'nested.ts'), 'not returned\n');
  await writeFile(join(root, 'b.ts'), 'b\n');
  await writeFile(join(root, 'c.ts'), 'c\n');
  const tool = createWorkspaceListTool({rootPath: root, maxEntries: 5});

  const result = await tool.execute({path: '.', limit: 2}, context());

  assert.equal(DEFAULT_WORKSPACE_LIST_LIMIT, 100);
  assert.deepEqual(result, {
    path: '.',
    entries: [
      {name: 'a-dir', kind: 'directory'},
      {name: 'b.ts', kind: 'file'},
    ],
    truncated: true,
  });
  assert.equal(JSON.stringify(result).includes(root), false);
  assert.equal(JSON.stringify(result).includes('nested.ts'), false);

  for (let index = 0; index <= DEFAULT_WORKSPACE_LIST_LIMIT; index += 1) {
    await writeFile(join(root, `bulk-${String(index).padStart(3, '0')}.txt`), 'x\n');
  }
  const defaultBound = await createWorkspaceListTool({rootPath: root}).execute({path: '.'}, context());
  assert.equal(defaultBound.entries.length, DEFAULT_WORKSPACE_LIST_LIMIT);
  assert.equal(defaultBound.truncated, true);
});

test('rejects escapes and linked directories while omitting sensitive or linked entries', async t => {
  const {root, sibling} = await fixture(t);
  await writeFile(join(root, 'safe.ts'), 'safe\n');
  await writeFile(join(root, '.env'), 'TOKEN=synthetic\n');
  await writeFile(join(root, 'credentials.json'), '{"token":"synthetic"}\n');
  await mkdir(join(root, '.ssh'));
  await writeFile(join(root, '.ssh', 'id_rsa'), 'synthetic\n');
  await writeFile(join(sibling, 'outside.txt'), 'outside\n');
  await symlink(sibling, join(root, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');
  const tool = createWorkspaceListTool({rootPath: root});

  const result = await tool.execute({path: '.'}, context());

  assert.deepEqual(result.entries, [{name: 'safe.ts', kind: 'file'}]);
  assert.equal(result.truncated, false);
  await assert.rejects(tool.execute({path: '../workspace-sibling'}, context()), {code: 'INVALID_ARGUMENT'});
  await assert.rejects(tool.execute({path: '.ssh'}, context()), {code: 'SCOPE_DENIED'});
  await assert.rejects(tool.execute({path: 'outside-link'}, context()), {code: 'SCOPE_DENIED'});
});

test("uses '.' only for the root and enforces the exact bounded input schema", async t => {
  const {root} = await fixture(t);
  const tool = createWorkspaceListTool({rootPath: root, maxEntries: 5});

  await assert.rejects(tool.execute({}, context()), {code: 'INVALID_ARGUMENT'});
  await assert.rejects(tool.execute({path: '', limit: 1}, context()), {code: 'INVALID_ARGUMENT'});
  await assert.rejects(tool.execute({path: './src', limit: 1}, context()), {code: 'INVALID_ARGUMENT'});
  await assert.rejects(tool.execute({path: '.', limit: 0}, context()), {code: 'INVALID_ARGUMENT'});
  await assert.rejects(tool.execute({path: '.', limit: 6}, context()), {code: 'INVALID_ARGUMENT'});
  await assert.rejects(tool.execute({path: '.', unexpected: true}, context()), {code: 'INVALID_ARGUMENT'});
});

test('requires its independent scope and checks cancellation and deadline during enumeration', async t => {
  const {root} = await fixture(t);
  for (let index = 0; index < 12; index += 1) {
    await writeFile(join(root, `entry-${String(index).padStart(2, '0')}.txt`), 'x\n');
  }
  const tool = createWorkspaceListTool({rootPath: root});
  const cancelled = new AbortController();
  cancelled.abort();

  await assert.rejects(tool.execute({path: '.'}, context({scopes: []})), {code: 'SCOPE_DENIED'});
  await assert.rejects(tool.execute({path: '.'}, context({signal: cancelled.signal})), {code: 'CANCELLED'});

  let tick = 0;
  const deadlineBound = createWorkspaceListTool({rootPath: root, now: () => tick++});
  await assert.rejects(
    deadlineBound.execute({path: '.'}, context({deadline: new Date(5).toISOString()})),
    {code: 'TIMEOUT'},
  );
  assert.ok(tick > 5, 'deadline must expire after enumeration has begun');
});

test('registers with the existing ToolHost and disposer removes only the list tool', async t => {
  const {root} = await fixture(t);
  const tools = new Map();
  const host = {
    register(tool) {
      tools.set(tool.descriptor.name, tool);
      return () => tools.delete(tool.descriptor.name);
    },
  };

  const dispose = registerWorkspaceList(host, {rootPath: root});
  assert.equal(tools.has(WORKSPACE_LIST_TOOL_NAME), true);
  assert.deepEqual(tools.get(WORKSPACE_LIST_TOOL_NAME).descriptor.requiredScopes, [WORKSPACE_LIST_SCOPE]);
  dispose();
  assert.equal(tools.has(WORKSPACE_LIST_TOOL_NAME), false);
});
