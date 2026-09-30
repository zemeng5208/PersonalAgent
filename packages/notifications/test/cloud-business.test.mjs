import assert from 'node:assert/strict';
import {test} from 'node:test';
import {NotificationService} from '../dist/index.js';
import {FakeStorage} from '@personal-agent/testkit';

const item = {source: 'fixture', accountRef: 'fixture', externalId: 'one',
  occurredAt: '2026-09-30T10:00:00.000Z', fetchedAt: '2026-09-30T10:00:00.000Z',
  contentRef: 'fixture only', sensitivity: 'public', dedupeKey: 'fixture:one'};

test('unacknowledged batch is held during quiet hours after restart and releases with the same identity', () => {
  const storage = new FakeStorage().namespace('cloud-business');
  let time = Date.parse('2026-09-30T13:00:00.000Z'); // 21:00 Shanghai
  let ids = 0;
  const options = {now: () => time, idFactory: () => `fixture-${++ids}`};
  const policy = {quietHours: {startLocal: '22:00', endLocal: '07:00', timeZone: 'Asia/Shanghai'}};
  const service = new NotificationService(storage, policy, options);
  service.ingest([item]);
  const first = service.drain().batches[0];
  time = Date.parse('2026-09-30T15:00:00.000Z');
  const restarted = new NotificationService(storage, policy, options);
  assert.equal(restarted.drain().batches.length, 0);
  assert.equal(restarted.status().unacknowledgedBatches, 1);
  assert.equal(restarted.ingest([item]).duplicates, 1);
  time = Date.parse('2026-09-30T23:00:00.000Z');
  assert.equal(restarted.drain().batches[0].id, first.id);
  const receipt = restarted.acknowledge(first.id);
  assert.equal(receipt.state, 'delivered');
  assert.equal(receipt.deliveredAt, new Date(time).toISOString());
  time += 1000;
  assert.equal(restarted.acknowledge(first.id).deliveredAt, receipt.deliveredAt);
  assert.equal(restarted.drain().batches.length, 0);
  assert.equal(ids, 1);
});

test('pause release produces a deterministic scheduler plan; caller policy mutation cannot bypass pause', () => {
  const storage = new FakeStorage().namespace('cloud-business');
  let time = Date.parse('2026-09-30T10:00:00.000Z');
  const policy = {pauseUntilUtc: '2026-09-30T11:00:00.000Z'};
  const service = new NotificationService(storage, policy, {now: () => time, idFactory: () => 'fixture-batch'});
  service.ingest([item]);
  policy.pauseUntilUtc = '2026-09-30T09:00:00.000Z';
  assert.equal(service.drain().batches.length, 0);
  const plans = service.planSchedules('fixture');
  assert.equal(plans[0].scheduleId, 'notifications:pause-end:2026-09-30T11:00:00.000Z');
  assert.equal(plans[0].missedRunPolicy, 'run_once');
  assert.deepEqual(service.planSchedules('fixture'), plans);
  time = Date.parse('2026-09-30T11:30:00.000Z');
  assert.equal(service.drain().batches.length, 1);
});
