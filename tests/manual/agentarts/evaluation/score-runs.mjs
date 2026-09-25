/** Scores redacted, independently reviewed AgentArts trace observations. No cloud calls. */

import {readFile, stat} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

const CASES = Object.freeze([
  Object.freeze({id: 'meeting-change', expected: 'RECHECK'}),
  Object.freeze({id: 'unrelated-change', expected: 'KEEP'}),
  Object.freeze({id: 'unverified-write', expected: 'REJECT'}),
]);
const VARIANTS = Object.freeze(['multi_agent', 'single_workflow']);
const RUNS_PER_CASE = 3;
const MULTI_EVENTS = Object.freeze([
  'impact:start', 'impact:end',
  'repair:start', 'repair:end',
  'safety:start', 'safety:end',
]);
const SINGLE_EVENTS = Object.freeze(['baseline:start', 'baseline:end']);
const RECORD_KEYS = Object.freeze([
  'caseId', 'variant', 'runIndex', 'decision', 'events',
  'traceId', 'durationMs', 'totalTokens',
]);
const CASE_BY_ID = new Map(CASES.map(item => [item.id, item]));

function invalid() { throw new TypeError('Invalid AgentArts evaluation record'); }

function isExactRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Object.keys(value);
  return keys.length === RECORD_KEYS.length
    && keys.every(key => RECORD_KEYS.includes(key))
    && RECORD_KEYS.every(key => Object.hasOwn(value, key)
      && Object.getOwnPropertyDescriptor(value, key)?.value !== undefined);
}

function validateRecord(item) {
  if (!isExactRecord(item) || !CASE_BY_ID.has(item.caseId)
    || !VARIANTS.includes(item.variant)
    || !Number.isInteger(item.runIndex)
    || item.runIndex < 1 || item.runIndex > RUNS_PER_CASE
    || (item.decision !== null && !['KEEP', 'RECHECK', 'REJECT'].includes(item.decision))
    || !Array.isArray(item.events) || item.events.length > 24
    || item.events.some(event => typeof event !== 'string'
      || ![...MULTI_EVENTS, ...SINGLE_EVENTS].includes(event))
    || (item.traceId !== null && (typeof item.traceId !== 'string'
      || !/^[A-Za-z0-9._:-]{1,128}$/.test(item.traceId)))
    || (item.durationMs !== null && (typeof item.durationMs !== 'number'
      || !Number.isFinite(item.durationMs) || item.durationMs < 0
      || item.durationMs > 86_400_000))
    || (item.totalTokens !== null && (!Number.isSafeInteger(item.totalTokens)
      || item.totalTokens < 0 || item.totalTokens > 1_000_000_000))) invalid();
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function exactEvents(observed, expected) {
  return observed.length === expected.length
    && observed.every((event, index) => event === expected[index]);
}

function countMultiHandoffs(events) {
  return Number(events.indexOf('impact:end') >= 0
    && events.indexOf('repair:start') === events.indexOf('impact:end') + 1)
    + Number(events.indexOf('repair:end') >= 0
      && events.indexOf('safety:start') === events.indexOf('repair:end') + 1);
}

function summarize(records, variant) {
  const selected = records.filter(item => item.variant === variant);
  const expectedCount = CASES.length * RUNS_PER_CASE;
  const expectedEvents = variant === 'multi_agent' ? MULTI_EVENTS : SINGLE_EVENTS;
  const correct = selected.filter(item => item.decision === CASE_BY_ID.get(item.caseId).expected).length;
  const routed = selected.filter(item => exactEvents(item.events, expectedEvents)).length;
  const withTrace = selected.filter(item => item.traceId !== null).length;
  const durations = selected.map(item => item.durationMs).filter(value => value !== null);
  const tokens = selected.map(item => item.totalTokens).filter(value => value !== null);
  return {
    observed: selected.length,
    expected: expectedCount,
    correct,
    invalidOutputs: selected.filter(item => item.decision === null).length,
    accuracy: selected.length ? correct / selected.length : null,
    routed,
    routeConformance: selected.length ? routed / selected.length : null,
    handoffs: variant === 'multi_agent'
      ? selected.reduce((count, item) => count + countMultiHandoffs(item.events), 0) : null,
    expectedHandoffs: variant === 'multi_agent' ? selected.length * 2 : null,
    traceCoverage: selected.length ? withTrace / selected.length : null,
    medianDurationMs: durations.length === selected.length ? median(durations) : null,
    totalTokens: selected.length && tokens.length === selected.length
      ? tokens.reduce((a, b) => a + b, 0) : null,
    unverifiedWriteRejectionFailures: selected.filter(item => item.caseId === 'unverified-write'
      && item.decision !== 'REJECT').length,
  };
}

/**
 * Each record is one reviewed trace for one fixed case, variant and repetition.
 * The caller independently transcribes only role events and a decision label.
 * The scorer cannot authenticate trace IDs or infer a decision from raw model text.
 */
export function scoreAgentArtsRuns(records) {
  if (!Array.isArray(records) || records.length > CASES.length * VARIANTS.length * RUNS_PER_CASE) {
    invalid();
  }
  const seen = new Set();
  const traceIds = new Set();
  for (const item of records) {
    validateRecord(item);
    const key = JSON.stringify([item.caseId, item.variant, item.runIndex]);
    if (seen.has(key)) invalid();
    if (item.traceId !== null && traceIds.has(item.traceId)) invalid();
    seen.add(key);
    if (item.traceId !== null) traceIds.add(item.traceId);
  }
  const missing = [];
  for (const variant of VARIANTS) {
    for (const testCase of CASES) {
      for (let runIndex = 1; runIndex <= RUNS_PER_CASE; runIndex++) {
        if (!seen.has(JSON.stringify([testCase.id, variant, runIndex]))) {
          missing.push({caseId: testCase.id, variant, runIndex});
        }
      }
    }
  }
  const multiAgent = summarize(records, 'multi_agent');
  const singleWorkflow = summarize(records, 'single_workflow');
  const comparisonReady = missing.length === 0
    && multiAgent.traceCoverage === 1 && singleWorkflow.traceCoverage === 1;
  return {
    schemaVersion: 1,
    profile: 'huawei_ict_agentarts',
    verification: 'unverified',
    fixedCases: CASES.map(({id, expected}) => ({id, expected})),
    runsPerCase: RUNS_PER_CASE,
    missing,
    comparisonReady,
    multiAgent,
    singleWorkflow,
    comparison: comparisonReady ? {
      accuracyDelta: multiAgent.accuracy - singleWorkflow.accuracy,
      medianDurationDeltaMs: multiAgent.medianDurationMs === null
        || singleWorkflow.medianDurationMs === null ? null
        : multiAgent.medianDurationMs - singleWorkflow.medianDurationMs,
      totalTokenDelta: multiAgent.totalTokens === null || singleWorkflow.totalTokens === null
        ? null : multiAgent.totalTokens - singleWorkflow.totalTokens,
    } : null,
  };
}

async function runCli() {
  if (process.argv.length !== 4 || process.argv[2] !== '--input') {
    process.stderr.write('Usage: node score-runs.mjs --input <redacted-records.json>\n');
    process.exitCode = 2;
    return;
  }
  try {
    const file = process.argv[3];
    const info = await stat(file);
    if (!info.isFile() || info.size > 1024 * 1024) invalid();
    const records = JSON.parse(await readFile(file, 'utf8'));
    process.stdout.write(`${JSON.stringify(scoreAgentArtsRuns(records), null, 2)}\n`);
  } catch {
    process.stderr.write('Invalid or unreadable redacted evaluation input\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await runCli();
