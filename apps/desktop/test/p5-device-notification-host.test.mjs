import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {createP5DeviceNotificationHost} from '../electron/p5-device-notification-host.js';
import {createP5DeviceReceiptStore} from '../electron/p5-device-receipt-store.js';

const notification = {id: 'notify-1', source: 'node:os', timestamp: '2026-09-30T04:00:00.000Z',
  title: '系统资源提醒', message: 'CPU 92%', advice: '检查当前任务', candidateId: 'inspect'};
const provenance = {taskId: 'task-1', source: notification.source, timestamp: notification.timestamp,
  evidenceRefs: ['evidence-1']};
async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pa-p5-native-notify-'));
  const filePath = path.join(directory, 'receipts.json');
  const store = createP5DeviceReceiptStore({filePath});
  let native, showCount = 0;
  class FakeNotification extends EventEmitter {
    static isSupported() { return options.supported !== false; }
    constructor() { super(); native = this; }
    show() { showCount++; }
  }
  const host = createP5DeviceNotificationHost({Notification: FakeNotification, store,
    readProvenance: () => provenance, isActive: () => true, ...options});
  t.after(async () => { host.dispose(); await rm(directory, {recursive: true, force: true}); });
  return {host, store, filePath, get native() {return native;}, get showCount() {return showCount;}};
}

test('only native show confirms delivery, deduplicates and persists proof', async t => {
  const fx = await fixture(t);
  const delivery = fx.host.sendAdvisoryNotification(notification);
  assert.equal(fx.store.read(notification.id).deliveryState, 'pending');
  assert.equal(fx.store.read(notification.id).deliveredAt, null);
  fx.native.emit('show');
  assert.deepEqual(await delivery, {delivered: true});
  assert.equal(createP5DeviceReceiptStore({filePath: fx.filePath}).read(notification.id).deliveryState, 'delivered');
  assert.deepEqual(await fx.host.sendAdvisoryNotification(notification), {delivered: true});
  assert.equal(fx.showCount, 1);
});

test('unsupported and failed notifications remain undelivered', async t => {
  const unsupported = await fixture(t, {supported: false});
  assert.deepEqual(await unsupported.host.sendAdvisoryNotification(notification), {delivered: false});
  assert.equal(unsupported.store.read(notification.id).deliveryState, 'failed');
  assert.equal(unsupported.showCount, 0);
  const fx = await fixture(t);
  const delivery = fx.host.sendAdvisoryNotification(notification);
  fx.native.emit('failed');
  assert.deepEqual(await delivery, {delivered: false});
  assert.equal(fx.store.read(notification.id).deliveredAt, null);
});

test('timeout retains unknown intent, forbids replay and reconciles a late show', async t => {
  const late = [];
  const fx = await fixture(t, {timeoutMs: 5, onLateOutcome: (...args) => late.push(args)});
  await assert.rejects(fx.host.sendAdvisoryNotification(notification), /unknown/);
  assert.equal(fx.store.read(notification.id).deliveryState, 'unknown');
  await assert.rejects(fx.host.sendAdvisoryNotification(notification), /unknown/);
  assert.equal(fx.showCount, 1);
  fx.native.emit('show');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(late, [['node:os', notification.id, true]]);
  assert.equal(fx.store.read(notification.id).deliveryState, 'delivered');
});

test('restart converts pending intent to unknown and never sends it again', async t => {
  const fx = await fixture(t);
  fx.store.addNotification(notification, provenance);
  const store = createP5DeviceReceiptStore({filePath: fx.filePath});
  class UnexpectedNotification { static isSupported() {throw Error('must not resend');} }
  const restarted = createP5DeviceNotificationHost({Notification: UnexpectedNotification, store,
    readProvenance: () => provenance, isActive: () => true});
  await assert.rejects(restarted.sendAdvisoryNotification(notification), /reconciliation/);
  assert.equal(store.read(notification.id).deliveryState, 'unknown');
  restarted.dispose();
});
