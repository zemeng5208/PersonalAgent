import assert from 'node:assert/strict';
import {copyFile, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {openReadOnlyVault} from '@personal-agent/knowledge/filesystem';
import {openSqliteMemoryHost} from '@personal-agent/memory/sqlite';
import {ingestPublicSource} from '@personal-agent/runtime/application';

test('explicit public Vault import is repeatable and persists exact source corrections', async t => {
  const base = await mkdtemp(join(tmpdir(), 'personal-agent-source-ingest-'));
  const vaultRoot = join(base, 'vault');
  const note = join(vaultRoot, 'starbridge.md');
  await mkdir(vaultRoot);
  await copyFile(fileURLToPath(new URL('../../docs/demo/knowledge/vault/starbridge.md', import.meta.url)), note);
  let memory = openSqliteMemoryHost(join(base, 'memory.sqlite'));
  t.after(async () => { memory.close(); await rm(base, {recursive: true, force: true}); });
  memory.provision('public-demo');
  const vault = await openReadOnlyVault({vaultId: 'public-demo-v1', rootPath: vaultRoot});
  const options = {
    vault, memory, namespace: 'public-demo', vaultId: 'public-demo-v1',
    path: 'starbridge.md', factId: 'starbridge/deliverable',
    query: '公开演示交付物', observedAt: '2026-09-24T00:00:00.000Z',
    validFrom: '2026-09-24T00:00:00.000Z', validUntil: '2027-01-01T00:00:00.000Z',
  };
  const context = () => ({deadline: new Date(Date.now() + 60_000).toISOString(),
    signal: new AbortController().signal});
  const first = await ingestPublicSource(options, context());
  assert.equal(first.appended, true);
  assert.deepEqual(first.fact.ref, {id: options.factId, revision: 1});
  assert.equal((await ingestPublicSource(options, context())).appended, false);

  const initial = await readFile(note, 'utf8');
  const revised = initial.replace('带来源引用的一页摘要。', '带修订来源引用的两页摘要。');
  assert.notEqual(revised, initial);
  await writeFile(note, revised, 'utf8');
  const second = await ingestPublicSource(options, context());
  assert.equal(second.appended, true);
  assert.deepEqual(second.fact.corrects, first.fact.ref);
  assert.notEqual(second.fact.sourceRef, first.fact.sourceRef);

  await assert.rejects(ingestPublicSource({...options, path: 'missing.md'}, context()),
    {code: 'SOURCE_UNAVAILABLE'});
  await assert.rejects(ingestPublicSource({...options, vault: {
    search: async () => ({hits: [{}, {}], truncated: false}),
    readCitation: vault.readCitation,
  }}, context()), {code: 'SOURCE_UNAVAILABLE'});
  assert.equal(memory.readPublicSourceHead('public-demo', {
    vaultId: options.vaultId, path: options.path, factId: options.factId,
  }), 2);
  memory.close();
  memory = openSqliteMemoryHost(join(base, 'memory.sqlite'));
  assert.equal((await ingestPublicSource({...options, memory}, context())).appended, false);
  const history = await memory.bind('public-demo', {allowedSensitivities: ['public']})
    .listHistory({factId: options.factId, limit: 10, ...context()});
  assert.deepEqual(history.facts.map(item => item.ref.revision), [1, 2]);
  await assert.rejects(ingestPublicSource({...options, memory, vault: {
    search: vault.search,
    readCitation: async request => {
      await writeFile(note, revised.replace('两页摘要', '三页摘要'), 'utf8');
      return vault.readCitation(request);
    },
  }}, context()), {code: 'SOURCE_CHANGED'});
  assert.equal(memory.readPublicSourceHead('public-demo', {
    vaultId: options.vaultId, path: options.path, factId: options.factId,
  }), 2);
});
