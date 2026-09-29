import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {FactChangeFeedError} from '../dist/index.js';
import {openSqliteMemoryHost, SqliteMemoryHost} from '../dist/sqlite.js';

const request = extra => ({
  deadline: '2099-01-01T00:00:00.000Z', signal: new AbortController().signal, ...extra,
});
const binding = {consumerId: 'cognition', allowedSensitivities: ['public']};
const confirmation = batch => request({
  batchToken: batch.batchToken, expectedCheckpoint: batch.baseCheckpoint, handled: batch.entries,
});

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'memory-recovery-'));
  const path = join(directory, 'memory.sqlite');
  const state = {path, host: openSqliteMemoryHost(path)};
  t.after(() => { state.host.close(); rmSync(directory, {recursive: true, force: true}); });
  state.host.provision('personal');
  state.host.append('personal', {
    ref: {id: 'meeting', revision: 1}, summary: 'Synthetic meeting',
    sourceRef: 'test-fixture', observedAt: '2026-09-22T07:00:00.000Z',
    validFrom: '2026-09-22T00:00:00.000Z', validUntil: '2027-09-22T00:00:00.000Z',
    sensitivity: 'public', state: 'active', confirmation: 'user_confirmed',
  });
  const feed = state.host.bindFeed('personal', binding);
  return {state, feed, batch: await feed.read(request({limit: 10}))};
}

async function withWriterLock(path, action) {
  const writer = spawn(process.execPath, ['--input-type=module', '--eval', `
    import {DatabaseSync} from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec('BEGIN IMMEDIATE');
    process.on('message', () => setTimeout(() => {
      db.exec('ROLLBACK');
      db.close();
      process.disconnect();
    }, 350));
    process.send('locked');
  `, path], {stdio: ['ignore', 'ignore', 'inherit', 'ipc'], windowsHide: true});
  const exited = once(writer, 'exit');
  try {
    const [message] = await once(writer, 'message');
    assert.equal(message, 'locked');
    writer.send('release');
    await action(new Date(Date.now() + 100).toISOString());
    assert.deepEqual(await exited, [0, null]);
  } finally {
    if (writer.exitCode === null) { writer.kill(); await exited; }
  }
}

test('confirmation expires while waiting for a writer without consuming the batch', {timeout: 10000}, async t => {
  const {state, feed, batch} = await fixture(t);
  await withWriterLock(state.path, deadline => {
    assert.throws(() => state.host.confirmFeedBatch('personal', 'cognition', {
      ...confirmation(batch), deadline,
    }), error => error instanceof FactChangeFeedError && error.code === 'TIMEOUT');
  });
  assert.deepEqual(await feed.read(request({limit: 10})), batch);
});

test('expired feed read does not persist a stale delivery while waiting for a writer', {timeout: 10000}, async t => {
  const {state, feed, batch} = await fixture(t);
  state.host.confirmFeedBatch('personal', 'cognition', confirmation(batch));
  await withWriterLock(state.path, deadline => assert.rejects(
    feed.read(request({limit: 10, deadline})),
    error => error instanceof FactChangeFeedError && error.code === 'TIMEOUT',
  ));
  const memory = state.host.bind('personal', {allowedSensitivities: ['public']});
  const first = await memory.getVersion(request({fact: {id: 'meeting', revision: 1}}));
  state.host.append('personal', {...first, ref: {id: 'meeting', revision: 2}, corrects: first.ref});
  const change = await feed.read(request({limit: 10}));
  assert.deepEqual(change.entries.map(entry => entry.fact), [{id: 'meeting', revision: 2}]);
});

test('failed receipt write rolls back checkpoint and pending batch across restart', async t => {
  const {state, batch} = await fixture(t);
  const db = new DatabaseSync(state.path);
  db.exec(`CREATE TRIGGER reject_receipt BEFORE UPDATE ON memory_feed_deliveries
    BEGIN SELECT RAISE(ABORT, 'injected test failure'); END`);
  try {
    assert.throws(() => state.host.confirmFeedBatch('personal', 'cognition', confirmation(batch)),
      error => error instanceof FactChangeFeedError && !error.message.includes('injected'));
  } finally {
    db.exec('DROP TRIGGER reject_receipt');
    db.close();
  }
  state.host.close();
  state.host = openSqliteMemoryHost(state.path);
  const feed = state.host.bindFeed('personal', binding);
  assert.deepEqual(await feed.read(request({limit: 10})), batch);
  const receipt = state.host.confirmFeedBatch('personal', 'cognition', confirmation(batch));
  assert.deepEqual(state.host.confirmFeedBatch('personal', 'cognition', confirmation(batch)), receipt);
  assert.equal((await feed.read(request({limit: 10}))).mode, 'changes');
});

test('cancellation before commit rolls back the written checkpoint and receipt', async t => {
  const {state, batch} = await fixture(t);
  state.host.close();
  const db = new DatabaseSync(state.path);
  state.host = new SqliteMemoryHost(db);
  const controller = new AbortController();
  db.function('cancel_confirmation', () => { controller.abort(); return 0; });
  db.exec(`CREATE TEMP TRIGGER cancel_receipt AFTER UPDATE ON memory_feed_deliveries
    BEGIN SELECT cancel_confirmation(); END`);
  assert.throws(() => state.host.confirmFeedBatch('personal', 'cognition', {
    ...confirmation(batch), signal: controller.signal,
  }), error => error instanceof FactChangeFeedError && error.code === 'CANCELLED');
  db.exec('DROP TRIGGER cancel_receipt');
  const feed = state.host.bindFeed('personal', binding);
  assert.deepEqual(await feed.read(request({limit: 10})), batch);
  const receipt = state.host.confirmFeedBatch('personal', 'cognition', confirmation(batch));
  assert.deepEqual(state.host.confirmFeedBatch('personal', 'cognition', confirmation(batch)), receipt);
});
