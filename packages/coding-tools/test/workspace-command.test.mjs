import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {InMemoryAuthorizationPolicy} from '@personal-agent/policy';
import {ToolGateway, toolArgumentsDigest} from '@personal-agent/tool-gateway';
import {
  createWorkspaceCommandTool,
  registerWorkspaceCommand,
  WORKSPACE_COMMAND_SCOPE,
  WORKSPACE_COMMAND_TOOL_NAME,
  WORKSPACE_COMMAND_TOOL_VERSION,
} from '../dist/index.js';

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'personal-agent-command-'));
  const root = join(base, 'workspace');
  await mkdir(root);
  t.after(() => rm(base, {recursive: true, force: true}));
  return root;
}

const context = (overrides = {}) => ({
  taskId: 'task-command-synthetic',
  runId: 'run-command-synthetic',
  authorizationRef: 'authorization-command-synthetic',
  scopes: [WORKSPACE_COMMAND_SCOPE],
  signal: new AbortController().signal,
  deadline: new Date(Date.now() + 10_000).toISOString(),
  ...overrides,
});

test('host-fixed recipe uses the bound cwd and cannot be replaced by tool input or later config mutation', async t => {
  const root = await fixture(t);
  const mutableExecutable = join(root, 'mutable-program');
  await writeFile(mutableExecutable, 'not executable');
  assert.throws(() => createWorkspaceCommandTool({
    rootPath: root, recipes: [{id: 'mutable', executable: mutableExecutable, args: []}],
  }), {code: 'INVALID_ARGUMENT'});
  const args = ['-e', 'console.log(process.cwd() === process.argv[1] ? "root-ok" : "wrong-root")', root];
  const tool = createWorkspaceCommandTool({rootPath: root, recipes: [{id: 'check-root', executable: process.execPath, args}]});
  args[1] = 'console.log("mutated")';
  assert.deepEqual(await tool.execute({recipeId: 'check-root'}, context()), {
    recipeId: 'check-root', exitCode: 0, stdout: 'root-ok\n', stderr: '',
  });
  await assert.rejects(tool.execute({recipeId: 'other'}, context()), {code: 'INVALID_ARGUMENT'});
  await assert.rejects(tool.execute({recipeId: 'check-root', args: ['--eval', 'evil']}, context()), {code: 'INVALID_ARGUMENT'});
  await assert.rejects(tool.execute({recipeId: 'check-root'}, context({scopes: []})), {code: 'SCOPE_DENIED'});
  await assert.rejects(tool.execute({recipeId: 'check-root'}, context({deadline: new Date(0).toISOString()})), {code: 'TIMEOUT'});
});

test('existing Policy and ToolGateway gate one exact recipe and registration lifecycle', async t => {
  const root = await fixture(t);
  const policy = new InMemoryAuthorizationPolicy();
  const gateway = new ToolGateway({policy});
  const dispose = registerWorkspaceCommand(gateway, {
    rootPath: root,
    recipes: [{id: 'version', executable: process.execPath, args: ['--version']}],
  });
  const argumentsValue = {recipeId: 'version'};
  const invocation = {
    toolName: WORKSPACE_COMMAND_TOOL_NAME,
    toolVersion: WORKSPACE_COMMAND_TOOL_VERSION,
    arguments: argumentsValue,
    taskId: 'task-command-synthetic',
    runId: 'run-command-synthetic',
    authorizationRef: 'authorization-command-synthetic',
    deadline: new Date(Date.now() + 10_000).toISOString(),
    signal: new AbortController().signal,
  };
  await assert.rejects(gateway.invoke(invocation), {code: 'UNAUTHORIZED'});
  policy.grant({
    authorizationRef: invocation.authorizationRef,
    taskId: invocation.taskId,
    toolName: WORKSPACE_COMMAND_TOOL_NAME,
    scopes: [WORKSPACE_COMMAND_SCOPE],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    argumentsDigest: toolArgumentsDigest(argumentsValue),
    maxUses: 1,
  });
  const result = await gateway.invoke(invocation);
  assert.equal(result.recipeId, 'version');
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /^v\d+\.\d+\.\d+\r?\n$/u);
  assert.equal(result.stderr, '');
  await assert.rejects(gateway.invoke(invocation), {code: 'UNAUTHORIZED'});
  dispose();
  await assert.rejects(gateway.invoke(invocation), {code: 'UNSUPPORTED_CAPABILITY'});
});

test('bounded output and cancellation stop the direct child; a nonzero exit remains explicit', async t => {
  const root = await fixture(t);
  const outputTool = createWorkspaceCommandTool({
    rootPath: root,
    recipes: [{id: 'too-much', executable: process.execPath, args: ['-e', 'process.stdout.write("x".repeat(4096))']}],
    maxOutputBytes: 64,
  });
  await assert.rejects(outputTool.execute({recipeId: 'too-much'}, context()), {code: 'RESULT_UNKNOWN'});

  const exitTool = createWorkspaceCommandTool({
    rootPath: root,
    recipes: [{id: 'exit-three', executable: process.execPath, args: ['-e', 'process.exit(3)']}],
  });
  assert.deepEqual(await exitTool.execute({recipeId: 'exit-three'}, context()), {
    recipeId: 'exit-three', exitCode: 3, stdout: '', stderr: '',
  });

  const pidPath = join(root, 'child.pid');
  const runningTool = createWorkspaceCommandTool({
    rootPath: root,
    recipes: [{
      id: 'wait', executable: process.execPath,
      args: ['-e', 'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)', pidPath],
    }],
  });
  const controller = new AbortController();
  const execution = runningTool.execute({recipeId: 'wait'}, context({signal: controller.signal}));
  let pid;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { pid = Number(await readFile(pidPath, 'utf8')); break; } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  assert.ok(Number.isSafeInteger(pid) && pid > 0, 'fixed child started');
  controller.abort();
  await assert.rejects(execution, {code: 'CANCELLED'});
  assert.throws(() => process.kill(pid, 0), {code: 'ESRCH'});
});
