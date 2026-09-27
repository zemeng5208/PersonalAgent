import assert from 'node:assert/strict';
import {test} from 'node:test';
import {FakeCoordinationStoreHost} from '@personal-agent/goals/store';
import {selectProjectedRepairScope, previewProjectedRepair} from '../dist/index.js';

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
    node('memory-fact:meeting', 'fact'),
    node('goal', 'goal', [ref('memory-fact:meeting')]),
    node('decision', 'decision', [ref('goal')]),
    node('plan', 'plan', [ref('decision')]),
    node('unrelated', 'plan'),
    node('memory-fact:meeting', 'fact', [], 'corrected meeting')
  ]) store.append(store.read().revision, input);
  const projection = {batchToken: 'synthetic-batch', graphRevision: store.read().revision,
    links: [{eventId: 'synthetic-event', fact: ref('meeting', 2),
      node: ref('memory-fact:meeting', 2)}]};
  return {store, input: {graphNamespace: 'synthetic-person', projection}};
}

test('selects the committed Fact change and previews only its affected graph nodes', () => {
  const {store, input} = fixture();
  const scope = selectProjectedRepairScope(store.read(), at, input);
  assert.deepEqual(scope.items.map(item => item.node.id), ['goal', 'decision', 'plan']);
  const before = store.read();
  const preview = previewProjectedRepair(store, at, {...input, changes: [{
    node: ref('goal'), summary: 'goal for corrected meeting', reason: 'explicit candidate',
    dependencies: [ref('memory-fact:meeting', 2)]
  }]});
  assert.equal(preview.repair.after.snapshot.revision, before.revision + 1);
  assert.equal(preview.repair.after.report.items.find(item => item.node.id === 'plan').action,
    'RECHECK');
  assert.equal(store.read().revision, before.revision);
});

test('rejects stale projection and repair outside its RECHECK subset', () => {
  const {store, input} = fixture();
  assert.throws(() => selectProjectedRepairScope(store.read(), at, {...input,
    projection: {...input.projection, graphRevision: input.projection.graphRevision - 1}}),
  {code: 'REVISION_CONFLICT'});
  assert.throws(() => previewProjectedRepair(store, at, {...input, changes: [{
    node: ref('unrelated'), summary: 'unrelated edit', reason: 'not affected', dependencies: []
  }]}), {code: 'NOT_APPLICABLE'});
});
