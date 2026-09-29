import test from 'node:test';
import assert from 'node:assert/strict';
import {NotificationService} from '../dist/index.js';

// Explicit non-copying in-memory StoragePort fixture; no scheduler or network.
function fixture(start, windowMs) {
  let now = start;
  let nextId = 0;
  const values = new Map();
  const storage = {get: key => values.get(key), set: (key, value) => { values.set(key, value); }};
  const policy = {digest: {windowMs, maxItems: 100}};
  const options = {now: () => now, idFactory: () => `timing-${++nextId}`};
  const service = new NotificationService(storage, policy, options);
  const item = {source: 'timing-fixture', accountRef: 'synthetic', externalId: 'event-1',
    occurredAt: new Date(start).toISOString(), fetchedAt: new Date(start).toISOString(),
    contentRef: 'synthetic-ref', sensitivity: 'private', dedupeKey: 'timing-event-1'};
  service.ingest([item]);
  return {service, setNow: value => { now = value; },
    reopen: () => new NotificationService(storage, policy, options)};
}

test('digest waits for the complete window after a millisecond arrival', () => {
  const start = Date.parse('2026-09-20T12:00:00.250Z');
  const {service, setNow} = fixture(start, 60_000);
  setNow(start + 59_999);
  assert.equal(service.drain().batches.length, 0, 'must not round the arrival down');
  assert.equal(service.status().nextDigestCloseAt, '2026-09-20T12:01:00.250Z');
  setNow(start + 60_000);
  const [batch] = service.drain().batches;
  assert.equal(batch.kind, 'digest');
  assert.equal(batch.heldSince, '2026-09-20T12:00:00.250Z');
  assert.equal(batch.decidedAt, '2026-09-20T12:01:00.250Z');
});

test('a non-whole-second digest window is ready at its suggested runAt', () => {
  const start = Date.parse('2026-09-20T12:00:00.000Z');
  const {service, setNow} = fixture(start, 60_001);
  const [plan] = service.planSchedules('timing-conversation');
  assert.equal(plan.runAt, '2026-09-20T12:01:00.001Z');
  assert.equal(plan.taskIdempotencyKey, `notifications:digest:${plan.runAt}`);
  setNow(Date.parse(plan.runAt) - 1);
  assert.equal(service.drain().batches.length, 0);
  setNow(Date.parse(plan.runAt));
  assert.equal(service.drain().batches.length, 1, 'one scheduled callback must find the digest ready');
});

test('whole-second stored timestamps retain replay and acknowledgement behavior', () => {
  const start = Date.parse('2026-09-20T12:00:00.000Z');
  const {setNow, reopen} = fixture(start, 60_000);
  const restored = reopen();
  const [plan] = restored.planSchedules('timing-conversation');
  assert.equal(plan.runAt, '2026-09-20T12:01:00.000Z');
  setNow(Date.parse(plan.runAt));
  const [batch] = restored.drain().batches;
  assert.equal(batch.heldSince, '2026-09-20T12:00:00.000Z');
  assert.deepEqual(reopen().drain().batches, [batch]);
  restored.acknowledge(batch.id);
  assert.equal(reopen().drain().batches.length, 0);
});
