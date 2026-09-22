import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
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
