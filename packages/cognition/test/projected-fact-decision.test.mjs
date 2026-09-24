import assert from 'node:assert/strict';
import {test} from 'node:test';
import {decideProjectedFactImpact} from '../dist/projected-fact-decision.js';
import {ProactiveDecisionService} from '../dist/proactive-decision.js';

const input = () => ({
  graphNamespace: 'synthetic',
  projection: {graphRevision: 3, links: [{eventId: 'synthetic-change-2',
    fact: {id: 'calendar/location', revision: 2}, node: {id: 'memory-fact:location', revision: 2}}]},
  impact: {namespace: 'synthetic', graphRevision: 3, evaluatedAt: '2026-09-24T00:00:00.000Z',
    items: [{node: {id: 'plan-1', revision: 1}, kind: 'plan', action: 'RECHECK',
      reason: 'dependency_or_validity_changed', causes: [{reference: {id: 'memory-fact:location', revision: 1},
        currentRevision: 2, reason: 'superseded'}]}]},
  deadline: new Date(Date.now() + 5_000).toISOString(), signal: new AbortController().signal,
});

test('committed projection and matching impact reach the safe decision service', async () => {
  let events;
  const decision = new ProactiveDecisionService({async choose(batch) {
    events = batch;
    return [{intervention: 'EXECUTE', confidence: 0.99}];
  }});
  const [suggestion] = await decideProjectedFactImpact(decision, input());
  assert.equal(events.length, 1);
  assert.equal(events[0].source, 'memory-projection:synthetic');
  assert.equal(events[0].eventId, 'synthetic-change-2');
  assert.deepEqual(events[0].facts, [{id: 'calendar/location', revision: 2}]);
  assert.deepEqual(events[0].authorization, {state: 'none', revision: 0});
  assert.deepEqual([suggestion.intervention, suggestion.reason], ['ESCALATE_AGENTARTS', 'uncalibrated_model']);
});

test('unavailable model escalates; unrelated impact does not call the model', async () => {
  let calls = 0;
  const decision = new ProactiveDecisionService({async choose() { calls++; throw new Error('offline'); }});
  const [suggestion] = await decideProjectedFactImpact(decision, input());
  assert.deepEqual([suggestion.intervention, suggestion.reason], ['ESCALATE_AGENTARTS', 'model_unavailable']);
  const unrelated = input();
  unrelated.impact.items[0].causes[0].reference.id = 'different-fact';
  assert.deepEqual(await decideProjectedFactImpact(decision, unrelated), []);
  assert.equal(calls, 1);
});

test('mismatched graph revisions are rejected before model use', async () => {
  const mismatched = input();
  mismatched.impact.graphRevision = 4;
  await assert.rejects(() => decideProjectedFactImpact({decide() { throw new Error('unexpected'); }}, mismatched),
    {code: 'INVALID_ARGUMENT'});
});

test('only the current projected node revision can explain a RECHECK', async () => {
  let calls = 0;
  let currentEvents;
  const decision = {async decide(request) { calls++; currentEvents = request.events; return []; }};
  const stale = input();
  stale.impact.items[0].causes[0].currentRevision = 3;
  assert.deepEqual(await decideProjectedFactImpact(decision, stale), []);
  assert.equal(calls, 0);
  const current = input();
  await decideProjectedFactImpact(decision, current);
  assert.equal(currentEvents[0].facts[0].revision, 2);
  assert.equal(calls, 1);
});

test('the trusted projection namespace must match the impact report', async () => {
  let calls = 0;
  const otherGraph = input();
  otherGraph.impact.namespace = 'another-graph';
  await assert.rejects(() => decideProjectedFactImpact({decide() { calls++; }}, otherGraph),
    {code: 'INVALID_ARGUMENT'});
  assert.equal(calls, 0);
});

test('empty or unrelated events still honor cancellation and deadline without model use', async () => {
  let calls = 0;
  const decision = {decide() { calls++; throw Error('unexpected model call'); }};
  const cancelled = input();
  cancelled.projection.links = [];
  const controller = new AbortController();
  controller.abort();
  cancelled.signal = controller.signal;
  await assert.rejects(() => decideProjectedFactImpact(decision, cancelled), {code: 'CANCELLED'});
  const expired = input();
  expired.impact.items[0].action = 'KEEP';
  expired.deadline = new Date(Date.now() - 1_000).toISOString();
  await assert.rejects(() => decideProjectedFactImpact(decision, expired), {code: 'TIMEOUT'});
  assert.equal(calls, 0);
});
