import assert from 'node:assert/strict';
import {test} from 'node:test';
import {planKnowledgeReevaluation} from '../dist/knowledge-reevaluation.js';

const shaA = 'a'.repeat(64);
const shaB = 'b'.repeat(64);
const at = '2026-09-27T12:00:00.000Z';
const ref = (id, revision = 1) => ({id, revision});
const dependency = (id, revision = 1, extra = {}) => ({consumer: ref(id, revision),
  sourceId: 'official-docs', sourceRevision: 'r1', contentSha256: shaA, ...extra});
const freshness = (extra = {}) => ({at, maxAgeMs: 2 * 60 * 60_000, requestedVersion: 'v1',
  sourceState: 'available', cache: {version: 'v1', sourceId: 'official-docs',
    sourceRevision: 'r1', contentSha256: shaA,
    lastSuccessfulCheck: '2026-09-27T11:00:00.000Z', validUntil: '2026-09-27T13:00:00.000Z'},
  ...extra});
const check = (outcome, checkedAt = at) => ({outcome, checkedAt,
  sourceId: 'official-docs', sourceRevision: 'r1', cachedContentSha256: shaA});
const input = (fresh = freshness(), dependencies = [dependency('goal')], checkpoint) =>
  ({namespace: 'person-a', freshness: fresh, dependencies,
    ...(checkpoint ? {checkpoint} : {})});

test('fresh exact cache is a no-op; expired validity cannot be revived by unchanged', () => {
  const fresh = planKnowledgeReevaluation(input());
  assert.equal(fresh.knowledge.action, 'use_cache');
  assert.deepEqual(fresh.affected, []);
  assert.equal(fresh.checkpoint.invalidation, null);
  const expired = planKnowledgeReevaluation(input(freshness({at: '2026-09-27T14:00:00.000Z',
    check: check('unchanged', '2026-09-27T14:00:00.000Z')})));
  assert.equal(expired.knowledge.action, 'last_verified_only');
  assert.equal(expired.knowledge.reason, 'verification_expired');
  assert.deepEqual(expired.affected.map(item => item.consumer), [ref('goal')]);
});

test('changed content invalidates exact refs only; reordered duplicate maps and polling time keep keys', () => {
  const dependencies = [dependency('plan'), dependency('goal'), dependency('goal'),
    dependency('other-source', 1, {sourceId: 'different'}),
    dependency('old-version', 1, {sourceRevision: 'r0'}),
    dependency('other-content', 1, {contentSha256: shaB})];
  const changed = freshness({check: check('changed')});
  const first = planKnowledgeReevaluation(input(changed, dependencies));
  assert.equal(first.knowledge.action, 'refresh_required');
  assert.deepEqual(first.affected.map(item => item.consumer.id), ['goal', 'plan']);
  assert.ok(first.affected.every(item => !item.duplicate && /^[a-f0-9]{64}$/.test(item.workKey)));
  assert.equal(new Set(first.affected.map(item => item.workKey)).size, 2);
  const later = planKnowledgeReevaluation(input({...changed, at: '2026-09-27T12:20:00.000Z',
    check: check('changed', '2026-09-27T12:20:00.000Z')}, [...dependencies].reverse()));
  assert.deepEqual(later.affected.map(item => item.workKey), first.affected.map(item => item.workKey));
  const replay = planKnowledgeReevaluation(input(changed, [...dependencies].reverse(),
    JSON.parse(JSON.stringify(first.checkpoint))));
  assert.ok(replay.affected.every(item => item.duplicate));
  assert.deepEqual(replay.affected.map(item => item.workKey), first.affected.map(item => item.workKey));
  assert.equal(planKnowledgeReevaluation(input(changed, dependencies)).affected[0].duplicate, false,
    'without a saved submission checkpoint the same command remains replayable');
});

test('consumer and source/version changes create new work while same cached content stays invalidated', () => {
  const changed = freshness({check: check('changed')});
  const first = planKnowledgeReevaluation(input(changed));
  const withConsumer = planKnowledgeReevaluation(input(changed,
    [dependency('goal'), dependency('goal', 2), dependency('plan')], first.checkpoint));
  assert.deepEqual(withConsumer.affected.map(item => [item.consumer.id, item.consumer.revision, item.duplicate]),
    [['goal', 1, true], ['goal', 2, false], ['plan', 1, false]]);

  const unchanged = freshness({at: '2026-09-27T12:10:00.000Z',
    check: check('unchanged', '2026-09-27T12:10:00.000Z')});
  const stillInvalid = planKnowledgeReevaluation(input(unchanged, [dependency('goal')], first.checkpoint));
  assert.equal(stillInvalid.knowledge.action, 'refresh_required');
  assert.equal(stillInvalid.knowledge.reason, 'content_changed');
  assert.equal(stillInvalid.affected[0].duplicate, true);
  const afterFailure = planKnowledgeReevaluation(input(freshness({at: '2026-09-27T12:05:00.000Z',
    check: check('failed', '2026-09-27T12:05:00.000Z')}), [dependency('goal')], first.checkpoint));
  assert.equal(afterFailure.checkpoint.invalidation, 'content_changed');
  assert.equal(planKnowledgeReevaluation(input(unchanged, [dependency('goal')],
    afterFailure.checkpoint)).knowledge.action, 'refresh_required');
  const relabeledCache = {...unchanged, cache: {...unchanged.cache, version: 'v2'},
    requestedVersion: 'v2'};
  assert.equal(planKnowledgeReevaluation(input(relabeledCache, [dependency('goal')],
    first.checkpoint)).knowledge.action, 'refresh_required',
  'a cache version label alone cannot clear the invalidated content identity');

  const newCache = {...unchanged, cache: {...unchanged.cache, sourceRevision: 'r2',
    contentSha256: shaB, version: 'v2'}, requestedVersion: 'v3', check: undefined};
  const newer = planKnowledgeReevaluation(input(newCache,
    [dependency('goal', 2, {sourceRevision: 'r2', contentSha256: shaB}), dependency('old-goal')],
    first.checkpoint));
  assert.equal(newer.knowledge.action, 'refresh_required');
  assert.equal(newer.checkpoint.invalidation, null);
  assert.deepEqual(newer.affected.map(item => item.consumer), [ref('goal', 2)]);
  assert.notEqual(newer.affected[0].workKey, first.affected[0].workKey);
  assert.deepEqual(newer.checkpoint.submittedWorkKeys, [newer.affected[0].workKey],
    'checkpoint only retains current source content identity');
});

test('withdrawn source never becomes current knowledge through unchanged old cache', () => {
  const withdrawn = planKnowledgeReevaluation(input(freshness({sourceState: 'withdrawn'})));
  assert.equal(withdrawn.knowledge.action, 'unavailable');
  assert.equal(withdrawn.checkpoint.invalidation, 'source_withdrawn');
  const oldUnchanged = planKnowledgeReevaluation(input(freshness({
    at: '2026-09-27T12:15:00.000Z', check: check('unchanged', '2026-09-27T12:15:00.000Z')
  }), [dependency('goal')], withdrawn.checkpoint));
  assert.equal(oldUnchanged.knowledge.action, 'unavailable');
  assert.equal(oldUnchanged.knowledge.reason, 'source_withdrawn');
  assert.deepEqual(oldUnchanged.affected.map(item => item.consumer), [ref('goal')]);
  const changedAfterWithdrawal = planKnowledgeReevaluation(input(freshness({
    at: '2026-09-27T12:20:00.000Z', check: check('changed', '2026-09-27T12:20:00.000Z')
  }), [dependency('goal')], withdrawn.checkpoint));
  assert.equal(changedAfterWithdrawal.knowledge.action, 'unavailable');
  assert.equal(changedAfterWithdrawal.checkpoint.invalidation, 'source_withdrawn');
});

test('invalid receipt, rollback and wrong checkpoint scope are rejected', () => {
  const changed = freshness({check: check('changed')});
  const checkpoint = planKnowledgeReevaluation(input(changed)).checkpoint;
  for (const malformed of [
    {...changed, check: {...check('changed'), outcome: 'possibly_changed'}},
    {...changed, check: {...check('changed'), sourceRevision: 'r0'}},
    {...changed, check: {...check('changed'), cachedContentSha256: shaB}},
    {...changed, check: {...check('changed'), checkedAt: '2026-09-27T10:00:00.000Z'}}
  ]) assert.throws(() => planKnowledgeReevaluation(input(malformed)), /Invalid/);
  assert.throws(() => planKnowledgeReevaluation(input(freshness({
    at: '2026-09-27T11:59:00.000Z', check: check('changed', '2026-09-27T11:59:00.000Z')
  }), [dependency('goal')], checkpoint)), /Invalid/);
  assert.throws(() => planKnowledgeReevaluation({...input(changed, [dependency('goal')], checkpoint),
    namespace: 'person-b'}), /Invalid/);
  assert.throws(() => planKnowledgeReevaluation(input({...changed,
    cache: {...changed.cache, sourceId: 'other'}}, [dependency('goal')], checkpoint)), /Invalid/);
  assert.throws(() => planKnowledgeReevaluation(input({...changed, check: undefined,
    cache: {...changed.cache, contentSha256: shaB}},
    [dependency('goal', 1, {contentSha256: shaB})], checkpoint)), /Invalid/,
  'one source revision cannot bind two different content hashes across checkpoints');
});
