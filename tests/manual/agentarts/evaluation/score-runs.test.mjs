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
      caseId, variant, runIndex, decision, errorCode: 'NONE',
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
  assert.equal(report.comparison.pairedRuns, 9);
  assert.equal(report.comparison.accuracyDelta, 0);
  assert.doesNotMatch(JSON.stringify(report), /synthetic-/);
});

test('missing trace, missing run and wrong handoff cannot become complete evidence', () => {
  const input = records().filter(item => item.runIndex === 1);
  input[0].traceId = null;
  input[1].events = ['impact:start', 'impact:end', 'safety:start', 'safety:end'];
  input.pop();
  const report = scoreAgentArtsRuns(input);
  assert.equal(report.comparisonReady, false);
  assert.equal(report.comparison, null);
  assert.deepEqual(report.missingMultiAgentCases, ['meeting-change']);
  assert.equal(report.missingComparisonCases.length, 2);
  assert.equal(report.multiAgent.routed, 2);
  assert.equal(report.multiAgent.handoffs, 4);
});

test('accepts one observed run per case without requiring a baseline or repeats', () => {
  const input = records().filter(item => item.variant === 'multi_agent'
    && item.runIndex === 1);
  const report = scoreAgentArtsRuns(input);
  assert.equal(report.multiAgentEvidenceComplete, true);
  assert.equal(report.comparisonReady, false);
  assert.equal(report.multiAgent.observed, 3);
  assert.equal(report.singleWorkflow.observed, 0);
  assert.equal(report.singleWorkflow.totalTokens, null);
  const paired = scoreAgentArtsRuns(records().filter(item => item.runIndex === 1));
  assert.equal(paired.comparisonReady, true);
  assert.equal(paired.comparison.pairedRuns, 3);
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

test('classifies failed calls separately from incorrect decisions', () => {
  const input = records();
  input[0].decision = null;
  input[0].errorCode = 'TIMEOUT';
  input[0].traceId = null;
  const report = scoreAgentArtsRuns(input);
  assert.equal(report.multiAgent.errorCounts.TIMEOUT, 1);
  assert.equal(report.multiAgent.correct, 8);
  assert.equal(report.comparisonReady, false);
  assert.throws(() => scoreAgentArtsRuns([{...input[0], errorCode: 'NONE'}]), TypeError);
});
