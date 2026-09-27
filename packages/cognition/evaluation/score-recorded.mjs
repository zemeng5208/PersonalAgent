/** Offline scoring of independently labeled, redacted DecisionSuggestion records. */

const INTERVENTIONS = Object.freeze([
  'IGNORE', 'MERGE', 'DEFER', 'REMIND', 'REQUEST_DECISION', 'EXECUTE',
  'ESCALATE_AGENTARTS',
]);
const REASONS = new Set([
  'rule_duplicate', 'model', 'uncalibrated_model', 'low_confidence',
  'model_unavailable',
]);
const QUIET = new Set(['IGNORE', 'MERGE', 'DEFER']);
const DIRECT = new Set(['REMIND', 'REQUEST_DECISION', 'EXECUTE']);

function invalid(message) { throw new TypeError(`Invalid recorded decision evaluation: ${message}`); }

function exactRecord(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !keys.includes(key))) invalid('record shape');
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) invalid('record shape');
  }
  return value;
}

function identifier(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128
    || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) invalid('identifier');
  return value;
}

function intervention(value) {
  if (!INTERVENTIONS.includes(value)) invalid('intervention');
  return value;
}

function identity(source, eventId) { return JSON.stringify([source, eventId]); }

function countLabels() { return Object.fromEntries(INTERVENTIONS.map(label => [label, 0])); }

/**
 * Cases: {caseId, source, eventId, expected}.
 * Suggestions are redacted projections: {source, eventId, intervention, confidence, reason}.
 * No event observations, model text, credentials, or local files enter this scorer.
 * A reference label is supplied by an independent reviewer, not inferred here.
 * actionableCoverage counts exact direct labels among reference REMIND,
 * REQUEST_DECISION and EXECUTE cases; escalation is a safe abstention, not coverage.
 * These counts do not calibrate model confidence or authorize any action.
 */
export function scoreRecordedDecisions(labeledCases, recordedSuggestions) {
  if (!Array.isArray(labeledCases) || !Array.isArray(recordedSuggestions)
    || labeledCases.length > 10_000 || recordedSuggestions.length > 10_000) {
    invalid('batch');
  }
  const labels = new Map();
  const caseIds = new Set();
  for (const raw of labeledCases) {
    const item = exactRecord(raw, ['caseId', 'source', 'eventId', 'expected']);
    const caseId = identifier(item.caseId);
    const key = identity(identifier(item.source), identifier(item.eventId));
    intervention(item.expected);
    if (caseIds.has(caseId) || labels.has(key)) invalid('duplicate case');
    caseIds.add(caseId);
    labels.set(key, item);
  }
  const suggestions = new Map();
  for (const raw of recordedSuggestions) {
    const item = exactRecord(raw, ['source', 'eventId', 'intervention', 'confidence', 'reason']);
    const key = identity(identifier(item.source), identifier(item.eventId));
    intervention(item.intervention);
    if (item.confidence !== null && (typeof item.confidence !== 'number'
      || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1)) {
      invalid('confidence');
    }
    if (!REASONS.has(item.reason)) invalid('reason');
    if (suggestions.has(key)) invalid('duplicate suggestion');
    suggestions.set(key, item);
  }
  if (labels.size !== suggestions.size
    || [...labels.keys()].some(key => !suggestions.has(key))) invalid('unmatched identity');

  const byExpected = countLabels();
  const bySuggestion = countLabels();
  const confusion = Object.fromEntries(INTERVENTIONS.map(label => [label, countLabels()]));
  const mismatches = [];
  let exactMatches = 0;
  let falseSilentSuppressions = 0;
  let falseExecutionSuggestions = 0;
  let directEligible = 0;
  let directCorrect = 0;
  for (const [key, item] of labels) {
    const suggestion = suggestions.get(key);
    byExpected[item.expected]++;
    bySuggestion[suggestion.intervention]++;
    confusion[item.expected][suggestion.intervention]++;
    if (suggestion.intervention === item.expected) exactMatches++;
    else mismatches.push({caseId: item.caseId, expected: item.expected,
      suggested: suggestion.intervention});
    if (!QUIET.has(item.expected) && QUIET.has(suggestion.intervention)) falseSilentSuppressions++;
    if (item.expected !== 'EXECUTE' && suggestion.intervention === 'EXECUTE') {
      falseExecutionSuggestions++;
    }
    if (DIRECT.has(item.expected)) {
      directEligible++;
      if (suggestion.intervention === item.expected) directCorrect++;
    }
  }
  const total = labels.size;
  return {
    total, exactMatches, accuracy: total ? exactMatches / total : null,
    byExpected, bySuggestion, confusion,
    falseSilentSuppressions, falseExecutionSuggestions,
    escalationRate: total ? bySuggestion.ESCALATE_AGENTARTS / total : null,
    actionableCoverage: directEligible ? directCorrect / directEligible : null,
    mismatches,
  };
}
