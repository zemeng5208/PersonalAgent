import assert from 'node:assert/strict';
import {copyFile, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {openReadOnlyVault} from '@personal-agent/knowledge/filesystem';
import {openSqliteMemoryHost} from '@personal-agent/memory/sqlite';
import {TaskRuntime} from '@personal-agent/runtime';
import {createMemoryProjectionApplication} from '@personal-agent/runtime/application';

function context() {
  return {deadline: new Date(Date.now() + 60_000).toISOString(),
    signal: new AbortController().signal};
}

test('opt-in public citation becomes a persisted Memory fact and exact Goal projection', async t => {
  const base = await mkdtemp(join(tmpdir(), 'personal-agent-public-memory-'));
  const demoRoot = fileURLToPath(new URL('../../docs/demo/knowledge/vault/', import.meta.url));
  const root = join(base, 'vault');
  await mkdir(root);
  await copyFile(join(demoRoot, 'starbridge.md'), join(root, 'starbridge.md'));
  const vault = await openReadOnlyVault({vaultId: 'public-demo-v1', rootPath: root});
  let memory = openSqliteMemoryHost(join(base, 'memory.sqlite'));
  let runtime = new TaskRuntime(join(base, 'runtime.sqlite'));
  t.after(async () => { memory.close(); runtime.close(); await rm(base, {recursive: true, force: true}); });

  const {hits, truncated} = await vault.search({query: '公开演示交付物', limit: 1, ...context()});
  assert.equal(truncated, false);
  assert.equal(hits.length, 1);
  const {source, excerpt} = hits[0];
  assert.deepEqual({vaultId: source.vaultId, path: source.path, line: source.line},
    {vaultId: 'public-demo-v1', path: 'starbridge.md', line: 5});
  assert.equal(excerpt, '公开演示交付物：带来源引用的一页摘要。');
  await assert.rejects(vault.readCitation({
    source: {...source, revision: '0'.repeat(64)}, ...context(),
  }), {code: 'SOURCE_CHANGED'});
  assert.equal(await vault.readCitation({source, ...context()}), excerpt);

  const namespace = 'competition-public-demo';
  const fact = {
    ref: {id: 'starbridge/public-deliverable', revision: 1},
    summary: excerpt,
    sourceRef: `${source.vaultId}/${source.path}#L${source.line}@${source.revision}`,
    observedAt: '2026-09-24T00:00:00.000Z',
    validFrom: '2026-09-24T00:00:00.000Z',
    validUntil: '2027-01-01T00:00:00.000Z',
    sensitivity: 'public',
    state: 'active',
    confirmation: 'external_observation',
  };
  memory.provision(namespace);
  assert.deepEqual(memory.append(namespace, fact), fact);
  assert.throws(() => memory.append(namespace, fact), {code: 'INVALID_ARGUMENT'});
  const query = memory.bind(namespace, {allowedSensitivities: ['public']});
  const projection = runtime.provisionFactProjectionStore('primary');
  const application = createMemoryProjectionApplication({
    consumerKey: 'public-demo-cognition', memoryNamespace: namespace,
    feed: memory.bindFeed(namespace, {
      consumerId: 'public-demo-cognition', allowedSensitivities: ['public'],
    }),
    memory: query, projection,
    confirmation: {confirm: request =>
      memory.confirmFeedBatch(namespace, 'public-demo-cognition', request)},
  });
  const result = await application.consume({limit: 10, ...context()});
  assert.equal(result.projection.graphRevision, 1);
  assert.equal(result.batch.entries.length, 1);
  assert.deepEqual(result.projection.links[0].fact, fact.ref);
  assert.equal(runtime.bindCoordinationStore('primary').read().history[0].sourceRef, fact.sourceRef);
  assert.equal(projection.readPending().length, 1);

  const firstContent = await readFile(join(root, 'starbridge.md'), 'utf8');
  const revisedContent = firstContent.replace('带来源引用的一页摘要。', '带修订来源引用的两页摘要。');
  assert.notEqual(revisedContent, firstContent);
  await writeFile(join(root, 'starbridge.md'), revisedContent, 'utf8');
  await assert.rejects(vault.readCitation({source, ...context()}), {code: 'SOURCE_CHANGED'});
  const revised = await vault.search({query: '公开演示交付物', limit: 1, ...context()});
  assert.equal(revised.hits.length, 1);
  const updated = revised.hits[0];
  assert.notEqual(updated.source.revision, source.revision);
  assert.equal(await vault.readCitation({source: updated.source, ...context()}), updated.excerpt);
  const correction = {
    ...fact, ref: {id: fact.ref.id, revision: 2},
    summary: updated.excerpt,
    sourceRef: `${updated.source.vaultId}/${updated.source.path}#L${updated.source.line}@${updated.source.revision}`,
    observedAt: '2026-09-25T00:00:00.000Z',
    corrects: fact.ref,
  };
  assert.deepEqual(memory.append(namespace, correction), correction);
  const second = await application.consume({limit: 10, ...context()});
  assert.equal(second.projection.graphRevision, 2);
  assert.deepEqual(second.projection.links[0].fact, correction.ref);
  assert.equal(second.projection.links[0].node.id, result.projection.links[0].node.id);
  assert.equal(projection.readPending().length, 2);

  memory.close();
  runtime.close();
  memory = openSqliteMemoryHost(join(base, 'memory.sqlite'));
  runtime = new TaskRuntime(join(base, 'runtime.sqlite'));
  assert.deepEqual(await memory.bind(namespace, {allowedSensitivities: ['public']})
    .getVersion({fact: fact.ref, ...context()}), fact);
  assert.deepEqual(await memory.bind(namespace, {allowedSensitivities: ['public']})
    .getVersion({fact: correction.ref, ...context()}), correction);
  assert.equal(runtime.bindCoordinationStore('primary').read().history.length, 2);
  assert.equal(runtime.bindFactProjectionStore('primary').readPending().length, 2);
});
