import assert from 'node:assert/strict';
import {test} from 'node:test';
import {FakeCoordinationStoreHost} from '@personal-agent/goals/store';
import {commitStoredRepair, previewStoredRepair} from '../dist/index.js';

const at = '2026-09-12T09:00:00.000Z';
const node = (id, kind = 'fact', dependencies = [], overrides = {}) => ({
  id, kind, dependencies,
  summary: id,
  sourceRef: 'synthetic/meeting',
  sensitivity: 'private',
  state: 'active',
  reason: 'fixture',
  validFrom: '2026-09-12T00:00:00.000Z',
  validUntil: '2026-09-13T00:00:00.000Z',
  ...overrides
});

function fixture() {
  const host = new FakeCoordinationStoreHost();
  const store = host.provision('person-a');
  for (const input of [
    node('meeting'),
    node('goal', 'goal', [{id: 'meeting', revision: 1}]),
    node('decision', 'decision', [{id: 'goal', revision: 1}]),
    node('plan', 'plan', [{id: 'decision', revision: 1}]),
    node('unrelated', 'plan'),
    node('meeting', 'fact', [], {
      summary: 'Meeting at 17:00', reason: 'correction'
    })
  ]) store.append(store.read().revision, input);
  return {host, store};
}

function repairRequest(expectedGraphRevision) {
  return {
    expectedGraphRevision,
    changes: [
      {node: {id: 'goal', revision: 1}, summary: 'Goal for 17:00',
        reason: 'rebound to corrected meeting', dependencies: [{id: 'meeting', revision: 2}]},
      {node: {id: 'decision', revision: 1}, summary: 'Decision for 17:00',
        reason: 'rebound to corrected goal', dependencies: [{id: 'goal', revision: 2}]},
      {node: {id: 'plan', revision: 1}, summary: 'Remind at 17:00',
        reason: 'rebound to corrected decision', dependencies: [{id: 'decision', revision: 2}]}
    ]
  };
}

const item = (report, id) => report.items.find(entry => entry.node.id === id);

test('previews a complete explicit chain on an isolated copy and commits it once', () => {
  const {store} = fixture();
  const before = store.read();
  const request = repairRequest(before.revision);
  const preview = previewStoredRepair(store, at, request);

  assert.equal(preview.before.snapshot.revision, 6);
  assert.equal(preview.inputs.length, 3);
  assert.equal(preview.after.snapshot.revision, 9);
  assert.ok(preview.after.report.items.every(entry => entry.action === 'KEEP'));
  assert.equal(item(preview.before.report, 'plan').action, 'RECHECK');
  assert.equal(item(preview.after.report, 'plan').action, 'KEEP');
  assert.deepEqual(preview.after.snapshot.history.find(node => node.id === 'unrelated'),
    before.history.find(node => node.id === 'unrelated'));
  assert.equal(store.read().revision, before.revision, 'preview must not write');

  let appendBatchCalls = 0;
  const atomic = {
    read: (...args) => store.read(...args),
    append: (...args) => store.append(...args),
    appendBatch: (...args) => {
      appendBatchCalls++;
      return store.appendBatch(...args);
    }
  };
  const result = commitStoredRepair(atomic, at, request);
  assert.equal(result.kind, 'applied');
  assert.equal(appendBatchCalls, 1);
  assert.equal(result.snapshot.revision, 9);
  assert.ok(result.report.items.every(entry => entry.action === 'KEEP'));
  assert.deepEqual(result.snapshot.history.find(node => node.id === 'unrelated'),
    before.history.find(node => node.id === 'unrelated'));

  result.snapshot.history[0].summary = 'outside mutation';
  result.preview.inputs[0].summary = 'another outside mutation';
  assert.equal(store.read().history[0].summary, 'meeting');
});

test('rejects malformed, duplicate, future-ordered, fact and unrelated repairs', () => {
  const {store} = fixture();
  const revision = store.read().revision;
  let reads = 0;
  const unreadable = {read: () => { reads++; throw new Error('read must not be reached'); }};
  const valid = repairRequest(revision);
  for (const invalid of [
    {...valid, extra: true},
    {...valid, changes: []},
    {...valid, changes: [{...valid.changes[0], hidden: 'forged'}]},
    {...valid, changes: [valid.changes[0], {...valid.changes[0]}]}
  ]) {
    assert.throws(() => previewStoredRepair(unreadable, at, invalid), {code: 'INVALID_ARGUMENT'});
  }
  assert.equal(reads, 0, 'request validation must precede store reads');

  const badOrder = repairRequest(revision);
  badOrder.changes = [badOrder.changes[1], badOrder.changes[0], badOrder.changes[2]];
  assert.throws(() => previewStoredRepair(store, at, badOrder), {code: 'INVALID_ARGUMENT'});

  const unrelated = {
    expectedGraphRevision: revision,
    changes: [{node: {id: 'unrelated', revision: 1}, summary: 'new unrelated plan',
      reason: 'must not bypass impact check', dependencies: []}]
  };
  assert.throws(() => previewStoredRepair(store, at, unrelated), {code: 'NOT_APPLICABLE'});

  const fact = {
    expectedGraphRevision: revision,
    changes: [{node: {id: 'meeting', revision: 2}, summary: 'forged fact change',
      reason: 'facts are not repair targets', dependencies: []}]
  };
  assert.throws(() => previewStoredRepair(store, at, fact), {code: 'NOT_APPLICABLE'});

  const noOp = {
    expectedGraphRevision: revision,
    changes: [{node: {id: 'goal', revision: 1}, summary: 'goal', reason: 'reason only',
      dependencies: [{id: 'meeting', revision: 1}]}]
  };
  assert.throws(() => previewStoredRepair(store, at, noOp), {code: 'NOT_APPLICABLE'});

  const staleNode = repairRequest(revision);
  staleNode.changes[0].node = {id: 'goal', revision: 2};
  assert.throws(() => previewStoredRepair(store, at, staleNode), {code: 'REVISION_CONFLICT'});
});

test('returns a fresh conflict without retrying and preserves node conflicts', () => {
  const {store} = fixture();
  const stale = store.read();
  const request = repairRequest(stale.revision);
  let firstRead = true;
  let appendBatchCalls = 0;
  const racing = {
    read(revision) {
      if (firstRead && revision === undefined) {
        firstRead = false;
        store.append(stale.revision, node('winner'));
        return stale;
      }
      return store.read(revision);
    },
    append: (...args) => store.append(...args),
    appendBatch(expectedRevision, inputs) {
      appendBatchCalls++;
      return store.appendBatch(expectedRevision, inputs);
    }
  };
  const result = commitStoredRepair(racing, at, request);
  assert.equal(result.kind, 'conflict');
  assert.equal(appendBatchCalls, 1, 'the failed batch must not be retried');
  assert.equal(result.currentGraphRevision, 7);
  assert.equal(result.snapshot.revision, 7);
  assert.equal(item(result.report, 'plan').action, 'RECHECK');
  result.snapshot.history[0].summary = 'outside mutation';
  assert.equal(store.read().history[0].summary, 'meeting');

  const staleNode = repairRequest(store.read().revision);
  staleNode.changes[0].node = {id: 'goal', revision: 2};
  assert.throws(() => commitStoredRepair(store, at, staleNode), {code: 'REVISION_CONFLICT'});

  const oldPort = {read: store.read, append: store.append};
  assert.throws(() => commitStoredRepair(oldPort, at, repairRequest(store.read().revision)),
    {code: 'NOT_APPLICABLE'});
});
