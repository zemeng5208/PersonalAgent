import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createGoal, listGoals, reviseGoal} from '../dist/commands.js';
import {FakeCoordinationStoreHost} from '../dist/store.js';

const goal = (id, summary = '准备会议', sourceRef = 'user:request-1') => ({
  id, summary, sourceRef, validFrom: '2026-09-25T00:00:00.000Z',
  validUntil: '2026-10-25T00:00:00.000Z', sensitivity: 'private',
  state: 'active', reason: 'user requested', dependencies: []
});

test('host-bound goal commands preserve source and exact versions for consumer queries', () => {
  const store = new FakeCoordinationStoreHost().provision('person-a');
  const created = createGoal(store, 0, goal('meeting'));
  assert.equal(created.graphRevision, 1);
  assert.deepEqual([created.goal.kind, created.goal.revision, created.goal.sourceRef],
    ['goal', 1, 'user:request-1']);
  const revised = reviseGoal(store, 1, 1,
    {...goal('meeting', '准备线上会议', 'user:request-2'), reason: 'user correction'});
  assert.deepEqual([revised.graphRevision, revised.goal.revision, revised.goal.sourceRef],
    [2, 2, 'user:request-2']);
  assert.equal(listGoals(store, 1).goals[0].summary, '准备会议');
  const current = listGoals(store);
  assert.deepEqual([current.graphRevision, current.goals[0].summary], [2, '准备线上会议']);
  current.goals[0].summary = 'mutated by caller';
  assert.equal(listGoals(store).goals[0].summary, '准备线上会议');
});

test('goal ID and both revisions reject stale writes without changing the bound store', () => {
  const store = new FakeCoordinationStoreHost().provision('person-a');
  createGoal(store, 0, goal('meeting'));
  assert.throws(() => createGoal(store, 1, goal('meeting')), {code: 'REVISION_CONFLICT'});
  assert.throws(() => reviseGoal(store, 0, 1, goal('meeting', 'stale graph')),
    {code: 'REVISION_CONFLICT'});
  assert.throws(() => reviseGoal(store, 1, 2, goal('meeting', 'stale goal')),
    {code: 'REVISION_CONFLICT'});
  assert.deepEqual(listGoals(store).goals.map(node => [node.id, node.revision]), [['meeting', 1]]);
});

test('store commit CAS rejects a writer racing after preflight', () => {
  const bound = new FakeCoordinationStoreHost().provision('person-a');
  createGoal(bound, 0, goal('meeting'));
  const racingStore = {
    read: (...args) => bound.read(...args),
    append: (revision, input) => {
      createGoal(bound, revision, goal('other'));
      return bound.append(revision, input);
    }
  };
  assert.throws(() => reviseGoal(racingStore, 1, 1, goal('meeting', 'racing edit')),
    {code: 'REVISION_CONFLICT'});
  assert.deepEqual(listGoals(bound).goals.map(node => node.id), ['meeting', 'other']);
  assert.equal(listGoals(bound).goals[0].summary, '准备会议');
});

test('withdrawal stays queryable and IDs cannot be reused; malformed input is rejected', () => {
  const store = new FakeCoordinationStoreHost().provision('person-a');
  createGoal(store, 0, goal('meeting'));
  reviseGoal(store, 1, 1, {...goal('meeting'), state: 'withdrawn', reason: 'user withdrew'});
  assert.equal(listGoals(store).goals[0].state, 'withdrawn');
  assert.throws(() => createGoal(store, 2, goal('meeting')), {code: 'REVISION_CONFLICT'});
  assert.throws(() => reviseGoal(store, 2, 1, goal('meeting')), {code: 'REVISION_CONFLICT'});
  assert.throws(() => createGoal(store, 2, {...goal('new'), kind: 'fact'}),
    {code: 'INVALID_ARGUMENT'});
  assert.equal(store.read().revision, 2);
});

test('editing a goal keeps MOD-28 dependency references pinned to the old goal version', () => {
  const store = new FakeCoordinationStoreHost().provision('person-a');
  createGoal(store, 0, goal('meeting'));
  store.append(1, {...goal('decision', '安排提醒'), kind: 'decision',
    dependencies: [{id: 'meeting', revision: 1}]});
  reviseGoal(store, 2, 1, goal('meeting', '改成线上会议', 'user:request-2'));
  const decision = store.read().history.findLast(node => node.id === 'decision');
  assert.deepEqual(decision.dependencies, [{id: 'meeting', revision: 1}]);
  assert.equal(listGoals(store).goals[0].revision, 2);
});
