import assert from 'node:assert/strict';
import {test} from 'node:test';
import {FakeCoordinationStoreHost} from '@personal-agent/goals/store';
import {selectGoalRevisionImpact, previewGoalRevisionRepair} from '../dist/index.js';

const at = '2026-09-25T09:00:00.000Z';
const ref = (id, revision = 1) => ({id, revision});
const node = (id, kind, dependencies = [], summary = id) => ({
  id, kind, dependencies, summary, sourceRef: 'synthetic/meeting',
  sensitivity: 'private', state: 'active', reason: 'fixture',
  validFrom: '2026-09-25T00:00:00.000Z', validUntil: '2026-09-26T00:00:00.000Z'
});

function fixture() {
  const store = new FakeCoordinationStoreHost().provision('synthetic-person');
  for (const input of [
    node('meeting', 'fact'),
    node('goal', 'goal', [ref('meeting')]),
    node('decision', 'decision', [ref('goal')]),
    node('plan', 'plan', [ref('decision')]),
    node('other-fact', 'fact'),
    node('other-plan', 'plan', [ref('other-fact')]),
    node('other-fact', 'fact', [], 'changed other fact'),
    node('goal', 'goal', [ref('meeting')], 'revised goal')
  ]) store.append(store.read().revision, input);
  return store;
}

const scope = revision => ({expectedGraphRevision: revision,
  previousGoal: ref('goal'), currentGoal: ref('goal', 2)});
const change = () => ({node: ref('decision'), summary: 'reconsider revised goal',
  reason: 'explicit candidate', dependencies: [ref('goal', 2)]});

test('selects only the current RECHECK subtree caused by the stated Goal revision', () => {
  const snapshot = fixture().read();
  const before = JSON.stringify(snapshot);
  const result = selectGoalRevisionImpact(snapshot, at, scope(snapshot.revision));
  assert.deepEqual(result.items.map(item => item.node.id), ['decision', 'plan']);
  assert.ok(result.items.every(item => item.action === 'RECHECK'));
  assert.equal(JSON.stringify(snapshot), before);
  result.items[0].causes[0].reference.id = 'outside mutation';
  assert.equal(selectGoalRevisionImpact(snapshot, at, scope(snapshot.revision))
    .items[0].causes[0].reference.id, 'goal');
});

test('previews only an explicit affected change without writing or claiming complete repair', () => {
  const store = fixture();
  const snapshot = store.read();
  const result = previewGoalRevisionRepair(store, at,
    {...scope(snapshot.revision), changes: [change()]});
  assert.deepEqual(result.impact.items.map(item => item.node.id), ['decision', 'plan']);
  assert.equal(result.repair.before.snapshot.revision, snapshot.revision);
  assert.equal(result.repair.after.snapshot.revision, snapshot.revision + 1);
  assert.equal(result.repair.after.report.items.find(item => item.node.id === 'plan').action,
    'RECHECK', 'a pinned Plan still needs an explicit revision');
  assert.equal(store.read().revision, snapshot.revision);
});

test('rejects stale or forged Goal pairs and unrelated repair targets', () => {
  const store = fixture();
  const revision = store.read().revision;
  for (const bad of [
    {...scope(revision), expectedGraphRevision: revision - 1},
    {...scope(revision), previousGoal: ref('goal', 2), currentGoal: ref('goal', 3)}
  ]) assert.throws(() => selectGoalRevisionImpact(store.read(), at, bad),
    {code: 'REVISION_CONFLICT'});
  for (const bad of [
    {...scope(revision), previousGoal: ref('other-fact')},
    {...scope(revision), currentGoal: ref('goal')},
    {...scope(revision), currentGoal: ref('goal', 3)},
    {...scope(revision), extra: 'forged'}
  ]) assert.throws(() => selectGoalRevisionImpact(store.read(), at, bad),
    {code: 'INVALID_ARGUMENT'});
  assert.throws(() => previewGoalRevisionRepair(store, at, {...scope(revision),
    changes: [{node: ref('other-plan'), summary: 'unrelated candidate',
      reason: 'must stay outside scope', dependencies: [ref('other-fact', 2)]}]}),
  {code: 'NOT_APPLICABLE'});
});
