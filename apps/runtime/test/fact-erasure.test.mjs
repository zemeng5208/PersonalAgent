import assert from 'node:assert/strict';
import {test} from 'node:test';
import {appendVersion, createGraph, graphAt, parseGraph} from '@personal-agent/goals';
import {eraseDependentGraphHistory} from '../dist/fact-erasure.js';

function add(graph, id, kind, dependencies = [], summary = id) {
  return appendVersion(graph, graph.revision, {
    id, kind, summary, sourceRef: 'synthetic-source',
    validFrom: '2026-09-01T00:00:00.000Z', validUntil: '2027-09-01T00:00:00.000Z',
    sensitivity: 'public', state: 'active', reason: 'synthetic-test', dependencies,
  });
}

test('erasure removes every target version and transitive dependent history, keeping independent refs valid', () => {
  let graph = createGraph('primary');
  graph = add(graph, 'target', 'fact', [], 'secret-v1');
  graph = add(graph, 'derived-goal', 'goal', [{id: 'target', revision: 1}]);
  graph = add(graph, 'derived-plan', 'plan', [{id: 'derived-goal', revision: 1}]);
  graph = add(graph, 'other-fact', 'fact');
  graph = add(graph, 'independent-goal', 'goal', [{id: 'other-fact', revision: 1}]);
  graph = add(graph, 'mixed-history', 'goal');
  graph = add(graph, 'target', 'fact', [], 'secret-v2');
  graph = add(graph, 'mixed-history', 'goal', [{id: 'target', revision: 2}], 'copied secret');
  graph = add(graph, 'downstream-decision', 'decision', [{id: 'mixed-history', revision: 1}]);
  const original = structuredClone(graph);

  const erased = eraseDependentGraphHistory(graph, 'target');
  assert.deepEqual(erased.history.map(node => [node.id, node.graphRevision]), [
    ['other-fact', 4], ['independent-goal', 5],
  ]);
  assert.equal(erased.revision, 9);
  assert.deepEqual(erased.erasedGraphRevisions, [1, 2, 3, 6, 7, 8, 9]);
  assert.deepEqual(graphAt(erased, 4).history.map(node => node.id), ['other-fact']);
  assert.deepEqual(graphAt(erased, 3).history, []);
  assert.deepEqual(erased.history[1].dependencies, [{id: 'other-fact', revision: 1}]);
  assert.deepEqual(parseGraph(erased), erased);
  assert.deepEqual(graph, original);
  assert.equal(JSON.stringify(erased).includes('secret'), false);
  const again = eraseDependentGraphHistory(erased, 'other-fact');
  assert.equal(again.revision, 9);
  assert.deepEqual(again.history, []);
  assert.deepEqual(again.erasedGraphRevisions, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(add(again, 'fresh', 'fact').history[0].graphRevision, 10);
});

test('erasure of a node absent from this graph leaves the validated graph unchanged', () => {
  const graph = add(createGraph('primary'), 'other-fact', 'fact');
  assert.deepEqual(eraseDependentGraphHistory(graph, 'missing'), graph);
});
