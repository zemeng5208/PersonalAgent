import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createGraph, appendVersion} from '@personal-agent/goals';
import {analyzeImpact, proposePlanRevision} from '../dist/index.js';

const at = '2026-09-09T12:00:00.000Z';
const node = (id, kind = 'fact', dependencies = []) => ({id, kind, dependencies,
  summary: 'meeting at 15:00', sourceRef: 'fixture/meeting', sensitivity: 'private',
  state: 'active', reason: 'initial', validFrom: '2026-09-09T00:00:00.000Z', validUntil: '2026-09-10T00:00:00.000Z'});
const add = (g, n) => appendVersion(g, g.revision, n);
function fixture() {
  let g = createGraph('synthetic-person');
  for (const n of [node('meeting'), node('goal', 'goal', [{id: 'meeting', revision: 1}]),
    node('decision', 'decision', [{id: 'goal', revision: 1}]),
    node('plan', 'plan', [{id: 'decision', revision: 1}]), node('unrelated', 'plan')]) g = add(g, n);
  return g;
}
const changed = () => add(fixture(), {...node('meeting'), summary: 'meeting at 17:00', reason: 'correction'});
const item = (report, id) => report.items.find(i => i.node.id === id);
const request = g => ({expectedGraphRevision: g.revision, plan: {id: 'plan', revision: 1}, summary: 'prepare for 17:00', reason: 'explicit local candidate'});

test('unchanged graph and unrelated new fact KEEP all plans', () => {
  for (const g of [fixture(), add(fixture(), node('unrelated-fact'))]) {
    assert.ok(analyzeImpact(g, at).items.every(i => i.action === 'KEEP' && i.causes.length === 0));
  }
});
test('correction propagates through exact versions and preserves unrelated plan', () => {
  const g = changed();
  const before = JSON.stringify(g);
  const report = analyzeImpact(g, at);
  for (const id of ['goal', 'decision', 'plan']) {
    assert.equal(item(report, id).action, 'RECHECK');
    assert.deepEqual(item(report, id).causes, [{reference: {id: 'meeting', revision: 1}, currentRevision: 2, reason: 'superseded'}]);
  }
  assert.equal(item(report, 'unrelated').action, 'KEEP');
  assert.equal(JSON.stringify(g), before);
  assert.deepEqual(analyzeImpact(JSON.parse(before), at), report);
});
test('withdrawn source and time-only expiry trigger recheck without a new event', () => {
  const withdrawn = add(fixture(), {...node('meeting'), state: 'withdrawn'});
  assert.equal(item(analyzeImpact(withdrawn, at), 'plan').action, 'RECHECK');
  const expired = analyzeImpact(fixture(), '2026-09-10T00:00:00.000Z');
  assert.ok(item(expired, 'plan').causes.some(c => c.reason === 'not_effective'));
  const direct = add(withdrawn, node('new-plan', 'plan', [{id: 'meeting', revision: 2}]));
  assert.ok(item(analyzeImpact(direct, at), 'new-plan').causes.some(c => c.reason === 'withdrawn'));
});
test('rebound current goal does not silently repair an older decision basis', () => {
  const g = add(changed(), node('goal', 'goal', [{id: 'meeting', revision: 2}]));
  const report = analyzeImpact(g, at);
  assert.equal(item(report, 'goal').action, 'KEEP');
  assert.equal(item(report, 'decision').action, 'RECHECK');
  assert.ok(item(report, 'plan').causes.some(c => c.reference.id === 'meeting'));
});
test('repeated IDs in an acyclic version graph terminate and deduplicate diamond causes', () => {
  let g = fixture();
  g = add(g, node('other', 'decision', [{id: 'meeting', revision: 1}]));
  g = add(g, node('plan', 'plan', [{id: 'decision', revision: 1}, {id: 'other', revision: 1}]));
  g = add(g, node('meeting', 'fact', [{id: 'plan', revision: 2}]));
  const causes = item(analyzeImpact(g, at), 'plan').causes;
  assert.equal(causes.filter(c => c.reference.id === 'meeting').length, 1);
});
test('withdrawn plans stay inactive and are not revived', () => {
  const g = add(changed(), {...node('plan', 'plan'), state: 'withdrawn'});
  assert.equal(item(analyzeImpact(g, at), 'plan').reason, 'inactive');
  assert.throws(() => proposePlanRevision(g, at, {...request(g), plan: {id: 'plan', revision: 2}}), {code: 'NOT_APPLICABLE'});
});
test('REVISE is an explicit minimal summary diff and never writes or clears dependency causes', () => {
  const g = changed();
  const before = JSON.stringify(g);
  const proposal = proposePlanRevision(g, at, request(g));
  assert.equal(proposal.action, 'REVISE');
  assert.deepEqual(proposal.changes, [{field: 'summary', before: 'meeting at 15:00', after: 'prepare for 17:00'}]);
  assert.equal(JSON.stringify(g), before);
  assert.equal(item(analyzeImpact(g, at), 'plan').action, 'RECHECK');
});
test('rejects stale graph/node revisions, unaffected targets, no-op and unauthorized extra fields', () => {
  const g = changed();
  for (const delta of [{expectedGraphRevision: 0}, {plan: {id: 'plan', revision: 2}}]) {
    assert.throws(() => proposePlanRevision(g, at, {...request(g), ...delta}), {code: 'REVISION_CONFLICT'});
  }
  for (const delta of [{plan: {id: 'unrelated', revision: 1}}, {summary: 'meeting at 15:00'}, {plan: {id: 'meeting', revision: 2}}]) {
    assert.throws(() => proposePlanRevision(g, at, {...request(g), ...delta}), {code: 'NOT_APPLICABLE'});
  }
  for (const delta of [{authorizationRef: 'forged'}, {summary: ''}, {plan: {id: 'plan', revision: 1, state: 'succeeded'}}]) {
    assert.throws(() => proposePlanRevision(g, at, {...request(g), ...delta}), {code: 'INVALID_ARGUMENT'});
  }
});
test('rejects invalid snapshot/time and returns isolated output', () => {
  assert.throws(() => analyzeImpact({...fixture(), revision: 999}, at), {code: 'INVALID_ARGUMENT'});
  for (const invalid of ['', '2026-02-30T00:00:00.000Z', null]) assert.throws(() => analyzeImpact(fixture(), invalid), {code: 'INVALID_ARGUMENT'});
  const g = changed();
  const report = analyzeImpact(g, at);
  item(report, 'plan').causes[0].reference.id = 'mutated';
  assert.equal(item(analyzeImpact(g, at), 'plan').causes[0].reference.id, 'meeting');
});
