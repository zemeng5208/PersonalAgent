import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {createP5DeviceReceiptStore} from '../electron/p5-device-receipt-store.js';

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
