import assert from 'node:assert/strict';
import {existsSync, statSync} from 'node:fs';
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

function resolveJobHostExe() {
  if (process.env.PA_TEST_JOB_HOST_EXE && existsSync(process.env.PA_TEST_JOB_HOST_EXE)) return process.env.PA_TEST_JOB_HOST_EXE;
  const release = join(import.meta.dirname, '..', 'native', 'bin', 'Release', 'net8.0-windows', 'WindowsJobProcessHost.exe');
  if (existsSync(release)) return release;
  return join(import.meta.dirname, '..', 'native', 'bin', 'Debug', 'net8.0-windows', 'WindowsJobProcessHost.exe');
}

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
  await writeFile(join(root, 'cwd-marker.txt'), 'root');
  const args = ['-e', 'console.log(require("node:fs").readFileSync("cwd-marker.txt", "utf8") === "root" ? "root-ok" : "wrong-root")'];
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

test('env option and recipe env are validated, merged, and do not leak inherited secrets', async t => {
  const root = await fixture(t);

  // 1. Invalid keys and forbidden secret keywords
  assert.throws(() => createWorkspaceCommandTool({
    rootPath: root,
    recipes: [{id: 'check-key', executable: process.execPath, args: ['--version'], env: {'123bad': 'val'}}],
  }), {code: 'INVALID_ARGUMENT'});

  assert.throws(() => createWorkspaceCommandTool({
    rootPath: root,
    recipes: [{id: 'check-secret', executable: process.execPath, args: ['--version'], env: {GITHUB_TOKEN: 'secret'}}],
  }), {code: 'INVALID_ARGUMENT'});

  assert.throws(() => createWorkspaceCommandTool({
    rootPath: root,
    recipes: [{id: 'check-auth', executable: process.execPath, args: ['--version'], env: {USER_AUTH_DATA: 'secret'}}],
  }), {code: 'INVALID_ARGUMENT'});

  assert.throws(() => createWorkspaceCommandTool({
    rootPath: root,
    recipes: [{id: 'check-key-kw', executable: process.execPath, args: ['--version'], env: {API_KEY: 'secret'}}],
  }), {code: 'INVALID_ARGUMENT'});

  assert.throws(() => createWorkspaceCommandTool({
    rootPath: root,
    recipes: [{id: 'check-val', executable: process.execPath, args: ['--version'], env: {VAR: 123}}],
  }), {code: 'INVALID_ARGUMENT'});

  assert.throws(() => createWorkspaceCommandTool({
    rootPath: root,
    recipes: [{id: 'check-nul', executable: process.execPath, args: ['--version'], env: {VAR: 'a\0b'}}],
  }), {code: 'INVALID_ARGUMENT'});

  // 2. Merging options.env and recipe.env, verifying child receives only explicitly injected env
  process.env.PARENT_UNINJECTED_TEST_VAR = 'secret_leaked';
  t.after(() => delete process.env.PARENT_UNINJECTED_TEST_VAR);
  const tool = createWorkspaceCommandTool({
    rootPath: root,
    env: {GLOBAL_FLAG: 'global_value', OVERRIDE_ME: 'initial'},
    recipes: [{
      id: 'echo-env',
      executable: process.execPath,
      args: ['-e', 'process.stdout.write(JSON.stringify({gf: process.env.GLOBAL_FLAG, om: process.env.OVERRIDE_ME, rf: process.env.RECIPE_FLAG, leaked: process.env.PARENT_UNINJECTED_TEST_VAR}))'],
      env: {RECIPE_FLAG: 'recipe_value', OVERRIDE_ME: 'overridden'},
    }],
  });

  const res = await tool.execute({recipeId: 'echo-env'}, context());
  assert.equal(res.exitCode, 0);
  const data = JSON.parse(res.stdout);
  assert.equal(data.gf, 'global_value');
  assert.equal(data.om, 'overridden');
  assert.equal(data.rf, 'recipe_value');
  assert.equal(data.leaked, undefined); // No inherited process.env!
});

test('WindowsJobProcessHost terminates grandchild process tree on abort', {
  skip: process.platform !== 'win32' ? 'Windows only test' : false,
}, async t => {
  const root = await fixture(t);
  const jobHostExe = resolveJobHostExe();
  let jobHostFound = false;
  try {
    const s = statSync(jobHostExe);
    jobHostFound = s.isFile();
  } catch {}
  if (!jobHostFound) {
    t.skip('WindowsJobProcessHost.exe not compiled, skipping tree kill test');
    return;
  }

  const grandchildPidPath = join(root, 'grandchild.pid');
  const spawnerScript = join(root, 'spawner.cjs');
  await writeFile(spawnerScript, `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)', ${JSON.stringify(grandchildPidPath)}], {
      stdio: 'ignore',
      detached: false,
    });
    setInterval(() => {}, 1000);
  `);

  const treeTool = createWorkspaceCommandTool({
    rootPath: root,
    recipes: [{
      id: 'run-tree',
      executable: jobHostExe,
      args: ['--cwd', root, '--exe', process.execPath, '--', spawnerScript],
    }],
  });

  const controller = new AbortController();
  const execution = treeTool.execute({recipeId: 'run-tree'}, context({signal: controller.signal}));

  let grandchildPid;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      grandchildPid = Number(await readFile(grandchildPidPath, 'utf8'));
      if (grandchildPid > 0) break;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  assert.ok(Number.isSafeInteger(grandchildPid) && grandchildPid > 0, 'grandchild started');

  // Verify grandchild is currently alive
  assert.doesNotThrow(() => process.kill(grandchildPid, 0));

  // Abort execution: tool kills WindowsJobProcessHost -> Job Object terminates grandchild!
  controller.abort();
  await assert.rejects(execution, {code: 'CANCELLED'});

  // Wait briefly for Windows kernel to finish Job Object process tree termination
  let grandchildDied = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(grandchildPid, 0);
      await new Promise(resolve => setTimeout(resolve, 50));
    } catch (e) {
      if (e.code === 'ESRCH') {
        grandchildDied = true;
        break;
      }
    }
  }
  assert.ok(grandchildDied, 'grandchild process must be terminated by Job Object');
});

test('WindowsJobProcessHost runs fixed command successfully and returns complete output', {
  skip: process.platform !== 'win32' ? 'Windows only test' : false,
}, async t => {
  const root = await fixture(t);
  const jobHostExe = resolveJobHostExe();
  let jobHostFound = false;
  try {
    const s = statSync(jobHostExe);
    jobHostFound = s.isFile();
  } catch {}
  if (!jobHostFound) {
    t.skip('WindowsJobProcessHost.exe not compiled, skipping success test');
    return;
  }

  const pidPath = join(root, 'child-success.pid');
  const tool = createWorkspaceCommandTool({
    rootPath: root,
    recipes: [{
      id: 'job-success',
      executable: jobHostExe,
      args: ['--cwd', root, '--exe', process.execPath, '--', '-e', `
        require("node:fs").writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
        process.stdout.write("JOB_SUCCESS_MARKER\\n");
      `],
    }],
  });

  const res = await tool.execute({recipeId: 'job-success'}, context());
  assert.equal(res.recipeId, 'job-success');
  assert.equal(res.exitCode, 0);
  assert.equal(res.stdout, 'JOB_SUCCESS_MARKER\n');
  assert.equal(res.stderr, '');

  const childPid = Number(await readFile(pidPath, 'utf8'));
  assert.ok(Number.isSafeInteger(childPid) && childPid > 0);
  assert.throws(() => process.kill(childPid, 0), {code: 'ESRCH'});
});

test('WindowsJobProcessHost terminates grandchild process tree on deadline timeout', {
  skip: process.platform !== 'win32' ? 'Windows only test' : false,
}, async t => {
  const root = await fixture(t);
  const jobHostExe = resolveJobHostExe();
  let jobHostFound = false;
  try {
    const s = statSync(jobHostExe);
    jobHostFound = s.isFile();
  } catch {}
  if (!jobHostFound) {
    t.skip('WindowsJobProcessHost.exe not compiled, skipping timeout test');
    return;
  }

  const grandchildPidPath = join(root, 'grandchild-timeout.pid');
  const spawnerScript = join(root, 'spawner-timeout.cjs');
  await writeFile(spawnerScript, `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)', ${JSON.stringify(grandchildPidPath)}], {
      stdio: 'ignore',
      detached: false,
    });
    setInterval(() => {}, 1000);
  `);

  const treeTool = createWorkspaceCommandTool({
    rootPath: root,
    recipes: [{
      id: 'run-tree-timeout',
      executable: jobHostExe,
      args: ['--cwd', root, '--exe', process.execPath, '--', spawnerScript],
    }],
  });

  const execution = treeTool.execute({recipeId: 'run-tree-timeout'}, context({
    deadline: new Date(Date.now() + 300).toISOString(),
  }));

  let grandchildPid;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      grandchildPid = Number(await readFile(grandchildPidPath, 'utf8'));
      if (grandchildPid > 0) break;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  assert.ok(Number.isSafeInteger(grandchildPid) && grandchildPid > 0, 'grandchild started');

  assert.doesNotThrow(() => process.kill(grandchildPid, 0));

  await assert.rejects(execution, err => err.code === 'TIMEOUT' || err.code === 'RESULT_UNKNOWN');

  let grandchildDied = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(grandchildPid, 0);
      await new Promise(resolve => setTimeout(resolve, 50));
    } catch (e) {
      if (e.code === 'ESRCH') {
        grandchildDied = true;
        break;
      }
    }
  }
  assert.ok(grandchildDied, 'grandchild process must be terminated by Job Object after timeout');
});

test('WindowsJobProcessHost closes its job when the root exits, before draining inherited output', {
  skip: process.platform !== 'win32' ? 'Windows only test' : false,
}, async t => {
  const root = await fixture(t);
  const jobHostExe = resolveJobHostExe();
  if (!existsSync(jobHostExe)) {
    t.skip('WindowsJobProcessHost.exe not compiled');
    return;
  }
  const pidPath = join(root, 'inherited-output-child.pid');
  const tool = createWorkspaceCommandTool({rootPath: root, maxDurationMs: 5_000,
    recipes: [{id: 'root-exits', executable: jobHostExe,
      args: ['--cwd', root, '--exe', process.execPath, '--', '-e', `
        const {spawn} = require('node:child_process');
        const child = spawn(process.execPath, ['-e',
          'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => process.stdout.write(""), 1000)',
          process.argv[1]], {
          stdio: ['ignore', 'inherit', 'inherit'], detached: false,
        });
        child.unref();
        const ready = setInterval(() => {
          if (!require('node:fs').existsSync(process.argv[1])) return;
          clearInterval(ready);
          process.stdout.write('ROOT_EXITED\\n');
          process.exitCode = 7;
        }, 10);
      `, pidPath]}],
  });
  const result = await tool.execute({recipeId: 'root-exits'}, context());
  assert.deepEqual(result, {recipeId: 'root-exits', exitCode: 7,
    stdout: 'ROOT_EXITED\n', stderr: ''});
  const childPid = Number(await readFile(pidPath, 'utf8'));
  assert.ok(Number.isSafeInteger(childPid) && childPid > 0);
  assert.throws(() => process.kill(childPid, 0), {code: 'ESRCH'},
    'root completion must leave no child holding output pipes');
});
