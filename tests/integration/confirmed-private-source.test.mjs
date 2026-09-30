import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {openReadOnlyVault} from '@personal-agent/knowledge/filesystem';
import {openSqliteMemoryHost} from '@personal-agent/memory/sqlite';
import {ingestConfirmedPrivateCitation} from '@personal-agent/runtime/application';

const at = '2026-09-28T08:00:00.000Z';
const context = () => ({deadline: new Date(Date.now() + 60_000).toISOString(),
  signal: new AbortController().signal});

test('only an exact confirmed private citation persists and retries without another version', async t => {
  const base = await mkdtemp(join(tmpdir(), 'personal-agent-private-source-'));
  const vaultRoot = join(base, 'vault');
  const note = join(vaultRoot, 'note.md');
  await mkdir(vaultRoot);
  await writeFile(note, '# 合成笔记\n合成偏好：周一查看计划。\n', 'utf8');
  let memory = openSqliteMemoryHost(join(base, 'memory.sqlite'));
  t.after(async () => { memory.close(); await rm(base, {recursive: true, force: true}); });
  memory.provision('personal');
  const vault = await openReadOnlyVault({vaultId: 'selected-local-vault', rootPath: vaultRoot});
  const hit = (await vault.search({query: '合成偏好', limit: 1, ...context()})).hits[0];
  assert.ok(hit);
  const options = {
    vault, memory, namespace: 'personal', factId: 'weekly-plan', expectedRevision: null,
    source: hit.source, observedAt: at, validFrom: '2026-09-28T00:00:00.000Z',
    validUntil: '2027-09-28T00:00:00.000Z',
    confirm: async citation => {
      assert.equal(citation, '合成偏好：周一查看计划。');
      return {operationId: 'confirm-weekly-plan-1', summary: '周一查看计划'};
    },
  };
  assert.equal(await ingestConfirmedPrivateCitation({...options, factId: 'declined',
    confirm: async () => null}, context()), null);
  assert.equal((await memory.bind('personal', {allowedSensitivities: ['private']})
    .listCurrent({at, limit: 10, ...context()})).facts.length, 0);

  const first = await ingestConfirmedPrivateCitation(options, context());
  assert.equal(first.appended, true);
  assert.deepEqual(first.fact.ref, {id: 'weekly-plan', revision: 1});
  assert.equal(first.fact.sensitivity, 'private');
  assert.equal(first.fact.confirmation, 'user_confirmed');
  assert.equal((await memory.bind('personal', {allowedSensitivities: ['public']})
    .listCurrent({at, limit: 10, ...context()})).facts.length, 0);
  memory.close();
  memory = openSqliteMemoryHost(join(base, 'memory.sqlite'));
  assert.deepEqual(await ingestConfirmedPrivateCitation({...options, memory}, context()),
    {...first, appended: false});
  await assert.rejects(ingestConfirmedPrivateCitation({...options, memory,
    confirm: async () => ({operationId: 'confirm-weekly-plan-1', summary: 'Changed retry'})},
  context()), {code: 'REVISION_CONFLICT'});
  const revised = await ingestConfirmedPrivateCitation({...options, memory, expectedRevision: 1,
    confirm: async () => ({operationId: 'confirm-weekly-plan-2', summary: '周一先查看计划'})},
  context());
  assert.equal(revised.fact.ref.revision, 2);
  assert.equal((await memory.bind('personal', {allowedSensitivities: ['private']})
    .listCurrent({at, limit: 10, ...context()})).facts[0].summary, '周一先查看计划');

  await assert.rejects(ingestConfirmedPrivateCitation({...options, memory, factId: 'changed-note',
    confirm: async () => {
      await writeFile(note, '# 合成笔记\n合成偏好：周二查看计划。\n', 'utf8');
      return {operationId: 'confirm-changed-note', summary: '周一查看计划'};
    }}, context()), {code: 'SOURCE_CHANGED'});
  assert.equal((await memory.bind('personal', {allowedSensitivities: ['private']})
    .listCurrent({at, limit: 10, factId: 'changed-note', ...context()})).facts.length, 0);
});
