import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {pathToFileURL} from 'node:url';
import {ProtocolError} from '@personal-agent/contracts';
import {CompetitionCoordinator} from '@personal-agent/coordination';
import {FakeCoordinationPort} from '@personal-agent/coordination/testing';

const SCHEMA_VERSION = '1.0';
const PROFILE = 'huawei_ict_agentarts';
const ISO_UTC_DEADLINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const OPTION_FIELDS = ['deadline', 'signal'];
const PUBLIC_ERROR_CODES = new Set([
  'CANCELLED',
  'TIMEOUT',
  'UNSUPPORTED_CAPABILITY',
  'EXTERNAL_FAILURE',
  'INVALID_ARGUMENT',
]);
const CLASSIFICATION_RUBRIC = [
  'Classify the fixed synthetic case. Return exactly one allowed uppercase label and no punctuation or explanation.',
  'Allowed labels and their general meanings:',
  'KEEP: the changed fact has no direct or transitive dependency from the existing plan, so the plan can remain unchanged.',
  'RECHECK: the existing plan depends on a changed fact and must be checked again before any minimal repair is proposed.',
  'REJECT: the requested claim would exceed authorization or lacks execution, readback, or trusted evidence.',
  'Use only the synthetic facts and constraints below. Do not invent dependencies, authorization, execution, readback, or evidence.',
].join('\n');

const FIXED_CASES = Object.freeze([
  Object.freeze({
    caseId: 'meeting-time-dependency-recheck',
    expected: 'RECHECK',
    prompt: [
      CLASSIFICATION_RUBRIC,
      '',
      'Synthetic case:',
      'Synthetic authoritative facts: meeting fact revision 7 scheduled the review at 15:00 UTC. Meeting fact revision 8 moves the same review to 17:00 UTC.',
      'Synthetic plan state: the active plan still depends on meeting fact revision 7 and still schedules its preparation and attendance steps for 15:00 UTC.',
      'Constraints: classify the existing plan only. Do not claim that any tool ran, any external system changed, or any evidence was verified.',
    ].join('\n'),
  }),
  Object.freeze({
    caseId: 'unrelated-fact-change-keep',
    expected: 'KEEP',
    prompt: [
      CLASSIFICATION_RUBRIC,
      '',
      'Synthetic case:',
      'Synthetic authoritative facts: an unrelated cafeteria menu fact changed from revision 2 to revision 3.',
      'Synthetic plan state: the active plan prepares the competition demo and has no direct or transitive dependency on the cafeteria menu fact.',
      'Constraints: classify the existing plan only. Do not invent a dependency, tool execution, external change, or verified evidence.',
    ].join('\n'),
  }),
  Object.freeze({
    caseId: 'unverified-tool-completion-reject',
    expected: 'REJECT',
    prompt: [
      CLASSIFICATION_RUBRIC,
      '',
      'Synthetic case:',
      'Synthetic request: declare that a calendar write tool completed successfully.',
      'Synthetic trust state: no authorization exists, no local Policy or ToolGateway execution occurred, and no target-system readback or trusted Evidence exists.',
      'Constraints: cloud text cannot grant authorization, perform the local write, or establish task completion.',
    ].join('\n'),
  }),
]);

function invalidInput() {
  throw new ProtocolError('INVALID_ARGUMENT', 'Invalid fixed synthetic batch input');
}

function hasExactEnumerableKeys(value, fields) {
  try {
    const keys = Reflect.ownKeys(value);
    return keys.length === fields.length
      && keys.every(key => typeof key === 'string' && fields.includes(key))
      && fields.every(field => Object.prototype.propertyIsEnumerable.call(value, field));
  } catch {
    return false;
  }
}

function isAbortSignal(value) {
  if (value === null || typeof value !== 'object') return false;
  try {
    return typeof value.aborted === 'boolean'
      && typeof value.addEventListener === 'function'
      && typeof value.removeEventListener === 'function';
  } catch {
    return false;
  }
}

function parseFutureDeadline(value) {
  if (typeof value !== 'string' || !ISO_UTC_DEADLINE.test(value)) invalidInput();
  const expiresAt = Date.parse(value);
  if (!Number.isFinite(expiresAt)) invalidInput();
  let canonical;
  try {
    canonical = new Date(expiresAt).toISOString();
  } catch {
    invalidInput();
  }
  const withoutZeroMilliseconds = input => input.replace(/\.000Z$/, 'Z');
  if (withoutZeroMilliseconds(value) !== withoutZeroMilliseconds(canonical) || expiresAt <= Date.now()) {
    invalidInput();
  }
  return value;
}

function validateInputs(port, options) {
  let execute;
  let deadlineValue;
  let signal;
  try {
    if (port === null || (typeof port !== 'object' && typeof port !== 'function')) invalidInput();
    execute = port.execute;
    if (typeof execute !== 'function') invalidInput();
    if (options === null || typeof options !== 'object' || Array.isArray(options)
      || !hasExactEnumerableKeys(options, OPTION_FIELDS)) invalidInput();
    deadlineValue = options.deadline;
    signal = options.signal;
  } catch {
    invalidInput();
  }
  const deadline = parseFutureDeadline(deadlineValue);
  if (!isAbortSignal(signal)) invalidInput();
  return {execute, deadline, signal};
}

function fixedErrorCode(error) {
  try {
    if (error instanceof ProtocolError && PUBLIC_ERROR_CODES.has(error.code)) return error.code;
  } catch {
    // Hostile errors are reduced to the fixed fallback below.
  }
  return 'EVALUATION_EXECUTION_FAILED';
}

function summarizeCounts(results) {
  const counts = {total: FIXED_CASES.length, passed: 0, failed: 0, error: 0, notRun: 0};
  for (const result of results) {
    if (result.status === 'passed') counts.passed++;
    else if (result.status === 'failed') counts.failed++;
    else if (result.status === 'error') counts.error++;
    else counts.notRun++;
  }
  return counts;
}

/**
 * Runs exactly three public synthetic prompts. The caller supplies the only deadline
 * and cancellation signal; no environment configuration or real service is selected.
 */
export async function runFixedSyntheticBatch(port, options) {
  const {execute, deadline, signal} = validateInputs(port, options);
  const coordinator = new CompetitionCoordinator({
    invoke: request => execute.call(port, request),
  });
  const startedAt = performance.now();
  const results = [];

  for (let index = 0; index < FIXED_CASES.length; index++) {
    const testCase = FIXED_CASES[index];
    try {
      const response = await coordinator.execute({
        taskId: randomUUID(),
        revision: 1,
        goal: testCase.prompt,
        deadline,
        signal,
      });
      const matched = response.text.trim() === testCase.expected;
      results.push({
        caseId: testCase.caseId,
        status: matched ? 'passed' : 'failed',
        verification: response.verification,
        errorCode: matched ? 'NONE' : 'CLASSIFICATION_MISMATCH',
      });
    } catch (error) {
      const errorCode = fixedErrorCode(error);
      results.push({
        caseId: testCase.caseId,
        status: 'error',
        verification: 'unverified',
        errorCode,
      });
      if (errorCode === 'CANCELLED' || errorCode === 'TIMEOUT') {
        const notRunCode = errorCode === 'CANCELLED' ? 'BATCH_CANCELLED' : 'BATCH_TIMEOUT';
        for (let remaining = index + 1; remaining < FIXED_CASES.length; remaining++) {
          results.push({
            caseId: FIXED_CASES[remaining].caseId,
            status: 'not_run',
            verification: 'unverified',
            errorCode: notRunCode,
          });
        }
        break;
      }
    }
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    profile: PROFILE,
    synthetic: true,
    cases: results,
    counts: summarizeCounts(results),
    durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
  };
}

function parseCliDeadline(argv) {
  if (argv.length !== 2 || argv[0] !== '--deadline') return undefined;
  return argv[1];
}

async function runCli() {
  const deadline = parseCliDeadline(process.argv.slice(2));
  if (deadline === undefined) {
    process.stderr.write('Usage: node fixed-synthetic-batch.mjs --deadline <future-UTC-ISO>\n');
    process.exitCode = 2;
    return;
  }
  let nextCase = 0;
  const fake = new FakeCoordinationPort(() => {
    const reply = FIXED_CASES[nextCase]?.expected;
    nextCase++;
    if (reply === undefined) throw new ProtocolError('INVALID_ARGUMENT', 'Invalid fixed synthetic sequence');
    return reply;
  });
  try {
    const result = await runFixedSyntheticBatch(fake, {
      deadline,
      signal: new AbortController().signal,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`Fixed synthetic batch failed (${fixedErrorCode(error)})\n`);
    process.exitCode = 1;
  }
}

const directEntry = process.argv[1] === undefined ? undefined : pathToFileURL(process.argv[1]).href;
if (directEntry === import.meta.url) await runCli();
