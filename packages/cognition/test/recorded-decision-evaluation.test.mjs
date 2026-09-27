import assert from 'node:assert/strict';
import {test} from 'node:test';
import {scoreRecordedDecisions} from '../evaluation/score-recorded.mjs';

const labels = ['IGNORE', 'REMIND', 'REQUEST_DECISION', 'ESCALATE_AGENTARTS',
  'EXECUTE', 'MERGE', 'DEFER'];
const recorded = ['IGNORE', 'ESCALATE_AGENTARTS', 'REQUEST_DECISION', 'DEFER',
  'ESCALATE_AGENTARTS', 'EXECUTE', 'DEFER'];
const cases = labels.map((expected, index) => ({
  caseId: `synthetic-${index}`, source: 'fixed-synthetic', eventId: `event-${index}`, expected,
}));
const suggestions = recorded.map((intervention, index) => ({
  source: 'fixed-synthetic', eventId: `event-${index}`, intervention,
  confidence: index === 1 ? null : 0.9,
  reason: index === 1 ? 'model_unavailable' : 'model',
}));

test('scores independently labeled synthetic records without losing safety errors', () => {
  const result = scoreRecordedDecisions(cases, [...suggestions].reverse());
  assert.equal(result.total, 7);
  assert.equal(result.exactMatches, 3);
  assert.equal(result.accuracy, 3 / 7);
  assert.equal(result.falseSilentSuppressions, 1);
  assert.equal(result.falseExecutionSuggestions, 1);
  assert.equal(result.escalationRate, 2 / 7);
  assert.equal(result.actionableCoverage, 1 / 3);
  assert.deepEqual(result.byExpected, Object.fromEntries(labels.map(label => [label, 1])));
  assert.equal(result.bySuggestion.DEFER, 2);
  assert.equal(result.bySuggestion.ESCALATE_AGENTARTS, 2);
  assert.equal(result.confusion.ESCALATE_AGENTARTS.DEFER, 1);
  assert.equal(result.confusion.MERGE.EXECUTE, 1);
  assert.deepEqual(result.mismatches.map(item => item.caseId),
    ['synthetic-1', 'synthetic-3', 'synthetic-4', 'synthetic-5']);
  assert.equal(JSON.stringify(result).includes('fixed-synthetic'), false,
    'aggregate output does not repeat the event source');
});

test('rejects unmatched and ambiguous identities and unredacted input', () => {
  assert.throws(() => scoreRecordedDecisions(cases, suggestions.slice(1)), /unmatched identity/);
  assert.throws(() => scoreRecordedDecisions(cases, [...suggestions.slice(0, -1),
    {...suggestions[6], eventId: 'other'}]), /unmatched identity/);
  assert.throws(() => scoreRecordedDecisions([...cases, cases[0]], suggestions), /duplicate case/);
  assert.throws(() => scoreRecordedDecisions(cases, [...suggestions, suggestions[0]]),
    /duplicate suggestion/);
  assert.throws(() => scoreRecordedDecisions(cases, suggestions.map((item, index) => index === 0
    ? {...item, observation: 'Private text must not enter the scorer'} : item)), /record shape/);
  assert.throws(() => scoreRecordedDecisions(cases, suggestions.map((item, index) => index === 0
    ? {...item, confidence: Infinity} : item)), /confidence/);
  assert.throws(() => scoreRecordedDecisions(cases, suggestions.map((item, index) => index === 0
    ? {...item, intervention: 'DELETE'} : item)), /intervention/);
});

test('empty input has explicit null denominators', () => {
  const result = scoreRecordedDecisions([], []);
  assert.deepEqual({total: result.total, accuracy: result.accuracy,
    escalationRate: result.escalationRate, actionableCoverage: result.actionableCoverage},
  {total: 0, accuracy: null, escalationRate: null, actionableCoverage: null});
  assert.deepEqual(result.mismatches, []);
});
