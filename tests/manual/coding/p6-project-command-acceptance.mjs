// Opt-in local Windows acceptance: synthetic project, real npm / Job / Policy /
// Runtime tools. No dependency installation, network call or user project access.
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@personal-agent/client';
import {createRuntimeApplication} from '@personal-agent/runtime/application';
import {createWorkspaceCommandTool, createWorkspaceListTool, createWorkspaceReadTool} from '@personal-agent/coding-tools';
import {createWorkspaceCommandRecipeTool} from '../../../apps/desktop/electron/workspace-command-recipes.js';

if (process.platform !== 'win32' || process.argv.length !== 4
  || !process.argv.slice(2).every(value => path.isAbsolute(value))) {
  throw Error('Windows only; pass trusted absolute Job helper and npm-cli.js paths');
}
const [jobHelperExecutable, npmCliPath] = process.argv.slice(2);
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const cache = path.join(repository, '.cache');
await mkdir(cache, {recursive: true});
const base = await mkdtemp(path.join(cache, 'p6-project-command-'));
const root = path.join(base, 'workspace');
await mkdir(root);
await mkdir(path.join(root, 'node_modules'));
const profile = path.join(base, 'profile');
await mkdir(profile);
const emptyConfig = path.join(base, 'empty.npmrc');
const globalConfig = path.join(base, 'empty-global.npmrc');
await writeFile(emptyConfig, '', {flag: 'wx'});
await writeFile(globalConfig, '', {flag: 'wx'});
await writeFile(path.join(root, '.npmrc'), [
  `userconfig=${emptyConfig.replaceAll('\\', '/')}`,
  `globalconfig=${globalConfig.replaceAll('\\', '/')}`,
  `cache=${path.join(base, 'npm-cache').replaceAll('\\', '/')}`,
  'offline=true', 'audit=false', 'fund=false', 'update-notifier=false', '',
].join('\n'), {flag: 'wx'});
await writeFile(path.join(root, 'package.json'), JSON.stringify({
  private: true, name: 'p6-synthetic-command', version: '1.0.0',
  scripts: {build: 'node build.cjs', test: 'node verify.cjs'},
}), {flag: 'wx'});
const content = 'P6_SYNTHETIC_BUILD_中文\r\n';
await writeFile(path.join(root, 'build.cjs'),
  `require('node:fs').writeFileSync('artifact.txt', ${JSON.stringify(content)});\n`, {flag: 'wx'});
await writeFile(path.join(root, 'verify.cjs'),
  `require('node:assert/strict').equal(require('node:fs').readFileSync('artifact.txt','utf8'), ${JSON.stringify(content)});\n`, {flag: 'wx'});
const nodeExecutable = process.execPath;
const recipe = createWorkspaceCommandRecipeTool({workspaceRoot: root,
  nodeExecutable, npmCliPath, jobHelperExecutable, allowProjectScripts: true,
  createWorkspaceCommandTool, projectScriptEnvSource: {
    SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec,
    PATH: `${path.dirname(nodeExecutable)};${path.join(process.env.SystemRoot, 'System32')}`,
    APPDATA: profile, LOCALAPPDATA: profile, TEMP: base, TMP: base,
    HOMEDRIVE: path.parse(profile).root.slice(0, 2), HOMEPATH: profile.slice(2),
  },
});
assert.equal(recipe.diagnostics.projectScriptsExposed, true);
assert.equal(recipe.available(), true);
const config = {path: path.join(base, 'runtime.sqlite'), profile: 'huawei_ict_agentarts',
  hostUserNamespace: 'p6-synthetic-project-command', tools: [recipe.tool,
    createWorkspaceReadTool({rootPath: root}), createWorkspaceListTool({rootPath: root})]};
const app = createRuntimeApplication(config);
const client = new Client(app, Date.now);
const receipts = [];
async function until(predicate) {
  const deadline = Date.now() + 30_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw Error('Synthetic command acceptance timed out');
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}
async function run(toolName, args) {
  const request = {commandId: randomUUID(), toolName, toolVersion: '1.0.0', arguments: args,
    deadline: new Date(Date.now() + 30_000).toISOString()};
  const {task} = app.submitHostToolTask(request);
  await until(() => app.runtime.getTask(task.taskId).state === 'waiting_approval');
  const pending = app.readHostToolTask(task.taskId);
  await client.call('authorization.respond', {approvalId: pending.approval.approvalId,
    expectedRevision: pending.approval.revision, decision: 'allow_once'});
  await until(() => ['succeeded', 'failed', 'cancelled', 'waiting_reconciliation']
    .includes(app.runtime.getTask(task.taskId).state));
  await until(() => app.activeTaskCount === 0);
  const result = app.readHostToolTask(task.taskId);
  receipts.push({taskId: task.taskId, toolName, state: result.task.state,
    ...(toolName === 'workspace.run_allowed_command' ? {exitCode: result.confirmed?.result?.exitCode} : {}),
    evidenceRefs: result.task.evidenceRefs,
    evidence: app.runtime.readEvidence(task.taskId).map(item => ({evidenceId: item.evidenceId, verification: item.verification})),
    executions: app.runtime.readToolExecutions(task.taskId).map(item => ({runId: item.evidenceId,
      state: item.state, executionStarted: item.executionStarted, inputDigest: item.inputDigest}))});
  assert.equal(result.task.state, 'succeeded');
  assert.ok(result.confirmed.evidenceRefs.length > 0);
  return result.confirmed.result;
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
try {
  await client.connect();
  const build = await run('workspace.run_allowed_command', {recipeId: 'npm-build'});
  assert.equal(build.exitCode, 0);
  const test = await run('workspace.run_allowed_command', {recipeId: 'npm-test'});
  assert.equal(test.exitCode, 0);
  const readback = await run('workspace.read_text', {path: 'artifact.txt'});
  const bytes = await readFile(path.join(root, 'artifact.txt'));
  assert.equal(readback.content, content);
  assert.equal(readback.sha256, sha(bytes));
  const listed = await run('workspace.list_entries', {path: '.', limit: 20});
  assert.ok(listed.entries.some(entry => entry.name === 'artifact.txt' && entry.kind === 'file'));
  const report = {profile: 'huawei_ict_agentarts', verification: 'conditional',
    realLocalExecution: true, syntheticProject: true, dependencyInstallPerformed: false,
    cloudVerified: false, desktopVerified: false, nativeDeviceVerified: false,
    sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: repository, encoding: 'utf8', windowsHide: true}).trim(),
    nodeVersion: process.version, buildExitCode: build.exitCode, testExitCode: test.exitCode,
    artifactSha256: sha(bytes), listConfirmed: true, receipts,
    reusedArtifacts: {
      helperExeSha256: sha(await readFile(jobHelperExecutable)),
      npmCliSha256: sha(await readFile(npmCliPath)),
      runtimeApplicationSha256: sha(await readFile(path.join(repository, 'apps/runtime/dist/application.js'))),
    },
    limitation: 'Existing local compiled Runtime reused; no claim of latest shared assembly or Electron acceptance.',
  };
  await writeFile(path.join(base, 'receipt.json'), `${JSON.stringify(report, null, 2)}\n`, {flag: 'wx'});
  console.log(`PASS: ${path.basename(base)}/receipt.json`);
} catch (error) {
  await writeFile(path.join(base, 'failure.json'), JSON.stringify({state: 'failed', receipts,
    code: typeof error?.code === 'string' ? error.code : 'ACCEPTANCE_FAILED'}), {flag: 'wx'});
  throw error;
} finally {
  await until(() => app.activeTaskCount === 0);
  await app.close();
}
