import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createRuntimeApplication} from '../dist/application.js';

const context = () => ({deadline: new Date(Date.now() + 60_000).toISOString(),
  signal: new AbortController().signal});

test('mutable caller inputs cannot redirect a bound Competition Fact host', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-agent-fact-scope-'));
  let app;
  const hosts = [];
  try {
    app = createRuntimeApplication({path: join(directory, 'runtime.sqlite'), profile: 'huawei_ict_agentarts'});
    const options = {memoryPath: join(directory, 'memory.sqlite'),
      memoryNamespace: 'synthetic-original', graphNamespace: 'synthetic-original-graph',
      consumerKey: 'synthetic-original-consumer'};
    const host = app.createCompetitionFactHost(options); hosts.push(host);
    const original = app.createCompetitionFactHost({...options}); hosts.push(original);
    const other = app.createCompetitionFactHost({...options,
      memoryNamespace: 'synthetic-other', graphNamespace: 'synthetic-other-graph',
      consumerKey: 'synthetic-other-consumer'}); hosts.push(other);
    const key = {vaultId: 'synthetic-vault', path: 'note.md', factId: 'synthetic-note'};
    const first = {...key, sourceRevision: 'a'.repeat(64), line: 1,
      summary: 'Synthetic original source', observedAt: '2026-09-25T00:00:00.000Z',
      validFrom: '2026-09-25T00:00:00.000Z', validUntil: '2027-01-01T00:00:00.000Z',
      expectedFactRevision: null};
    original.recordPublicSource(first, {...context(), factId: 'spoofed-note'});

    options.memoryNamespace = 'synthetic-other';
    options.graphNamespace = 'synthetic-other-graph';
    options.consumerKey = 'synthetic-other-consumer';
    assert.equal(host.readPublicSourceHead(key), 1);
    assert.equal(host.readPublicSourceHead({...key, factId: 'spoofed-note'}), null);
    assert.equal(host.recordPublicSource({...first, sourceRevision: 'b'.repeat(64),
      summary: 'Synthetic corrected source', expectedFactRevision: 1}, context()).fact.ref.revision, 2);
    assert.equal(original.readPublicSourceHead(key), 2);
    assert.equal(other.readPublicSourceHead(key), null);

    const withdrawn = host.withdrawPublicSource({...key, withdrawalId: 'synthetic-withdrawal',
      expectedFactRevision: 2, observedAt: '2026-09-25T01:00:00.000Z'},
    {...context(), factId: 'spoofed-note'});
    assert.equal(withdrawn.fact.state, 'withdrawn');
    assert.equal(original.readPublicSourceHead(key), 3);
    assert.equal(other.readPublicSourceHead(key), null);
    await host.drain({limit: 10, maxBatches: 5, ...context()});
    assert.ok(original.listImpactReceipts({afterGraphRevision: 0, limit: 10}).length > 0);
    assert.deepEqual(other.listImpactReceipts({afterGraphRevision: 0, limit: 10}), []);
  } finally {
    for (const host of hosts.reverse()) host.close();
    app?.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('trusted Competition host starts and resumes an authorized fact erasure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-agent-fact-erasure-host-'));
  let app;
  let host;
  try {
    app = createRuntimeApplication({path: join(directory, 'runtime.sqlite'),
      profile: 'huawei_ict_agentarts'});
    const options = {memoryPath: join(directory, 'memory.sqlite'),
      memoryNamespace: 'synthetic-user', graphNamespace: 'synthetic-user-graph',
      consumerKey: 'synthetic-user-consumer'};
    host = app.createCompetitionFactHost(options);
    const source = {vaultId: 'synthetic-vault', path: 'note.md', factId: 'synthetic-note',
      sourceRevision: 'a'.repeat(64), line: 1, summary: 'Synthetic fact',
      observedAt: '2026-09-25T00:00:00.000Z', validFrom: '2026-09-25T00:00:00.000Z',
      validUntil: '2027-01-01T00:00:00.000Z', expectedFactRevision: null};
    host.recordPublicSource(source, context());
    await host.drain({limit: 10, maxBatches: 2, ...context()});
    const erasure = {factId: source.factId, expectedRevision: 1,
      operationId: 'synthetic-erasure', ...context()};
    assert.throws(() => host.beginFactErasure({...erasure, memoryNamespace: 'other'}),
      {code: 'INVALID_ARGUMENT'});
    host.beginFactErasure(erasure);
    const inspection = await host.preflightErasure(source.factId, context());
    assert.equal(inspection.targetVersions, 1);
    await host.resumeFactErasure({...erasure,
      expectedGraphRevision: inspection.graphRevision});
    assert.equal(host.readPublicSourceHead({vaultId: source.vaultId,
      path: source.path, factId: source.factId}), null);
    assert.deepEqual(app.runtime.bindCoordinationStore(options.graphNamespace).read().history, []);
    host.beginFactErasure(erasure);
    await host.resumeFactErasure({...erasure,
      expectedGraphRevision: inspection.graphRevision});
  } finally {
    host?.close(); app?.close();
    await rm(directory, {recursive: true, force: true});
  }
});
