import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import {join, resolve, delimiter} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {openControlledVaultWriter, createKnowledgeWriteTool, KNOWLEDGE_WRITE_SCOPES} from '../dist/write.js';

const powerShellPath = process.env.PA_TEST_POWERSHELL ?? (process.env.PATH ?? '').split(delimiter)
  .map(directory => join(directory, 'pwsh.exe')).find(existsSync);
const windows = process.platform === 'win32' && Boolean(powerShellPath);
const digest = value => createHash('sha256').update(value).digest('hex');
const inputDigest = input => {
  const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
    : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
      : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return digest(canonical(input));
};
const original = '\uFEFF---\r\nowner: demo\r\n---\r\n# 公开合成笔记\r\n保留 [[来源]] 与 [文档](target.md)\r\n待整理段落\r\n';
async function fixture(t) {
  const parent = fileURLToPath(new URL('../../../data/test-tmp/', import.meta.url));
  await mkdir(parent, {recursive: true});
  const base = await mkdtemp(join(parent, 'knowledge-write-'));
  const root = join(base, 'vault'), recovery = join(base, 'recovery');
  await mkdir(root); await mkdir(recovery);
  await writeFile(join(root, 'demo.md'), original, 'utf8');
  t.after(() => rm(base, {recursive: true, force: true}));
  let enabled = true;
  const options = {rootPath: root, recoveryRootPath: recovery, powerShellPath, sourceId: 'synthetic',
    configRevision: 1, allowedNotePaths: ['demo.md'], bindingCurrent: () => enabled};
  const writer = openControlledVaultWriter(options);
  const input = {sourceId: 'synthetic', configRevision: 1, path: 'demo.md', expectedSha256: digest(original),
    edits: [{oldText: '待整理段落', newText: '已整理的合成段落'}]};
  const context = (overrides = {}) => ({taskId: 'task', runId: randomUUID(), authorizationRef: 'test-authorized',
    argumentsDigest: inputDigest(input), scopes: KNOWLEDGE_WRITE_SCOPES,
    deadline: new Date(Date.now() + 30000).toISOString(), signal: new AbortController().signal, ...overrides});
  return {root, recovery, writer, options, input, context, revoke: () => {enabled = false;}};
}

test('selected-note locked write preserves BOM/frontmatter/links and keeps a recoverable backup; replay cannot write', {skip: !windows}, async t => {
  const {root, recovery, writer, options, input, context} = await fixture(t);
  const authorized = context();
  const result = await createKnowledgeWriteTool(writer).execute(input, authorized);
  assert.equal(result.state, 'verified');
  assert.equal(await readFile(join(root, 'demo.md'), 'utf8'), original.replace('待整理段落', '已整理的合成段落'));
  assert.equal(await readFile(join(recovery, result.backupId), 'utf8'), original);
  assert.equal(digest(await readFile(join(root, 'demo.md'))), result.afterSha256);
  await assert.rejects(writer.apply(input, authorized), error => error.code === 'RESULT_UNKNOWN');
  await assert.rejects(openControlledVaultWriter(options).apply(input, authorized), error => error.code === 'RESULT_UNKNOWN');
  const reconciliation = await writer.reconcile({taskId: authorized.taskId, runId: authorized.runId,
    argumentsDigest: authorized.argumentsDigest}, authorized);
  assert.equal(reconciliation.state, 'applied');
  const reselected = openControlledVaultWriter({...options, sourceId: 'reselected', configRevision: 2});
  assert.equal((await reselected.reconcile({taskId: authorized.taskId, runId: authorized.runId,
    argumentsDigest: authorized.argumentsDigest}, authorized)).state, 'applied');
  assert.equal(JSON.stringify(result).includes(root), false);
});

test('baseline conflict preserves user edit and produces no backup or write', {skip: !windows}, async t => {
  const {root, recovery, writer, input, context} = await fixture(t);
  const edited = original + '用户刚刚修改\r\n';
  await writeFile(join(root, 'demo.md'), edited);
  await assert.rejects(writer.apply(input, context()), error => error.code === 'REVISION_CONFLICT');
  assert.equal(await readFile(join(root, 'demo.md'), 'utf8'), edited);
  assert.deepEqual(await readdir(recovery), []);
});

test('metadata, link removal, unselected paths and substituted source/revision fail before a write', {skip: !windows}, async t => {
  const {root, recovery, writer, input, context} = await fixture(t);
  for (const edits of [[{oldText: 'owner: demo', newText: 'owner: changed'}],
    [{oldText: '[[来源]]', newText: '来源'}], [{oldText: '[文档](target.md)', newText: '文档'}]]) {
    const changed = {...input, edits};
    await assert.rejects(writer.apply(changed, context({argumentsDigest: inputDigest(changed)})), error => error.code === 'SCOPE_DENIED');
  }
  for (const path of ['../outside.md', 'other.md', 'D:/outside.md']) {
    await assert.rejects(writer.apply({...input, path}, context()));
  }
  await assert.rejects(writer.apply({...input, configRevision: 2}, context()), error => error.code === 'REVISION_CONFLICT');
  await assert.rejects(writer.apply({...input, sourceId: 'other'}, context()), error => error.code === 'REVISION_CONFLICT');
  assert.equal(await readFile(join(root, 'demo.md'), 'utf8'), original);
  assert.deepEqual(await readdir(recovery), []);
});

test('revocation, missing scope, cancellation and deadline stop before helper dispatch', {skip: !windows}, async t => {
  const {root, recovery, writer, input, context, revoke} = await fixture(t);
  await assert.rejects(writer.apply(input, context({scopes: ['knowledge:write']})), error => error.code === 'SCOPE_DENIED');
  await assert.rejects(writer.apply(input, context({signal: AbortSignal.abort()})), error => error.code === 'CANCELLED');
  await assert.rejects(writer.apply(input, context({deadline: '2000-01-01T00:00:00.000Z'})), error => error.code === 'TIMEOUT');
  revoke(); await assert.rejects(writer.apply(input, context()), error => error.code === 'SCOPE_DENIED');
  assert.equal(await readFile(join(root, 'demo.md'), 'utf8'), original);
  assert.deepEqual(await readdir(recovery), []);
});

test('an interrupted durable operation requires readback; neither same-run nor another write repeats it', {skip: !windows}, async t => {
  const {root, recovery, writer, options, input, context} = await fixture(t);
  const controller = new AbortController();
  const authorized = context({signal: controller.signal});
  const operationId = digest(authorized.taskId + '\n' + authorized.runId);
  const timer = setInterval(() => {
    if (existsSync(join(recovery, operationId + '.knowledge-operation.json'))) controller.abort();
  }, 5);
  t.after(() => clearInterval(timer));
  await assert.rejects(writer.apply(input, authorized), error => ['RESULT_UNKNOWN', 'CANCELLED'].includes(error.code));
  clearInterval(timer);
  assert.equal(existsSync(join(recovery, operationId + '.knowledge-operation.json')), true);
  const restarted = openControlledVaultWriter(options);
  await assert.rejects(restarted.apply(input, context()), error => error.code === 'RESULT_UNKNOWN');
  const readback = await restarted.reconcile({taskId: authorized.taskId, runId: authorized.runId,
    argumentsDigest: authorized.argumentsDigest}, context());
  assert.ok(['applied', 'not_applied'].includes(readback.state));
  const source = await readFile(join(root, 'demo.md'), 'utf8');
  assert.equal(source, readback.state === 'applied' ? original.replace('待整理段落', '已整理的合成段落') : original);
  await assert.rejects(restarted.apply(input, context({...authorized, signal: new AbortController().signal})), error => error.code === 'RESULT_UNKNOWN');
});

test('a selected note replaced with a symlink cannot redirect a write', {skip: !windows}, async t => {
  const {root, recovery, writer, input, context} = await fixture(t);
  const outside = resolve(root, '..', 'outside.md'); await writeFile(outside, original);
  await rm(join(root, 'demo.md'));
  try {await symlink(outside, join(root, 'demo.md'), 'file');}
  catch (error) {if (error.code === 'EPERM') {t.skip('Windows file symlink privilege unavailable'); return;} throw error;}
  await assert.rejects(writer.apply(input, context()));
  assert.equal(await readFile(outside, 'utf8'), original);
  assert.deepEqual(await readdir(recovery), []);
});
