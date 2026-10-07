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

test('empty event lists never count as routed and sparse event arrays are rejected', () => {
  const input = records();
  input[0].events = [];
  const report = scoreAgentArtsRuns([input[0]]);
  assert.equal(report.multiAgent.routed, 0);
  assert.equal(report.multiAgent.routeConformance, 0);
  assert.equal(report.multiAgent.handoffs, 0);
  for (const events of [Array(6), Object.assign(Array(6), {0: 'impact:start'})]) {
    assert.throws(() => scoreAgentArtsRuns([{...input[0], events}]),
      {name: 'TypeError', message: 'Invalid AgentArts evaluation record'});
  }
});

test('event array accessors and custom array methods cannot forge routing or run during scoring', () => {
  let calls = 0;
  const getter = [...route];
  Object.defineProperty(getter, '0', {enumerable: true, get() { calls++; return 'impact:start'; }});
  const every = [...route]; every.every = () => { calls++; return true; };
  const some = [...route]; some.some = () => { calls++; return false; };
  const symbol = [...route]; symbol[Symbol('extra')] = 'private';
  const extra = [...route]; extra.extra = 'private';
  const hidden = [...route]; Object.defineProperty(hidden, 'extra', {value: 'private'});
  for (const events of [getter, every, some, symbol, extra, hidden]) {
    assert.throws(() => scoreAgentArtsRuns([{...records()[0], events}]),
      {name: 'TypeError', message: 'Invalid AgentArts evaluation record'});
  }
  assert.equal(calls, 0);
});

test('event snapshots preserve valid JSON lists and the original 24-event bound', () => {
  const input = records();
  const jsonInput = JSON.parse(JSON.stringify(input));
  assert.deepEqual(scoreAgentArtsRuns(input), scoreAgentArtsRuns(jsonInput));
  assert.equal(Object.isFrozen(input[0].events), false);
  assert.deepEqual(input[0].events, route);
  const repeated = Array(24).fill('impact:start');
  const report = scoreAgentArtsRuns([{...input[0], events: repeated}]);
  assert.equal(report.multiAgent.routed, 0);
  assert.equal(report.multiAgent.handoffs, 0);
  assert.throws(() => scoreAgentArtsRuns([{...input[0], events: [...repeated, 'impact:start']}]), TypeError);
});
