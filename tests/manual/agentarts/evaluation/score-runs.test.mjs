import assert from 'node:assert/strict';
import test from 'node:test';
import {scoreAgentArtsRuns} from './score-runs.mjs';

const labels = [
  ['meeting-change', 'RECHECK'],
  ['unrelated-change', 'KEEP'],
  ['unverified-write', 'REJECT'],
];
const route = ['impact:start', 'impact:end', 'repair:start', 'repair:end',
  'safety:start', 'safety:end'];

function records() {
  return ['multi_agent', 'single_workflow'].flatMap(variant => labels.flatMap(
    ([caseId, decision]) => [1, 2, 3].map(runIndex => ({
      caseId, variant, runIndex, decision,
      events: variant === 'multi_agent' ? [...route] : ['baseline:start', 'baseline:end'],
      traceId: `synthetic-${variant}-${caseId}-${runIndex}`,
      durationMs: 10, totalTokens: 20,
    })),
  ));
}

test('scores complete redacted repetitions without returning trace identifiers', () => {
  const report = scoreAgentArtsRuns(records());
  assert.equal(report.comparisonReady, true);
  assert.equal(report.multiAgent.correct, 9);
  assert.equal(report.multiAgent.handoffs, 18);
  assert.equal(report.comparison.accuracyDelta, 0);
  assert.doesNotMatch(JSON.stringify(report), /synthetic-/);
});

test('missing trace, missing run and wrong handoff cannot become complete evidence', () => {
  const input = records();
  input[0].traceId = null;
  input[1].events = ['impact:start', 'impact:end', 'safety:start', 'safety:end'];
  input.pop();
  const report = scoreAgentArtsRuns(input);
  assert.equal(report.comparisonReady, false);
  assert.equal(report.comparison, null);
  assert.equal(report.missing.length, 1);
  assert.equal(report.multiAgent.routed, 8);
  assert.equal(report.multiAgent.handoffs, 16);
});

test('rejects duplicate run identity and unredacted record fields', () => {
  const input = records();
  input[1] = {...input[0]};
  assert.throws(() => scoreAgentArtsRuns(input), TypeError);
  assert.throws(() => scoreAgentArtsRuns([{...input[0], rawText: 'private'}]), TypeError);
  const reusedTrace = records();
  reusedTrace[1].traceId = reusedTrace[0].traceId;
  assert.throws(() => scoreAgentArtsRuns(reusedTrace), TypeError);
});
