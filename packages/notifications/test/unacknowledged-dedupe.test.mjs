import assert from 'node:assert/strict';
import {test} from 'node:test';
import {NotificationService} from '../dist/index.js';
import {FakeStorage} from '@personal-agent/testkit';

const now = () => Date.parse('2026-09-17T12:00:00.000Z');
const item = dedupeKey => ({source: 'fixture', accountRef: 'synthetic',
  externalId: dedupeKey, occurredAt: new Date(now()).toISOString(),
  fetchedAt: new Date(now()).toISOString(), contentRef: 'synthetic-ref',
  sensitivity: 'private', dedupeKey});

for (const policy of [{}, {digest: {windowMs: 60_000, maxItems: 501}}]) {
  test(`unacknowledged ${policy.digest ? 'digest' : 'immediate'} keys survive the 500-key window`, () => {
    const storage = new FakeStorage().namespace('notification-fixture');
    let allocations = 0;
    const options = {now, idFactory: () => `batch-${++allocations}`};
    const first = new NotificationService(storage, policy, options);
    const items = Array.from({length: 501}, (_, i) => item(`event-${i}`));
    assert.equal(first.ingest(items).accepted, 501);
    const original = first.drain().batches[0];
    assert.equal(original.itemRefs.length, 501);
    assert.equal(original.state, 'ready_for_delivery');

    // New service over the same explicit Fake: this is state replay, not a
    // claim of disk durability or crash-atomic StoragePort implementation.
    const reopened = new NotificationService(storage, policy, options);
    assert.deepEqual(reopened.ingest([items[0]]), {accepted: 0, duplicates: 1});
    const replay = reopened.drain();
    assert.equal(replay.batches.length, 1);
    assert.deepEqual(replay.batches[0], original);
    assert.equal(reopened.status().pending, 0);
    assert.equal(allocations, 1, 'replayed input must not allocate another batch');
    assert.equal(storage.get('notifications:state').delivered.length, 500,
      'the existing bounded historical window is unchanged');
    reopened.acknowledge(original.id);
    assert.equal(reopened.drain().batches.length, 0);
  });
}
