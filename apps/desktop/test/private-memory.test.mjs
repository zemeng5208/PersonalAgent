import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {openSqliteMemoryHost} from '@personal-agent/memory/sqlite';
import {createPrivateMemoryController} from '../electron/private-memory.js';

test('admin confirmation is required for each private citation and correction', async t => {
  const base = await mkdtemp(join(tmpdir(), 'personal-agent-private-admin-'));
  const root = join(base, 'vault');
  const file = join(root, 'note.md');
  const database = join(base, 'private.sqlite');
  await mkdir(root);
  await writeFile(file, '合成偏好：周一查看计划。\n', 'utf8');
  let allow = false;
  const prompts = [];
  let controller = createPrivateMemoryController(database, async details => {
    prompts.push(details);
    return allow;
  });
  t.after(async () => { controller.close(); await rm(base, {recursive: true, force: true}); });

  assert.throws(() => controller.search('合成偏好'), /选择本机 Vault/);
  await controller.selectVault(root);
  const source = (await controller.search('合成偏好')).hits[0].source;
  assert.deepEqual(await controller.save(source, '周一查看计划'), {state: 'declined'});
  const memory = openSqliteMemoryHost(database);
  const query = context => memory.bind('desktop-private', {allowedSensitivities: ['private']})
    .listCurrent({at: new Date().toISOString(), limit: 5, ...context});
  const context = () => ({deadline: new Date(Date.now() + 60_000).toISOString(),
    signal: new AbortController().signal});
  assert.equal((await query(context())).facts.length, 0);
  allow = true;
  assert.deepEqual(await controller.save(source, '周一查看计划'), {state: 'saved', revision: 1});
  assert.equal((await query(context())).facts[0].summary, '周一查看计划');
  assert.equal((await memory.bind('desktop-private', {allowedSensitivities: ['public']})
    .listCurrent({at: new Date().toISOString(), limit: 5, ...context()})).facts.length, 0);
  assert.deepEqual(await controller.save(source, '周一查看计划'), {state: 'unchanged', revision: 1});
  assert.deepEqual(await controller.save(source, '周一先查看计划'), {state: 'saved', revision: 2});
  assert.equal(prompts.length, 3);
  assert.equal(prompts[2].previous, '周一查看计划');
  assert.equal((await query(context())).facts[0].summary, '周一先查看计划');
  memory.close();

  controller.close();
  controller = createPrivateMemoryController(database, async () => false);
  await controller.selectVault(root);
  assert.deepEqual(await controller.save(source, '周一先查看计划'), {state: 'unchanged', revision: 2});
  await writeFile(file, '合成偏好：周二查看计划。\n', 'utf8');
  await assert.rejects(controller.save(source, '周二查看计划'), {code: 'SOURCE_CHANGED'});
  await assert.rejects(controller.save(source, '周一先查看计划'), {code: 'SOURCE_CHANGED'});
  const reopened = openSqliteMemoryHost(database);
  assert.equal((await reopened.bind('desktop-private', {allowedSensitivities: ['private']})
    .listCurrent({at: new Date().toISOString(), limit: 5, ...context()})).facts[0].ref.revision, 2);
  reopened.close();
});
