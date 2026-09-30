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
  let native, showCount = 0, closeCount = 0;
  class FakeNotification extends EventEmitter {
    static isSupported() { return options.supported !== false; }
    constructor() { super(); native = this; }
    show() { showCount++; }
    close() { closeCount++; }
  }
  const host = createP5DeviceNotificationHost({Notification: FakeNotification, store,
    readProvenance: () => provenance, isActive: () => true,
    readDeliveryPolicy: () => ({allowed: true}), ...options});
  t.after(async () => { host.dispose(); await rm(directory, {recursive: true, force: true}); });
  return {host, store, filePath, get native() {return native;}, get showCount() {return showCount;},
    get closeCount() {return closeCount;}};
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

test('stop settles pending sends as unknown, releases listeners and permits only new intent after resume', async t => {
  let enabled = true;
  const late = [];
  const fx = await fixture(t, {isActive: () => enabled, onLateOutcome: (...args) => late.push(args)});
  const delivery = fx.host.sendAdvisoryNotification(notification);
  const rejected = assert.rejects(delivery, /unknown/);
  const oldNative = fx.native;
  const oldShown = oldNative.listeners('show')[0];
  enabled = false;
  fx.host.stop();
  fx.host.stop();
  await rejected;
  assert.equal(fx.store.read(notification.id).deliveryState, 'unknown');
  assert.equal(oldNative.listenerCount('show'), 0);
  assert.equal(oldNative.listenerCount('failed'), 0);
  assert.equal(fx.closeCount, 1);
  oldNative.emit('show');
  oldShown(); // Even an already queued callback cannot alter a stopped receipt.
  assert.equal(fx.store.read(notification.id).deliveryState, 'unknown');
  assert.deepEqual(await fx.host.sendAdvisoryNotification({...notification, id: 'stopped'}), {delivered: false});
  assert.equal(fx.store.read('stopped'), undefined);
  enabled = true;
  await assert.rejects(fx.host.sendAdvisoryNotification(notification), /reconciliation/);
  const resumed = fx.host.sendAdvisoryNotification({...notification, id: 'resumed'});
  fx.native.emit('show');
  assert.deepEqual(await resumed, {delivered: true});
  assert.equal(fx.showCount, 2);
  assert.deepEqual(late, []);
});

test('active or provenance revocation prevents a pending outcome from confirming delivery', async t => {
  for (const revoked of ['active', 'provenance']) {
    let enabled = true, trusted = true;
    const fx = await fixture(t, {isActive: () => enabled,
      readProvenance: () => trusted ? provenance : undefined});
    const delivery = fx.host.sendAdvisoryNotification(notification);
    const rejected = assert.rejects(delivery, /unknown/);
    if (revoked === 'active') enabled = false;
    else trusted = false;
    fx.native.emit('show');
    await rejected;
    assert.equal(fx.store.read(notification.id).deliveryState, 'unknown');
    assert.equal(fx.native.listenerCount('failed'), 0);
    assert.equal(fx.closeCount, 1);
  }
});

test('dispose settles pending delivery and permanently disables sends and callbacks', async t => {
  let updates = 0;
  const fx = await fixture(t, {onUpdate: () => updates++});
  const delivery = fx.host.sendAdvisoryNotification(notification);
  const rejected = assert.rejects(delivery, /unknown/);
  const beforeDispose = updates;
  fx.host.dispose();
  fx.host.dispose();
  await rejected;
  fx.native.emit('show');
  fx.native.emit('failed');
  assert.equal(updates, beforeDispose);
  assert.equal(fx.store.read(notification.id).deliveryState, 'unknown');
  assert.equal(fx.native.listenerCount('show'), 0);
  assert.equal(fx.native.listenerCount('failed'), 0);
  assert.deepEqual(await fx.host.sendAdvisoryNotification({...notification, id: 'disposed'}), {delivered: false});
  assert.equal(fx.store.read('disposed'), undefined);
  assert.equal(fx.showCount, 1);
});

test('stop, dispose or revocation suppress a late reconciliation already queued for dispatch', async t => {
  for (const action of ['stop', 'dispose', 'active', 'provenance']) {
    let enabled = true, trusted = true;
    const late = [];
    const fx = await fixture(t, {timeoutMs: 5, isActive: () => enabled,
      readProvenance: () => trusted ? provenance : undefined,
      onLateOutcome: (...args) => late.push(args)});
    await assert.rejects(fx.host.sendAdvisoryNotification(notification), /unknown/);
    fx.native.emit('show');
    assert.equal(fx.store.read(notification.id).deliveryState, 'delivered');
    if (action === 'stop') fx.host.stop();
    else if (action === 'dispose') fx.host.dispose();
    else if (action === 'active') enabled = false;
    else trusted = false;
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(late, []);
    // Native proof received before stop remains proof, without consuming cognition while stopped.
    assert.equal(fx.store.read(notification.id).deliveryState, 'delivered');
  }
});

test('observer errors do not lose native delivery and consent is rechecked before show', async t => {
  const fx = await fixture(t, {onUpdate: () => { throw Error('observer failed'); }});
  const delivery = fx.host.sendAdvisoryNotification(notification);
  fx.native.emit('show');
  assert.deepEqual(await delivery, {delivered: true});
  let enabled = true;
  const revoked = await fixture(t, {isActive: () => enabled, onUpdate: () => { enabled = false; }});
  assert.deepEqual(await revoked.host.sendAdvisoryNotification(notification), {delivered: false});
  assert.equal(revoked.showCount, 0);
  assert.equal(revoked.store.read(notification.id).deliveryState, 'failed');
});

test('in-flight duplicates await the same native outcome and late failure reconciles once', async t => {
  const late = [];
  const fx = await fixture(t, {timeoutMs: 5, onLateOutcome: (...args) => late.push(args)});
  const first = assert.rejects(fx.host.sendAdvisoryNotification(notification), /unknown/);
  const second = assert.rejects(fx.host.sendAdvisoryNotification(notification), /unknown/);
  await Promise.all([first, second]);
  assert.equal(fx.showCount, 1);
  fx.native.emit('failed');
  fx.native.emit('show');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fx.store.read(notification.id).deliveryState, 'failed');
  assert.deepEqual(late, [['node:os', notification.id, false]]);
});

test('delivery policy quiet and pause suppress new intent without OS calls or panel card spam', async t => {
  for (const reason of ['quiet_hours', 'paused', 'unavailable']) {
    const fx = await fixture(t, {readDeliveryPolicy: () => ({allowed: false, reason})});
    assert.deepEqual(await fx.host.sendAdvisoryNotification(notification), {delivered: false, error: reason});
    assert.deepEqual(await fx.host.sendAdvisoryNotification({...notification, id: 'new-sample'}), {delivered: false, error: reason});
    assert.equal(fx.showCount, 0);
    assert.deepEqual(fx.store.list(), []);
    assert.deepEqual(fx.host.readDeliveryPolicy(), {allowed: false, reason});
  }
});

test('delivery policy absent, async, corrupt or failing is unavailable and never calls native show', async t => {
  for (const readDeliveryPolicy of [undefined, () => Promise.resolve({allowed: true}),
    () => ({allowed: true, reason: 'quiet_hours'}), () => ({allowed: true, fromModel: true}),
    () => {throw Error('not configured');}]) {
    const fx = await fixture(t, {readDeliveryPolicy});
    assert.deepEqual(await fx.host.sendAdvisoryNotification(notification), {delivered: false, error: 'unavailable'});
    assert.equal(fx.showCount, 0);
    assert.deepEqual(fx.store.list(), []);
  }
});

test('delivery policy is reread immediately before native show and known suppression is not unknown', async t => {
  let reads = 0;
  const fx = await fixture(t, {readDeliveryPolicy: () => ++reads < 3
    ? {allowed: true} : {allowed: false, reason: 'paused'}});
  assert.deepEqual(await fx.host.sendAdvisoryNotification(notification), {delivered: false, error: 'paused'});
  assert.equal(reads, 3);
  assert.equal(fx.showCount, 0);
  assert.equal(fx.store.read(notification.id).deliveryState, 'failed');
  assert.equal(fx.native.listenerCount('show'), 0);
  assert.equal(fx.native.listenerCount('failed'), 0);
});

test('quiet policy never hides delivered proof or converts a saved unknown into known failure', async t => {
  let allowed = true;
  const fx = await fixture(t, {readDeliveryPolicy: () => allowed
    ? {allowed: true} : {allowed: false, reason: 'quiet_hours'}});
  const delivery = fx.host.sendAdvisoryNotification(notification);
  fx.native.emit('show');
  assert.deepEqual(await delivery, {delivered: true});
  allowed = false;
  assert.deepEqual(await fx.host.sendAdvisoryNotification(notification), {delivered: true});
  fx.store.addNotification({...notification, id: 'unknown'}, provenance);
  fx.store.recordDelivery('unknown', 'unknown');
  await assert.rejects(fx.host.sendAdvisoryNotification({...notification, id: 'unknown'}), /reconciliation/);
  assert.equal(fx.store.read('unknown').deliveryState, 'unknown');
  assert.equal(fx.showCount, 1);
});

test('readback distinguishes queued, native-delivered, failed and user-read without sampling replay', async t => {
  const fx = await fixture(t);
  assert.equal(fx.host.readDeliveryOutcome('missing'), undefined);
  const delivery = fx.host.sendAdvisoryNotification(notification);
  const queued = fx.host.readDeliveryOutcome(notification.id);
  assert.equal(queued.persisted, true);
  assert.equal(queued.queued, true);
  assert.equal(queued.delivered, false);
  assert.equal(queued.deliveredAt, null);
  assert.equal(queued.userRead, 'unobserved');
  queued.evidenceRefs.push('tampered');
  assert.deepEqual(fx.host.readDeliveryOutcome(notification.id).evidenceRefs, provenance.evidenceRefs);
  fx.native.emit('show');
  await delivery;
  const confirmed = fx.host.readDeliveryOutcome(notification.id);
  assert.equal(confirmed.deliveryState, 'delivered');
  assert.equal(confirmed.queued, false);
  assert.equal(confirmed.delivered, true);
  assert.equal(confirmed.userRead, 'unobserved');
  assert.equal(confirmed.sourceTaskId, provenance.taskId);
  fx.host.dispose();
  assert.deepEqual(fx.host.readDeliveryOutcome(notification.id), confirmed);
});
