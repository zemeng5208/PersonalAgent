import assert from 'node:assert/strict';
import {test} from 'node:test';
import {validateToolValue} from '@personal-agent/contracts';
import {FakeCoordinationStoreHost} from '../dist/store.js';
import {createGoalTools, GOAL_CREATE_TOOL, GOAL_REVISE_TOOL, GOAL_WRITE_SCOPE} from '../dist/tool.js';

const goal = (summary = '准备会议', sourceRef = 'user-goal:command-1') => ({
  id: 'meeting', summary, sourceRef, validFrom: '2026-09-25T00:00:00.000Z',
  validUntil: '2026-10-25T00:00:00.000Z', sensitivity: 'private',
  state: 'active', reason: 'explicit user request', dependencies: []
});
const context = () => ({taskId: 'task-1', runId: 'run-1', signal: new AbortController().signal,
  deadline: '2026-10-01T00:00:00.000Z', authorizationRef: 'run-1', scopes: [GOAL_WRITE_SCOPE]});

test('registered Goal tools validate arguments and return durable old/new revision refs', async () => {
  const store = new FakeCoordinationStoreHost().provision('desktop-user-v1:abc');
  const [create, revise] = createGoalTools(() => store);
  assert.deepEqual([create.descriptor.name, revise.descriptor.name], [GOAL_CREATE_TOOL, GOAL_REVISE_TOOL]);
  assert.deepEqual(create.descriptor.requiredScopes, [GOAL_WRITE_SCOPE]);
  assert.equal(create.descriptor.sideEffect, 'local_write');
  const firstInput = {expectedGraphRevision: 0, goal: goal()};
  validateToolValue(create.descriptor.inputSchema, firstInput);
  assert.throws(() => validateToolValue(create.descriptor.inputSchema,
    {...firstInput, namespace: 'other'}), {code: 'INVALID_ARGUMENT'});
  const created = await create.execute(firstInput, context());
  validateToolValue(create.descriptor.outputSchema, created);
  assert.deepEqual(created, {kind: 'applied', graphRevision: 1,
    previousGoal: null, currentGoal: {id: 'meeting', revision: 1}});
  const secondInput = {expectedGraphRevision: 1, expectedGoalRevision: 1,
    goal: {...goal('改为线上会议', 'user-goal:command-2'), reason: 'user correction'}};
  validateToolValue(revise.descriptor.inputSchema, secondInput);
  const revised = await revise.execute(secondInput, context());
  validateToolValue(revise.descriptor.outputSchema, revised);
  assert.deepEqual(revised, {kind: 'applied', graphRevision: 2,
    previousGoal: {id: 'meeting', revision: 1}, currentGoal: {id: 'meeting', revision: 2}});
  assert.equal(store.read(1).history[0].sourceRef, 'user-goal:command-1');
  assert.equal(store.read(2).history[1].sourceRef, 'user-goal:command-2');
});

test('stale Goal command returns a confirmed conflict with no extra write', async () => {
  const store = new FakeCoordinationStoreHost().provision('desktop-user-v1:abc');
  const [create, revise] = createGoalTools(() => store);
  await create.execute({expectedGraphRevision: 0, goal: goal()}, context());
  const stale = await revise.execute({expectedGraphRevision: 0, expectedGoalRevision: 1,
    goal: goal('stale', 'user-goal:command-2')}, context());
  assert.deepEqual(stale, {kind: 'conflict', graphRevision: 1});
  assert.equal(store.read().revision, 1);
});

test('a failed durable readback cannot be reported as applied', async () => {
  const bound = new FakeCoordinationStoreHost().provision('desktop-user-v1:abc');
  const corruptReadback = {
    append: (...args) => bound.append(...args),
    read: revision => revision === 1 ? {...bound.read(1), history: []} : bound.read(revision)
  };
  const [create] = createGoalTools(() => corruptReadback);
  await assert.rejects(create.execute({expectedGraphRevision: 0, goal: goal()}, context()));
  assert.equal(bound.read().revision, 1);
});

test('tool registration is lazy; missing or changed host store fails closed', async () => {
  let selected;
  let resolutions = 0;
  const [create, revise] = createGoalTools(() => { resolutions++; return selected; });
  assert.equal(resolutions, 0);
  await assert.rejects(create.execute({expectedGraphRevision: 0, goal: goal()}, context()),
    {code: 'STORAGE_UNAVAILABLE'});
  const first = new FakeCoordinationStoreHost().provision('desktop-user-v1:first');
  selected = first;
  const created = await create.execute({expectedGraphRevision: 0, goal: goal()}, context());
  assert.equal(created.kind, 'applied');
  selected = new FakeCoordinationStoreHost().provision('desktop-user-v1:other');
  await assert.rejects(revise.execute({expectedGraphRevision: 1, expectedGoalRevision: 1,
    goal: goal('other', 'user-goal:command-2')}, context()), {code: 'STORAGE_UNAVAILABLE'});
  assert.equal(first.read().revision, 1);
  assert.equal(selected.read().revision, 0);
});
