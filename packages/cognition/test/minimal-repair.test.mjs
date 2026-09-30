import assert from 'node:assert/strict';
import {test} from 'node:test';
import {FakeCoordinationStoreHost} from '@personal-agent/goals/store';
import {buildMinimalRepairCandidate} from '../dist/minimal-repair.js';

const at = '2026-09-12T09:00:00.000Z';
const ref = (id, revision = 1) => ({id, revision});
const node = (id, kind = 'fact', dependencies = [], overrides = {}) => ({
  id, kind, dependencies, summary: `summary:${id}`, sourceRef: 'synthetic/meeting',
  sensitivity: 'private', state: 'active', reason: 'fixture',
  validFrom: '2026-09-12T00:00:00.000Z', validUntil: '2026-09-13T00:00:00.000Z',
  ...overrides
});
function fixture(extraPlanDependencies = []) {
  const store = new FakeCoordinationStoreHost().provision('synthetic-person');
  for (const input of [
    node('meeting'),
    node('goal', 'goal', [ref('meeting')]),
    node('decision', 'decision', [ref('goal')]),
    node('plan', 'plan', [ref('decision'), ...extraPlanDependencies]),
    node('unrelated', 'plan'),
    node('meeting', 'fact', [], {summary: 'corrected meeting'})
  ]) store.append(store.read().revision, input);
  return store;
}

test('builds a deterministic minimal topological chain without writing', () => {
  const store = fixture();
  const before = structuredClone(store.read());
  const input = {expectedGraphRevision: before.revision,
    targets: [ref('plan'), ref('goal'), ref('decision')]};
  const result = buildMinimalRepairCandidate(before, at, input);
  assert.equal(result.kind, 'candidate');
  assert.deepEqual(result.request.changes.map(change => change.node.id),
    ['goal', 'decision', 'plan']);
  assert.deepEqual(result.request.changes.map(change => change.dependencies), [
    [ref('meeting', 2)], [ref('goal', 2)], [ref('decision', 2)]
  ]);
  assert.ok(result.request.changes.every(change =>
    change.summary === `summary:${change.node.id}` && change.reason === 'fixture'
    && change.dependencies.every(dep => dep.id !== change.node.id)));
  assert.equal(result.semanticReviewRequired, true);
  assert.deepEqual(result.remaining, []);
  assert.equal(result.preview.after.report.items.find(item => item.node.id === 'plan').action, 'KEEP');
  assert.deepEqual(store.read(), before);
  assert.deepEqual(buildMinimalRepairCandidate(before, at, {...input, targets: [...input.targets].reverse()}).request,
    result.request);
  result.preview.after.snapshot.history[0].summary = 'outside mutation';
  assert.equal(before.history[0].summary, 'summary:meeting');
});

test('keeps a partially blocked target in RECHECK with its current ref', () => {
  const store = new FakeCoordinationStoreHost().provision('partial');
  for (const input of [
    node('other', 'fact', [], {validUntil: '2026-09-12T08:00:00.000Z'}),
    node('meeting'),
    node('goal', 'goal', [ref('meeting')]),
    node('decision', 'decision', [ref('goal')]),
    node('plan', 'plan', [ref('decision'), ref('other')]),
    node('meeting', 'fact', [], {summary: 'corrected meeting'})
  ]) store.append(store.read().revision, input);
  const result = buildMinimalRepairCandidate(store.read(), at, {
    expectedGraphRevision: 6, targets: [ref('plan'), ref('decision'), ref('goal')]
  });
  assert.equal(result.kind, 'candidate');
  assert.deepEqual(result.request.changes.map(change => change.node.id), ['goal', 'decision']);
  assert.deepEqual(result.remaining, [ref('plan')]);
  assert.equal(result.preview.after.report.items.find(item => item.node.id === 'plan').action, 'RECHECK');
});

test('never rebinds to withdrawn, future or expired heads', () => {
  for (const overrides of [
    {state: 'withdrawn'},
    {validFrom: '2026-09-12T10:00:00.000Z'},
    {validUntil: '2026-09-12T08:00:00.000Z'}
  ]) {
    const store = new FakeCoordinationStoreHost().provision('unsafe');
    store.append(0, node('meeting'));
    store.append(1, node('goal', 'goal', [ref('meeting')]));
    store.append(2, node('meeting', 'fact', [], overrides));
    const result = buildMinimalRepairCandidate(store.read(), at, {
      expectedGraphRevision: 3, targets: [ref('goal')]
    });
    assert.deepEqual(result, {kind: 'recheck', reason: 'no_safe_dependency_rebind',
      remaining: [ref('goal')]});
  }
});

test('validates exact scope, revision, duplicates and cap', () => {
  const snapshot = fixture().read();
  const request = {expectedGraphRevision: snapshot.revision, targets: [ref('goal')]};
  assert.throws(() => buildMinimalRepairCandidate(snapshot, at,
    {...request, expectedGraphRevision: 5}), {code: 'REVISION_CONFLICT'});
  assert.throws(() => buildMinimalRepairCandidate(snapshot, at,
    {...request, targets: [ref('goal', 2)]}), {code: 'REVISION_CONFLICT'});
  for (const targets of [[], [ref('goal'), ref('goal')],
    Array.from({length: 101}, (_, i) => ref(`n${i}`))]) {
    assert.throws(() => buildMinimalRepairCandidate(snapshot, at, {...request, targets}),
      {code: 'INVALID_ARGUMENT'});
  }
  assert.throws(() => buildMinimalRepairCandidate(snapshot, at,
    {...request, targets: [ref('unrelated')]}), {code: 'NOT_APPLICABLE'});
  assert.throws(() => buildMinimalRepairCandidate(snapshot, at,
    {...request, targets: [ref('meeting', 2)]}), {code: 'NOT_APPLICABLE'});
});

test('current-ID cycles stay in RECHECK and cannot create a self dependency', () => {
  const store = new FakeCoordinationStoreHost().provision('cycle');
  store.append(0, node('a', 'goal'));
  store.append(1, node('b', 'decision', [ref('a')]));
  store.append(2, node('a', 'goal', [ref('b')]));
  const result = buildMinimalRepairCandidate(store.read(), at, {
    expectedGraphRevision: 3, targets: [ref('a', 2), ref('b')]
  });
  assert.equal(result.kind, 'recheck');
  assert.deepEqual(result.remaining, [ref('a', 2), ref('b')]);
});
