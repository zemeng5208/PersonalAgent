import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {TaskRuntime} from '@personal-agent/runtime';
import {DeviceAnomalyDecisionService} from '@personal-agent/cognition';
import {createP5RuntimeCheckpoints} from '../electron/p5-runtime-checkpoints.js';

test('P5 same Runtime SQLite preserves device replay and legacy meeting receipts across reopen', async t => {
  const base = fileURLToPath(new URL('../../../.cache/p5-checkpoint-test/', import.meta.url));
  mkdirSync(base, {recursive: true});
  const userData = mkdtempSync(path.join(base, 'sqlite-'));
  const database = path.join(userData, 'runtime.sqlite');
  let runtime = new TaskRuntime(database);
  t.after(() => {runtime.close(); rmSync(userData, {recursive: true, force: true});});
  const record = {namespace: 'owned', eventId: 'event', source: 'calendar:source', sourceRevision: '2', inputDigest: 'digest',
    status: 'proposal', receipt: {eventId: 'event', source: 'calendar:source', sourceRevision: '2', status: 'proposal'}};
  mkdirSync(path.join(userData, 'meeting-receipts'));
  const legacy = path.join(userData, 'meeting-receipts/receipt-original.json');
  writeFileSync(legacy, JSON.stringify(record));
  const ports = createP5RuntimeCheckpoints({runtime, namespace: 'owned', userData});
  assert.deepEqual(ports.meetings.loadReceipt({eventId: 'event', source: record.source}), record);
  let calls = 0;
  const chooser = {choose() {calls++; throw Error('No real inference in persistence test');}};
  const sample = {source: 'node:os', timestamp: new Date().toISOString(), cpuPercent: 10, memoryPercent: 20, samplingIntervalMs: 30_000};
  const service = new DeviceAnomalyDecisionService(chooser, {checkpoint: ports.device});
  const receipt = await service.evaluateSample(sample);
  assert.equal(receipt.status, 'normal');
  runtime.close(); runtime = new TaskRuntime(database);
  const restored = createP5RuntimeCheckpoints({runtime, namespace: 'owned', userData});
  assert.equal(restored.taskId, ports.taskId);
  const service2 = new DeviceAnomalyDecisionService(chooser, {checkpoint: restored.device});
  assert.equal((await service2.readFeedback())[0].receipt.receiptId, receipt.receiptId);
  assert.equal((await service2.evaluateSample(sample)).status, 'replayed');
  assert.equal(calls, 0);
  assert.deepEqual(restored.meetings.loadReceipt({eventId: 'event', source: record.source}), record);
  restored.meetings.saveReceipt({...record, status: 'applied', receipt: {...record.receipt, status: 'applied'}});
  assert.equal(restored.meetings.listReceipts({status: 'applied'}).length, 1);
  assert.equal(restored.meetings.loadReceipt({namespace: 'other', eventId: 'event'}), undefined);
  assert.deepEqual(JSON.parse(readFileSync(legacy, 'utf8')), record, 'Legacy data is retained unchanged');
  assert.equal(runtime.listTasks({conversationId: `desktop-cognition-state:${(await import('node:crypto')).createHash('sha256').update(JSON.stringify('owned')).digest('hex')}`}).items.length, 1);
});

test('corrupt legacy receipt blocks migration instead of losing deduplication', t => {
  const base = fileURLToPath(new URL('../../../.cache/p5-checkpoint-test/', import.meta.url));
  mkdirSync(base, {recursive: true}); const userData = mkdtempSync(path.join(base, 'corrupt-'));
  const runtime = new TaskRuntime(path.join(userData, 'runtime.sqlite'));
  t.after(() => {runtime.close(); rmSync(userData, {recursive: true, force: true});});
  mkdirSync(path.join(userData, 'meeting-receipts'));
  writeFileSync(path.join(userData, 'meeting-receipts/receipt-corrupt.json'), '{');
  const ports = createP5RuntimeCheckpoints({runtime, namespace: 'owned', userData});
  assert.throws(() => ports.meetings.listReceipts());
  assert.equal(runtime.loadCheckpoint(ports.taskId, 'p5-meeting-receipts-v1'), undefined);
});
