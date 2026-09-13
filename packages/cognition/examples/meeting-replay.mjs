import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {createGraph, appendVersion, currentNodes, graphAt} from '@personal-agent/goals';
import {analyzeImpact, proposePlanRevision} from '../dist/index.js';

// Synthetic local fixture. This is not an automatic repair loop or host approval.
const at = '2026-09-09T12:00:00.000Z';
const node = (id, kind, summary, dependencies = []) => ({id, kind, summary, dependencies,
  sourceRef: 'synthetic/calendar/meeting', sensitivity: 'private', state: 'active',
  validFrom: '2026-09-09T00:00:00.000Z', validUntil: '2026-09-10T00:00:00.000Z', reason: 'fixture initial version'});
const add = (graph, input) => appendVersion(graph, graph.revision, input);
const summary = report => report.items.map(({node, action}) => ({id: node.id, revision: node.revision, action}));

export function runMeetingReplay() {
  let graph = createGraph('synthetic-meeting-demo');
  for (const input of [node('meeting', 'fact', 'Meeting at 15:00'),
    node('attendance', 'goal', 'Attend meeting', [{id: 'meeting', revision: 1}]),
    node('departure', 'decision', 'Depart at 14:30', [{id: 'attendance', revision: 1}]),
    node('reminder', 'plan', 'Remind at 14:15', [{id: 'departure', revision: 1}]),
    node('reading', 'plan', 'Read a book at 20:00')]) graph = add(graph, input);
  const initial = structuredClone(graph);
  const baseline = analyzeImpact(graph, at);
  graph = add(graph, {...node('meeting', 'fact', 'Meeting at 17:00'), reason: 'synthetic calendar correction'});
  const corrected = structuredClone(graph);
  const impacted = analyzeImpact(graph, at);
  const proposal = proposePlanRevision(graph, at, {expectedGraphRevision: graph.revision,
    plan: {id: 'reminder', revision: 1}, summary: 'Remind at 16:15', reason: 'explicit fixture candidate for later meeting'});
  assert.deepEqual(graph, corrected, 'proposal must not apply itself');

  // Explicit fixture decisions, not model inference. Each dependent version is
  // deliberately rebound; updating only the goal must not clear the old plan.
  graph = add(graph, {...node('attendance', 'goal', 'Attend meeting', [{id: 'meeting', revision: 2}]), reason: 'fixture recheck'});
  const partiallyRebound = analyzeImpact(graph, at);
  assert.equal(partiallyRebound.items.find(i => i.node.id === 'reminder').action, 'RECHECK');
  assert.throws(() => proposePlanRevision(graph, at, {expectedGraphRevision: proposal.graphRevision,
    plan: proposal.plan, summary: proposal.changes[0].after, reason: proposal.reason}), {code: 'REVISION_CONFLICT'});
  graph = add(graph, {...node('departure', 'decision', 'Depart at 16:30', [{id: 'attendance', revision: 2}]), reason: 'explicit fixture decision'});
  // Regenerate candidate against the current snapshot before creating any version.
  const refreshed = proposePlanRevision(graph, at, {expectedGraphRevision: graph.revision,
    plan: {id: 'reminder', revision: 1}, summary: 'Remind at 16:15', reason: 'explicit fixture recheck'});
  graph = add(graph, {...node('reminder', 'plan', refreshed.changes[0].after, [{id: 'departure', revision: 2}]), reason: refreshed.reason});
  const repaired = analyzeImpact(graph, at);
  assert.ok(repaired.items.every(i => i.action === 'KEEP'));
  assert.deepEqual(currentNodes(graph).find(n => n.id === 'reading'), currentNodes(initial).find(n => n.id === 'reading'));
  assert.deepEqual(graphAt(graph, initial.revision), initial);
  assert.deepEqual(analyzeImpact(JSON.parse(JSON.stringify(corrected)), at), impacted);
  return {verification: 'mock', externalActionsExecuted: false, evaluatedAt: at,
    stages: {baseline: summary(baseline), corrected: summary(impacted),
      partiallyRebound: summary(partiallyRebound), repaired: summary(repaired)},
    proposal, historicalSnapshotPreserved: true, unrelatedPlanPreserved: true,
    graph};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const {graph, ...report} = runMeetingReplay();
  console.log(JSON.stringify({...report, finalGraphRevision: graph.revision}, null, 2));
}
