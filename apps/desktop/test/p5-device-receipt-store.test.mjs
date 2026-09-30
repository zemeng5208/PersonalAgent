import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {createP5DeviceReceiptStore, P5_DEVICE_RECEIPT_STORAGE_KEY} from '../electron/p5-device-receipt-store.js';

const notification = {id: 'receipt-1', source: 'node:os', timestamp: '2026-09-29T12:00:00.000Z',
  title: '系统资源提醒', message: 'CPU 使用率 92%', advice: '建议检查当前任务', candidateId: 'candidate-check'};
const provenance = {taskId: 'task-1', source: 'node:os', timestamp: notification.timestamp,
  evidenceRefs: ['host-tool-task-1']};

test('persists a bounded panel receipt and deduplicates it after restart', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pa-p5-device-receipts-'));
  const filePath = path.join(directory, 'receipts.json');
  try {
    const first = createP5DeviceReceiptStore({filePath, now: () => Date.parse(notification.timestamp)});
    const saved = first.addNotification(notification, provenance);
    assert.equal(saved.duplicate, false);
    assert.equal(saved.record.sourceTaskId, 'task-1');
    assert.deepEqual(saved.record.evidenceRefs, ['host-tool-task-1']);
    assert.equal(saved.record.deliveryState, 'pending');
    assert.equal(saved.record.deliveredAt, null);

    const afterRestart = createP5DeviceReceiptStore({filePath});
    const duplicate = afterRestart.addNotification(notification, provenance);
    assert.equal(duplicate.duplicate, true);
    assert.deepEqual(afterRestart.list(), [{...saved.record, deliveryState: 'unknown'}]);
    const confirmed = afterRestart.recordDelivery(notification.id, 'delivered');
    assert.equal(confirmed.deliveryState, 'delivered');
    assert.ok(confirmed.deliveredAt);
    assert.throws(() => afterRestart.recordDelivery(notification.id, 'failed'), /conflict/);
    assert.deepEqual(createP5DeviceReceiptStore({filePath}).read(notification.id), confirmed);
    assert.throws(() => afterRestart.addNotification(notification, {...provenance, taskId: 'different-task'}), /identity conflict/);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('preserves legacy card history without asserting delivery', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pa-p5-device-legacy-'));
  const filePath = path.join(directory, 'receipts.json');
  try {
    const legacy = {...notification, sourceTaskId: provenance.taskId, evidenceRefs: provenance.evidenceRefs,
      deliveredAt: notification.timestamp};
    await writeFile(filePath, JSON.stringify({version: 1, records: [legacy]}));
    const store = createP5DeviceReceiptStore({filePath});
    assert.equal(store.list().length, 1);
    assert.equal(store.read(notification.id).deliveryState, 'unknown');
    assert.equal(store.read(notification.id).createdAt, legacy.deliveredAt);
    assert.equal(store.read(notification.id).deliveredAt, null);
    store.recordDelivery(notification.id, 'failed');
    assert.equal(createP5DeviceReceiptStore({filePath}).read(notification.id).deliveryState, 'failed');
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('refuses corrupted receipt state instead of treating it as empty', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pa-p5-device-receipts-'));
  const filePath = path.join(directory, 'receipts.json');
  try {
    await writeFile(filePath, '{not-json', 'utf8');
    assert.throws(() => createP5DeviceReceiptStore({filePath}));
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('bounded history retains unresolved delivery instead of evicting its proof', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pa-p5-device-capacity-'));
  const filePath = path.join(directory, 'receipts.json');
  try {
    const store = createP5DeviceReceiptStore({filePath, maxEntries: 1});
    store.addNotification(notification, provenance);
    assert.throws(() => store.addNotification({...notification, id: 'second'}, provenance), /capacity/);
    assert.equal(store.read(notification.id).deliveryState, 'pending');
    store.recordDelivery(notification.id, 'failed');
    store.addNotification({...notification, id: 'second'}, provenance);
    assert.deepEqual(store.list().map(item => item.id), ['second']);
  } finally {await rm(directory, {recursive: true, force: true});}
});

async function sqliteFixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pa-p5-sqlite-'));
  let db;
  const reopen = () => {
    db?.close();
    db = new DatabaseSync(path.join(directory, 'runtime-fixture.sqlite'));
    db.exec('CREATE TABLE IF NOT EXISTS host_state (key TEXT PRIMARY KEY, value_json TEXT NOT NULL) STRICT');
  };
  reopen();
  const storage = {
    get(key) { const row = db.prepare('SELECT value_json FROM host_state WHERE key=?').get(key);
      return row ? JSON.parse(row.value_json) : undefined; },
    set(key, value) { db.prepare('INSERT INTO host_state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json')
      .run(key, JSON.stringify(value)); },
    delete(key) { db.prepare('DELETE FROM host_state WHERE key=?').run(key); },
  };
  t.after(async () => { db.close(); await rm(directory, {recursive: true, force: true}); });
  return {storage, directory, reopen};
}

test('SQLite receipt port preserves native proof and interrupted unknown across database reopen', async t => {
  const fx = await sqliteFixture(t);
  const first = createP5DeviceReceiptStore({storage: fx.storage});
  first.addNotification(notification, provenance);
  first.recordDelivery(notification.id, 'delivered');
  first.addNotification({...notification, id: 'interrupted'}, provenance);
  fx.reopen();
  const restarted = createP5DeviceReceiptStore({storage: fx.storage});
  assert.equal(restarted.addNotification(notification, provenance).duplicate, true);
  assert.equal(restarted.read(notification.id).deliveryState, 'delivered');
  assert.equal(restarted.read('interrupted').deliveryState, 'unknown');
  assert.equal(restarted.read('interrupted').deliveredAt, null);
  assert.equal(fx.storage.get(P5_DEVICE_RECEIPT_STORAGE_KEY).records.find(item => item.id === 'interrupted').deliveryState, 'unknown');
  assert.throws(() => restarted.addNotification({...notification, advice: 'changed input'}, provenance), /identity conflict/);
});

test('SQLite imports legacy JSON once, preserves the original file and never treats V1 as delivered', async t => {
  const fx = await sqliteFixture(t);
  const filePath = path.join(fx.directory, 'legacy.json');
  const legacy = {...notification, sourceTaskId: provenance.taskId, evidenceRefs: provenance.evidenceRefs,
    deliveredAt: notification.timestamp};
  const original = JSON.stringify({version: 1, records: [legacy]});
  await writeFile(filePath, original);
  const store = createP5DeviceReceiptStore({storage: fx.storage, filePath});
  assert.equal(store.read(notification.id).deliveryState, 'unknown');
  store.recordDelivery(notification.id, 'failed');
  assert.equal(await readFile(filePath, 'utf8'), original);
  await writeFile(filePath, '{corrupt old copy}');
  fx.reopen();
  assert.equal(createP5DeviceReceiptStore({storage: fx.storage, filePath}).read(notification.id).deliveryState, 'failed');
});

test('SQLite import/storage corruption and unavailable writes fail closed without replacing state', async t => {
  const fx = await sqliteFixture(t);
  const filePath = path.join(fx.directory, 'legacy.json');
  await writeFile(filePath, '{broken}');
  assert.throws(() => createP5DeviceReceiptStore({storage: fx.storage, filePath}));
  assert.equal(fx.storage.get(P5_DEVICE_RECEIPT_STORAGE_KEY), undefined);
  assert.throws(() => createP5DeviceReceiptStore({storage: {get: () => undefined,
    set: () => {throw Error('sqlite write unavailable');}, delete() {}}}), /write unavailable/);
  assert.throws(() => createP5DeviceReceiptStore({storage: {get: () => undefined,
    set: async () => {}, delete() {}}}), /synchronous/);
  fx.storage.set(P5_DEVICE_RECEIPT_STORAGE_KEY, {version: 2, records: [{id: 'invalid'}]});
  assert.throws(() => createP5DeviceReceiptStore({storage: fx.storage}), /invalid/);
  assert.deepEqual(fx.storage.get(P5_DEVICE_RECEIPT_STORAGE_KEY).records, [{id: 'invalid'}]);
});

test('SQLite source allowlist binds provenance and local writers retain each other receipts', async t => {
  const fx = await sqliteFixture(t);
  const first = createP5DeviceReceiptStore({storage: fx.storage, allowedSources: ['node:os', 'injected']});
  const second = createP5DeviceReceiptStore({storage: fx.storage, allowedSources: ['node:os', 'injected']});
  first.addNotification(notification, provenance);
  const injected = {...notification, id: 'synthetic-source', source: 'injected'};
  assert.throws(() => second.addNotification(injected, provenance), /Invalid/);
  second.addNotification(injected, {...provenance, source: 'injected'});
  assert.deepEqual(first.list().map(item => item.id), [notification.id, injected.id]);
  assert.throws(() => first.addNotification({...notification, source: 'other'}, {...provenance, source: 'other'}), /Invalid/);
});

test('SQLite unresolved intent stays retained at capacity and a failed write cannot report delivery', async t => {
  const fx = await sqliteFixture(t);
  let writable = true;
  const storage = {...fx.storage, set(key, value) {
    if (!writable) throw Error('sqlite write failed');
    fx.storage.set(key, value);
  }};
  const store = createP5DeviceReceiptStore({storage, maxEntries: 1});
  store.addNotification(notification, provenance);
  writable = false;
  assert.throws(() => store.recordDelivery(notification.id, 'delivered'), /write failed/);
  assert.equal(store.read(notification.id).deliveryState, 'pending');
  writable = true;
  fx.reopen();
  const restarted = createP5DeviceReceiptStore({storage, maxEntries: 1});
  assert.equal(restarted.read(notification.id).deliveryState, 'unknown');
  assert.throws(() => restarted.addNotification({...notification, id: 'other'}, provenance), /capacity/);
  assert.equal(restarted.list().length, 1);
});
