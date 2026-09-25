import assert from 'node:assert/strict';
import {test} from 'node:test';
import {FakeCoordinationStoreHost} from '@personal-agent/goals/store';
import {analyzeImpact, decideDurableFactProjection} from '../dist/index.js';

const at = '2026-09-25T09:00:00.000Z';
const ref = (id, revision = 1) => ({id, revision});
const node = (id, kind, dependencies = [], summary = id) => ({
  id, kind, dependencies, summary, sourceRef: 'synthetic/public-meeting',
  sensitivity: 'public', state: 'active', reason: 'fixture',
  validFrom: '2026-09-25T00:00:00.000Z', validUntil: '2026-09-26T00:00:00.000Z'
});
function fixture() {
  const store = new FakeCoordinationStoreHost().provision('synthetic-graph');
  for (const input of [
    node('memory-fact:meeting', 'fact'),
    node('goal', 'goal', [ref('memory-fact:meeting')]),
    node('plan', 'plan', [ref('goal')]),
    node('unrelated', 'plan'),
    node('memory-fact:meeting', 'fact', [], 'corrected meeting')
  ]) store.append(store.read().revision, input);
  const report = analyzeImpact(store.read(), at);
  return {store, input: {
    graphNamespace: 'synthetic-graph',
    projection: {batchToken: 'confirmed-batch', graphRevision: store.read().revision,
      links: [{eventId: 'confirmed-event', fact: ref('meeting', 2),
        node: ref('memory-fact:meeting', 2)}]},
    processed: {batchToken: 'confirmed-batch', report},
    deadline: new Date(Date.now() + 5_000).toISOString(), signal: new AbortController().signal
  }};
}
const decision = {async decide({events}) { return events.map(event => ({
  eventId: event.eventId, source: event.source, intervention: 'ESCALATE_AGENTARTS',
  confidence: null, reason: 'model_unavailable', facts: event.facts,
  authorizationRevision: event.authorization.revision
})); }};
const reader = processed => ({readCompletedImpact: () => processed});

test('completed batch reaches only its affected scope and bounded advice', async () => {
  const {store, input} = fixture();
  const before = store.read().revision;
  const {processed, ...request} = input;
  const result = await decideDurableFactProjection(store, decision, reader(processed), request);
  assert.deepEqual(result.scope.items.map(item => item.node.id), ['goal', 'plan']);
  assert.deepEqual(result.suggestions.map(item => item.intervention), ['ESCALATE_AGENTARTS']);
  assert.equal(store.read().revision, before, 'consumer must not write');
});

test('unrelated completion and changed graph cannot be treated as this batch', async () => {
  const {store, input} = fixture();
  let calls = 0;
  const forbidden = {decide() { calls++; throw new Error('must not run'); }};
  const {processed, ...request} = input;
  await assert.rejects(() => decideDurableFactProjection(store, forbidden,
    reader({...processed, batchToken: 'another-batch'}), request), {code: 'INVALID_ARGUMENT'});
  const forged = structuredClone(input.processed.report);
  forged.items[0].action = 'KEEP';
  await assert.rejects(() => decideDurableFactProjection(store, forbidden,
    reader({...processed, report: forged}), request), {code: 'INVALID_ARGUMENT'});
  store.append(store.read().revision, node('later', 'fact'));
  await assert.rejects(() => decideDurableFactProjection(store, forbidden, reader(processed), request),
    {code: 'REVISION_CONFLICT'});
  assert.equal(calls, 0);
});

test('durable reader gates pending and foreign batches before advice', async () => {
  const {store, input} = fixture();
  let calls = 0;
  const forbidden = {decide() { calls++; throw new Error('must not run'); }};
  const {processed, ...request} = input;
  await assert.rejects(() => decideDurableFactProjection(store, forbidden,
    {readCompletedImpact: () => undefined}, request), {code: 'NOT_APPLICABLE'});
  await assert.rejects(() => decideDurableFactProjection(store, forbidden,
    {readCompletedImpact: () => { const error = new Error('foreign batch');
      error.code = 'NOT_FOUND'; throw error; }}, request), {code: 'NOT_FOUND'});
  assert.equal(calls, 0);
  const actual = await decideDurableFactProjection(store, decision,
    {readCompletedImpact: token => token === processed.batchToken ? processed : undefined}, request);
  assert.deepEqual(actual.scope.items.map(item => item.node.id), ['goal', 'plan']);
});
