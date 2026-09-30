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

    const afterRestart = createP5DeviceReceiptStore({filePath});
    const duplicate = afterRestart.addNotification(notification, provenance);
    assert.equal(duplicate.duplicate, true);
    assert.deepEqual(afterRestart.list(), [saved.record]);
    assert.throws(() => afterRestart.addNotification(notification, {...provenance, taskId: 'different-task'}), /identity conflict/);
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
