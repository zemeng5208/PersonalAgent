import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createGraph, appendVersion, parseGraph, graphAt, currentNodes, isEffective} from '../dist/index.js';

const node = (id, kind = 'fact', dependencies = []) => ({id, kind, summary: '会议 15:00',
  sourceRef: 'fixture/calendar/meeting-1', validFrom: '2026-09-09T00:00:00.000Z',
  validUntil: '2026-09-10T00:00:00.000Z', sensitivity: 'private', state: 'active', reason: 'initial observation', dependencies});
function fixture() {
  let graph = createGraph('person-a');
  for (const n of [node('meeting'), node('prepare', 'goal', [{id: 'meeting', revision: 1}]),
    node('depart', 'decision', [{id: 'prepare', revision: 1}]), node('reminder', 'plan', [{id: 'depart', revision: 1}])]) {
    graph = appendVersion(graph, graph.revision, n);
  }
  return graph;
}
test('four kinds retain source, versions and pinned dependency provenance', () => {
  const original = fixture();
  const updated = appendVersion(original, 4, {...node('meeting'), summary: '会议 17:00', reason: 'calendar correction'});
  assert.equal(original.revision, 4);
  assert.equal(updated.revision, 5);
  assert.equal(currentNodes(updated)[0].revision, 2);
  assert.deepEqual(updated.history.slice(0, 4), original.history);
  assert.deepEqual(currentNodes(updated).find(n => n.id === 'prepare').dependencies, [{id: 'meeting', revision: 1}]);
});
test('withdrawal is a new version and unrelated plans are preserved', () => {
  const graph = fixture();
  const next = appendVersion(graph, 4, {...node('meeting'), state: 'withdrawn', reason: 'source withdrawn'});
  assert.equal(next.history[0].state, 'active');
  assert.equal(currentNodes(next)[0].state, 'withdrawn');
  assert.deepEqual(currentNodes(next).slice(1), currentNodes(graph).slice(1));
});
test('stale writes reject without mutation; persistence CAS remains a host responsibility', () => {
  const graph = fixture();
  const before = JSON.stringify(graph);
  assert.throws(() => appendVersion(graph, 3, node('new')), {code: 'REVISION_CONFLICT'});
  assert.equal(JSON.stringify(graph), before);
});
test('rejects missing, self, duplicate and future revision dependencies', () => {
  const graph = fixture();
  for (const refs of [[{id: 'missing', revision: 1}], [{id: 'new', revision: 1}],
    [{id: 'meeting', revision: 2}], [{id: 'meeting', revision: 1}, {id: 'meeting', revision: 1}]]) {
    assert.throws(() => appendVersion(graph, 4, node('new', 'plan', refs)), {code: 'INVALID_ARGUMENT'});
  }
});
test('replay supports JSON roundtrip and immutable historical snapshots', () => {
  const graph = fixture();
  assert.deepEqual(parseGraph(JSON.parse(JSON.stringify(graph))), graph);
  const past = graphAt(graph, 2);
  assert.equal(past.history.length, 2);
  past.history[0].summary = 'changed copy';
  assert.equal(graph.history[0].summary, '会议 15:00');
  assert.deepEqual(graphAt(graph, 0), createGraph('person-a'));
  assert.throws(() => graphAt(graph, 5), {code: 'INVALID_ARGUMENT'});
});
test('restore prior content by appending, keeping correction history intact', () => {
  const original = fixture();
  const corrected = appendVersion(original, 4, {...node('meeting'), summary: '17:00'});
  const restored = appendVersion(corrected, 5, {...node('meeting'), reason: 'restore original source'});
  assert.equal(restored.history.at(-1).revision, 3);
  assert.equal(restored.history[4].summary, '17:00');
});
test('rejects corrupted imported revision history, illegal fields and kind changes', () => {
  const graph = fixture();
  for (const bad of [null, {...graph, namespace: ''}, {...graph, revision: 99},
    {...graph, history: [...graph.history].reverse()}, {...graph, authorizationRef: 'forged'}]) {
    assert.throws(() => parseGraph(bad), {code: 'INVALID_ARGUMENT'});
  }
  for (const bad of [{...node('meeting'), kind: 'goal'}, {...node('new'), state: 'succeeded'},
    {...node('new'), validFrom: '2026-02-30T00:00:00.000Z'}, {...node('new'), validUntil: node('new').validFrom}]) {
    assert.throws(() => appendVersion(graph, 4, bad), {code: 'INVALID_ARGUMENT'});
  }
});
test('validity uses inclusive start and exclusive end; withdrawal overrides validity', () => {
  const n = fixture().history[0];
  assert.equal(isEffective(n, n.validFrom), true);
  assert.equal(isEffective(n, n.validUntil), false);
  assert.equal(isEffective({...n, state: 'withdrawn'}, n.validFrom), false);
});
