import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {FactChangeFeedError, MemoryQueryError} from '../dist/index.js';
import {openSqliteMemoryHost} from '../dist/sqlite.js';

const deadline = '2099-01-01T00:00:00.000Z';
const at = '2026-09-22T08:00:00.000Z';

function request(extra = {}) {
  return {deadline, signal: new AbortController().signal, ...extra};
}

function version(id, revision, options = {}) {
  return {
    ref: {id, revision},
    summary: options.summary ?? `${id}-v${revision}`,
    sourceRef: options.sourceRef ?? 'test-source',
    observedAt: '2026-09-22T07:00:00.000Z',
    validFrom: '2026-09-22T00:00:00.000Z',
    validUntil: '2027-09-22T00:00:00.000Z',
    sensitivity: options.sensitivity ?? 'public',
    state: options.state ?? 'active',
    confirmation: 'user_confirmed',
    ...(revision === 1 ? {} : {corrects: {id, revision: revision - 1}}),
  };
}

function databasePath(t) {
  const directory = mkdtempSync(join(tmpdir(), 'personal-agent-memory-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  return join(directory, 'memory.sqlite');
}

test('SQLite memory keeps immutable facts and query snapshots across restart', async t => {
  const path = databasePath(t);
  let host = openSqliteMemoryHost(path);
  host.provision('personal');
  host.append('personal', version('a', 1));
  host.append('personal', version('b', 1));
  host.append('personal', version('c', 1));

  let memory = host.bind('personal', {allowedSensitivities: ['public']});
  const first = await memory.listCurrent(request({at, limit: 1}));
  assert.deepEqual(first.facts.map(item => item.ref.id), ['a']);
  assert.ok(first.nextCursor);

  host.append('personal', version('d', 1));
  assert.throws(
    () => host.append('personal', version('a', 1)),
    error => error instanceof MemoryQueryError && error.code === 'INVALID_ARGUMENT',
  );
  host.append('personal', version('a', 2, {summary: 'a corrected'}));
  host.close();

  host = openSqliteMemoryHost(path);
  memory = host.bind('personal', {allowedSensitivities: ['public']});
  const second = await memory.listCurrent(request({
    at,
    limit: 1,
    snapshot: first.snapshot,
    cursor: first.nextCursor,
  }));
  assert.deepEqual(second.facts.map(item => item.ref.id), ['b']);
  assert.ok(second.nextCursor);
  const third = await memory.listCurrent(request({
    at,
    limit: 1,
    snapshot: second.snapshot,
    cursor: second.nextCursor,
  }));
  assert.deepEqual(third.facts.map(item => item.ref.id), ['c']);
  assert.equal(third.nextCursor, undefined);

  const fresh = await memory.listCurrent(request({at, limit: 10}));
  assert.deepEqual(fresh.facts.map(item => item.ref.id), ['a', 'b', 'c', 'd']);
  assert.equal((await memory.getVersion(request({fact: {id: 'a', revision: 1}}))).summary, 'a-v1');
  const history = await memory.listHistory(request({factId: 'a', limit: 10}));
  assert.deepEqual(history.facts.map(item => item.ref), [
    {id: 'a', revision: 1},
    {id: 'a', revision: 2},
  ]);
  host.close();
});

test('host erases every version of an unbound fact and invalidates old query pages', async t => {
  const path = databasePath(t);
  let host = openSqliteMemoryHost(path);
  host.provision('personal');
  host.provision('other');
  host.append('personal', version('remove-me', 1));
  host.append('personal', version('keep-me', 1));
  host.append('personal', version('remove-me', 2));
  host.append('other', version('remove-me', 1));
  let memory = host.bind('personal', {allowedSensitivities: ['public']});
  const page = await memory.listCurrent(request({at, limit: 1}));
  assert.ok(page.nextCursor);
  const unrelated = await memory.listCurrent(request({at, limit: 10, factId: 'keep-me'}));

  assert.throws(() => host.eraseUnboundFact('personal', request({
    factId: 'remove-me', expectedRevision: 1, operationId: 'erase-stale',
  })), {code: 'REVISION_CONFLICT'});
  const cancelled = new AbortController();
  cancelled.abort();
  assert.throws(() => host.eraseUnboundFact('personal', request({
    factId: 'remove-me', expectedRevision: 2, operationId: 'erase-cancelled', signal: cancelled.signal,
  })), {code: 'CANCELLED'});
  host.eraseUnboundFact('personal', request({
    factId: 'remove-me', expectedRevision: 2, operationId: 'erase-unbound',
  }));
  await assert.rejects(memory.listCurrent(request({
    at, limit: 1, snapshot: page.snapshot, cursor: page.nextCursor,
  })), {code: 'INVALID_ARGUMENT'});
  assert.deepEqual((await memory.listCurrent(request({
    at, limit: 10, factId: 'keep-me', snapshot: unrelated.snapshot,
  }))).facts.map(f => f.ref.id), ['keep-me']);
  assert.deepEqual((await memory.listHistory(request({factId: 'remove-me', limit: 10}))).facts, []);
  assert.deepEqual((await memory.listCurrent(request({at, limit: 10}))).facts.map(f => f.ref.id), ['keep-me']);
  assert.deepEqual((await host.bind('other', {allowedSensitivities: ['public']})
    .listCurrent(request({at, limit: 10}))).facts.map(f => f.ref.id), ['remove-me']);
  host.close();

  const db = new DatabaseSync(path);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM memory_facts WHERE namespace = ? AND fact_id = ?')
    .get('personal', 'remove-me').count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM memory_query_snapshots WHERE token = ?')
    .get(page.snapshot).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM memory_query_snapshots WHERE token = ?')
    .get(unrelated.snapshot).count, 1);
  db.close();

  host = openSqliteMemoryHost(path);
  memory = host.bind('personal', {allowedSensitivities: ['public']});
  assert.deepEqual((await memory.listCurrent(request({at, limit: 10}))).facts.map(f => f.ref.id), ['keep-me']);
  assert.throws(() => host.append('personal', version('remove-me', 1)), {code: 'SCOPE_DENIED'});
  assert.doesNotThrow(() => host.eraseUnboundFact('personal', request({
    factId: 'remove-me', expectedRevision: 2, operationId: 'erase-unbound',
  })));
  assert.throws(() => host.eraseUnboundFact('personal', request({
    factId: 'remove-me', expectedRevision: 2, operationId: 'other-operation',
  })), {code: 'REVISION_CONFLICT'});
  host.close();
});

test('host refuses to erase a fact after any downstream feed has been bound', async t => {
  const path = databasePath(t);
  const host = openSqliteMemoryHost(path);
  host.provision('personal');
  host.append('personal', version('a', 1));
  host.bindFeed('personal', {consumerId: 'cognition', allowedSensitivities: ['public']});
  assert.throws(() => host.eraseUnboundFact('personal', request({
    factId: 'a', expectedRevision: 1, operationId: 'bound-denied',
  })),
    {code: 'SCOPE_DENIED'});
  const memory = host.bind('personal', {allowedSensitivities: ['public']});
  assert.equal((await memory.getVersion(request({fact: {id: 'a', revision: 1}}))).summary, 'a-v1');
  host.close();
});

test('SQLite feed replays pending batches and confirmations across restart', async t => {
  const path = databasePath(t);
  let host = openSqliteMemoryHost(path);
  host.provision('personal');
  host.append('personal', version('a', 1));
  host.append('personal', version('b', 1));

  let feed = host.bindFeed('personal', {
    consumerId: 'cognition',
    allowedSensitivities: ['public'],
  });
  const first = await feed.read(request({limit: 1}));
  assert.equal(first.mode, 'bootstrap');
  assert.equal(first.entries.length, 1);
  host.close();

  host = openSqliteMemoryHost(path);
  feed = host.bindFeed('personal', {
    consumerId: 'cognition',
    allowedSensitivities: ['public'],
  });
  assert.deepEqual(await feed.read(request({limit: 1})), first);
  assert.throws(
    () => host.confirmFeedBatch('personal', 'cognition', request({
      batchToken: first.batchToken,
      expectedCheckpoint: 'wrong-checkpoint',
      handled: first.entries,
    })),
    error => error instanceof FactChangeFeedError && error.code === 'REVISION_CONFLICT',
  );
  assert.throws(
    () => host.confirmFeedBatch('personal', 'cognition', request({
      batchToken: first.batchToken,
      expectedCheckpoint: first.baseCheckpoint,
      handled: [],
    })),
    error => error instanceof FactChangeFeedError && error.code === 'INVALID_ARGUMENT',
  );
  assert.deepEqual(await feed.read(request({limit: 1})), first);
  const firstReceipt = host.confirmFeedBatch('personal', 'cognition', request({
    batchToken: first.batchToken,
    expectedCheckpoint: first.baseCheckpoint,
    handled: first.entries,
  }));
  host.close();

  host = openSqliteMemoryHost(path);
  feed = host.bindFeed('personal', {
    consumerId: 'cognition',
    allowedSensitivities: ['public'],
  });
  assert.deepEqual(host.confirmFeedBatch('personal', 'cognition', request({
    batchToken: first.batchToken,
    expectedCheckpoint: first.baseCheckpoint,
    handled: first.entries,
  })), firstReceipt);

  const second = await feed.read(request({limit: 1}));
  assert.equal(second.mode, 'bootstrap');
  assert.equal(second.atWatermark, true);
  host.confirmFeedBatch('personal', 'cognition', request({
    batchToken: second.batchToken,
    expectedCheckpoint: second.baseCheckpoint,
    handled: second.entries,
  }));

  host.append('personal', version('a', 2, {summary: 'a corrected'}));
  const change = await feed.read(request({limit: 10}));
  assert.equal(change.mode, 'changes');
  assert.deepEqual(change.entries.map(entry => entry.fact), [{id: 'a', revision: 2}]);
  host.close();

  host = openSqliteMemoryHost(path);
  feed = host.bindFeed('personal', {
    consumerId: 'cognition',
    allowedSensitivities: ['public'],
  });
  assert.deepEqual(await feed.read(request({limit: 10})), change);
  host.confirmFeedBatch('personal', 'cognition', request({
    batchToken: change.batchToken,
    expectedCheckpoint: change.baseCheckpoint,
    handled: change.entries,
  }));
  host.close();
});

test('a durable feed delivery can contain a target fact and an unrelated fact together', async t => {
  const path = databasePath(t);
  let host = openSqliteMemoryHost(path);
  host.provision('personal');
  host.append('personal', version('erase-target', 1));
  host.append('personal', version('keep-other', 1));
  let feed = host.bindFeed('personal', {
    consumerId: 'cognition', allowedSensitivities: ['public'],
  });
  const batch = await feed.read(request({limit: 10}));
  assert.deepEqual(batch.entries.map(entry => entry.fact.id), ['erase-target', 'keep-other']);
  host.close();

  host = openSqliteMemoryHost(path);
  feed = host.bindFeed('personal', {
    consumerId: 'cognition', allowedSensitivities: ['public'],
  });
  assert.deepEqual(await feed.read(request({limit: 10})), batch);
  host.confirmFeedBatch('personal', 'cognition', request({
    batchToken: batch.batchToken, expectedCheckpoint: batch.baseCheckpoint,
    handled: batch.entries,
  }));
  host.close();
});

test('erasure intent hides one fact and preserves an unrelated entry in the same pending batch', async t => {
  const path = databasePath(t);
  let host = openSqliteMemoryHost(path);
  host.provision('personal');
  host.provision('other');
  host.append('personal', version('erase-target', 1));
  host.append('personal', version('keep-other', 1));
  host.append('other', version('erase-target', 1));
  let memory = host.bind('personal', {allowedSensitivities: ['public']});
  const broadPage = await memory.listCurrent(request({at, limit: 10}));
  const targetPage = await memory.listCurrent(request({at, limit: 10, factId: 'erase-target'}));
  const otherPage = await memory.listCurrent(request({at, limit: 10, factId: 'keep-other'}));
  let feed = host.bindFeed('personal', {
    consumerId: 'cognition', allowedSensitivities: ['public'],
  });
  const original = await feed.read(request({limit: 10}));
  assert.throws(() => host.beginFactErasure('personal', request({
    factId: 'erase-target', expectedRevision: 2, operationId: 'stale',
  })), {code: 'REVISION_CONFLICT'});
  const cancelled = new AbortController();
  cancelled.abort();
  assert.throws(() => host.beginFactErasure('personal', request({
    factId: 'erase-target', expectedRevision: 1, operationId: 'cancelled', signal: cancelled.signal,
  })), {code: 'CANCELLED'});
  assert.deepEqual(await feed.read(request({limit: 10})), original);
  host.beginFactErasure('personal', request({
    factId: 'erase-target', expectedRevision: 1, operationId: 'erase-1',
  }));
  assert.deepEqual(host.readFeedDelivery('personal', 'cognition', request({
    batchToken: original.batchToken,
  })).entries.map(entry => entry.fact.id), ['keep-other']);
  assert.throws(() => host.readFeedDelivery('personal', 'other-consumer', request({
    batchToken: original.batchToken,
  })), {code: 'SCOPE_DENIED'});
  assert.deepEqual((await feed.read(request({limit: 10}))).entries.map(entry => entry.fact.id), ['keep-other']);
  assert.throws(() => host.confirmFeedBatch('personal', 'cognition', request({
    batchToken: original.batchToken, expectedCheckpoint: original.baseCheckpoint,
    handled: original.entries,
  })), {code: 'INVALID_ARGUMENT'});
  const revised = await feed.read(request({limit: 10}));
  host.confirmFeedBatch('personal', 'cognition', request({
    batchToken: revised.batchToken, expectedCheckpoint: revised.baseCheckpoint,
    handled: revised.entries,
  }));
  await assert.rejects(memory.listCurrent(request({
    at, limit: 10, factId: 'erase-target', snapshot: targetPage.snapshot,
  })), {code: 'INVALID_ARGUMENT'});
  await assert.rejects(memory.listCurrent(request({
    at, limit: 10, snapshot: broadPage.snapshot,
  })), {code: 'INVALID_ARGUMENT'});
  assert.deepEqual((await memory.listCurrent(request({
    at, limit: 10, factId: 'keep-other', snapshot: otherPage.snapshot,
  }))).facts.map(fact => fact.ref.id), ['keep-other']);
  assert.deepEqual((await host.bind('other', {allowedSensitivities: ['public']})
    .listCurrent(request({at, limit: 10}))).facts.map(fact => fact.ref.id), ['erase-target']);
  await assert.rejects(memory.getVersion(request({fact: {id: 'erase-target', revision: 1}})),
    {code: 'SCOPE_DENIED'});
  host.close();

  host = openSqliteMemoryHost(path);
  memory = host.bind('personal', {allowedSensitivities: ['public']});
  assert.deepEqual((await memory.listCurrent(request({at, limit: 10}))).facts.map(fact => fact.ref.id),
    ['keep-other']);
  assert.deepEqual((await memory.listHistory(request({factId: 'erase-target', limit: 10}))).facts, []);
  assert.doesNotThrow(() => host.beginFactErasure('personal', request({
    factId: 'erase-target', expectedRevision: 1, operationId: 'erase-1',
  })));
  host.close();
});

test('erasure intent keeps a source-filtered snapshot made before the target existed', async t => {
  const host = openSqliteMemoryHost(databasePath(t));
  host.provision('personal');
  host.append('personal', version('keep-other', 1));
  const memory = host.bind('personal', {allowedSensitivities: ['public']});
  const page = await memory.listCurrent(request({at, limit: 10, sourceRef: 'test-source'}));
  host.append('personal', version('erase-target', 1));
  host.beginFactErasure('personal', request({
    factId: 'erase-target', expectedRevision: 1, operationId: 'erase-after-snapshot',
  }));
  assert.deepEqual((await memory.listCurrent(request({
    at, limit: 10, sourceRef: 'test-source', snapshot: page.snapshot,
  }))).facts.map(fact => fact.ref.id), ['keep-other']);
  host.close();
});

test('erasure intent rebases a partly consumed bootstrap without skipping its other fact', async t => {
  const path = databasePath(t);
  const host = openSqliteMemoryHost(path);
  host.provision('personal');
  host.append('personal', version('a-before', 1));
  host.append('personal', version('b-target', 1));
  host.append('personal', version('c-after', 1));
  const feed = host.bindFeed('personal', {
    consumerId: 'cognition', allowedSensitivities: ['public'],
  });
  const first = await feed.read(request({limit: 1}));
  host.confirmFeedBatch('personal', 'cognition', request({
    batchToken: first.batchToken, expectedCheckpoint: first.baseCheckpoint,
    handled: first.entries,
  }));
  const mixed = await feed.read(request({limit: 2}));
  assert.deepEqual(mixed.entries.map(entry => entry.fact.id), ['b-target', 'c-after']);
  host.beginFactErasure('personal', request({
    factId: 'b-target', expectedRevision: 1, operationId: 'erase-bootstrap',
  }));
  const revised = await feed.read(request({limit: 2}));
  assert.deepEqual(revised.entries.map(entry => entry.fact.id), ['c-after']);
  assert.equal(revised.atWatermark, true);
  host.confirmFeedBatch('personal', 'cognition', request({
    batchToken: revised.batchToken, expectedCheckpoint: revised.baseCheckpoint,
    handled: revised.entries,
  }));
  assert.equal((await feed.read(request({limit: 10}))).mode, 'changes');
  host.close();
});

test('erasure intent rewrites confirmed and changes batches without losing an unrelated event', async t => {
  const path = databasePath(t);
  const host = openSqliteMemoryHost(path);
  host.provision('personal');
  host.append('personal', version('erase-target', 1));
  host.append('personal', version('keep-other', 1));
  const feed = host.bindFeed('personal', {
    consumerId: 'cognition', allowedSensitivities: ['public'],
  });
  const bootstrap = await feed.read(request({limit: 10}));
  const receipt = host.confirmFeedBatch('personal', 'cognition', request({
    batchToken: bootstrap.batchToken, expectedCheckpoint: bootstrap.baseCheckpoint,
    handled: bootstrap.entries,
  }));
  host.append('personal', version('erase-target', 2));
  host.append('personal', version('keep-other', 2));
  const changes = await feed.read(request({limit: 10}));
  assert.deepEqual(changes.entries.map(entry => entry.fact.id), ['erase-target', 'keep-other']);

  host.beginFactErasure('personal', request({
    factId: 'erase-target', expectedRevision: 2, operationId: 'erase-changes',
  }));
  assert.throws(() => host.confirmFeedBatch('personal', 'cognition', request({
    batchToken: bootstrap.batchToken, expectedCheckpoint: bootstrap.baseCheckpoint,
    handled: bootstrap.entries,
  })), {code: 'INVALID_ARGUMENT'});
  assert.deepEqual(host.confirmFeedBatch('personal', 'cognition', request({
    batchToken: bootstrap.batchToken, expectedCheckpoint: bootstrap.baseCheckpoint,
    handled: bootstrap.entries.filter(entry => entry.fact.id !== 'erase-target'),
  })), receipt);
  const revised = await feed.read(request({limit: 10}));
  assert.deepEqual(revised.entries.map(entry => entry.fact.id), ['keep-other']);
  assert.throws(() => host.confirmFeedBatch('personal', 'cognition', request({
    batchToken: changes.batchToken, expectedCheckpoint: changes.baseCheckpoint,
    handled: changes.entries,
  })), {code: 'INVALID_ARGUMENT'});
  host.confirmFeedBatch('personal', 'cognition', request({
    batchToken: revised.batchToken, expectedCheckpoint: revised.baseCheckpoint,
    handled: revised.entries,
  }));
  assert.deepEqual((await feed.read(request({limit: 10}))).entries, []);
  host.close();
});

test('host-only completion purges every target version and refuses a stale mixed delivery', async t => {
  const path = databasePath(t);
  const host = openSqliteMemoryHost(path);
  host.provision('personal');
  host.append('personal', version('erase-target', 1));
  host.append('personal', version('erase-target', 2));
  host.append('personal', version('keep-other', 1));
  const feed = host.bindFeed('personal', {consumerId: 'cognition', allowedSensitivities: ['public']});
  const original = await feed.read(request({limit: 10}));
  host.beginFactErasure('personal', request({factId: 'erase-target', expectedRevision: 2,
    operationId: 'synthetic-completion'}));
  const revised = host.readFeedDelivery('personal', 'cognition', request({batchToken: original.batchToken}));
  const completion = request({factId: 'erase-target', expectedRevision: 2,
    operationId: 'synthetic-completion', runtimeReceipt: {graphNamespace: 'synthetic-graph',
      memoryNamespace: 'personal', factId: 'erase-target', operationId: 'synthetic-completion',
      expectedGraphRevision: 1, committedAt: at}});
  const db = new DatabaseSync(path);
  try {
    assert.throws(() => host.completeFactErasure('personal', {...completion,
      runtimeReceipt: {...completion.runtimeReceipt, operationId: 'wrong'}}),
    {code: 'INVALID_ARGUMENT'});
    db.prepare('UPDATE memory_feed_deliveries SET batch_json = ? WHERE batch_token = ?')
      .run(JSON.stringify(original), original.batchToken);
    assert.throws(() => host.completeFactErasure('personal', completion), {code: 'SCOPE_DENIED'});
    assert.equal(db.prepare('SELECT count(*) AS total FROM memory_facts WHERE namespace = ? AND fact_id = ?')
      .get('personal', 'erase-target').total, 2);
    db.prepare('UPDATE memory_feed_deliveries SET batch_json = ? WHERE batch_token = ?')
      .run(JSON.stringify(revised), original.batchToken);
    host.completeFactErasure('personal', completion);
    host.completeFactErasure('personal', completion);
    assert.deepEqual(db.prepare('SELECT fact_id FROM memory_facts WHERE namespace = ? ORDER BY fact_id')
      .all('personal').map(row => row.fact_id), ['keep-other']);
    assert.equal(db.prepare('SELECT phase FROM memory_erasure_intents WHERE namespace = ? AND fact_id = ?')
      .get('personal', 'erase-target').phase, 'completed');
    assert.deepEqual(host.readFeedDelivery('personal', 'cognition',
      request({batchToken: original.batchToken})).entries.map(entry => entry.fact.id), ['keep-other']);
  } finally {
    db.close();
    host.close();
  }
});

test('a busy WAL checkpoint keeps the completed purge retryable', t => {
  const path = databasePath(t);
  const host = openSqliteMemoryHost(path);
  const reader = new DatabaseSync(path);
  let reading = false;
  try {
    host.provision('personal');
    host.append('personal', version('erase-target', 1));
    host.beginFactErasure('personal', request({factId: 'erase-target', expectedRevision: 1,
      operationId: 'synthetic-wal-retry'}));
    const completion = request({factId: 'erase-target', expectedRevision: 1,
      operationId: 'synthetic-wal-retry', runtimeReceipt: {graphNamespace: 'synthetic-graph',
        memoryNamespace: 'personal', factId: 'erase-target', operationId: 'synthetic-wal-retry',
        expectedGraphRevision: 1, committedAt: at}});
    reader.exec('BEGIN');
    reading = true;
    assert.equal(reader.prepare('SELECT count(*) AS total FROM memory_facts WHERE namespace = ?')
      .get('personal').total, 1);
    assert.throws(() => host.completeFactErasure('personal', completion),
      {code: 'STORAGE_UNAVAILABLE'});
    reader.exec('ROLLBACK');
    reading = false;
    assert.equal(reader.prepare('SELECT phase FROM memory_erasure_intents WHERE namespace = ? AND fact_id = ?')
      .get('personal', 'erase-target').phase, 'completed');
    assert.equal(reader.prepare('SELECT count(*) AS total FROM memory_facts WHERE namespace = ? AND fact_id = ?')
      .get('personal', 'erase-target').total, 0);
    assert.doesNotThrow(() => host.completeFactErasure('personal', completion));
  } finally {
    if (reading) reader.exec('ROLLBACK');
    reader.close();
    host.close();
  }
});

test('SQLite feed invalidates a binding when a visible fact becomes hidden', async t => {
  const path = databasePath(t);
  const host = openSqliteMemoryHost(path);
  host.provision('personal');
  host.append('personal', version('a', 1));

  const feed = host.bindFeed('personal', {
    consumerId: 'public-view',
    allowedSensitivities: ['public'],
  });
  const pending = await feed.read(request({limit: 10}));
  host.append('personal', version('a', 2, {sensitivity: 'restricted'}));

  await assert.rejects(
    feed.read(request({limit: 10})),
    error => error instanceof FactChangeFeedError && error.code === 'REBUILD_REQUIRED',
  );
  assert.throws(
    () => host.confirmFeedBatch('personal', 'public-view', request({
      batchToken: pending.batchToken,
      expectedCheckpoint: pending.baseCheckpoint,
      handled: pending.entries,
    })),
    error => error instanceof FactChangeFeedError && error.code === 'REBUILD_REQUIRED',
  );
  host.close();
});
