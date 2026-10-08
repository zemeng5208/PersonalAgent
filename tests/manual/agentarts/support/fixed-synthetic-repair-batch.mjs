import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {ProtocolError} from '@personal-agent/contracts';
import {CompetitionCoordinator, parseCoordinationRepairCandidate} from '@personal-agent/coordination';
import {buildFixedSyntheticRepairCases} from './fixed-synthetic-repair-cases.mjs';

const ERRORS = new Set(['CANCELLED', 'TIMEOUT', 'UNSUPPORTED_CAPABILITY',
  'EXTERNAL_FAILURE', 'INVALID_ARGUMENT']);

function invalid() {
  throw new ProtocolError('INVALID_ARGUMENT', 'Invalid fixed synthetic repair batch input');
}

function inputs(port, options) {
  try {
    if (!port || !['object', 'function'].includes(typeof port)) invalid();
    const execute = port.execute;
    if (typeof execute !== 'function' || !options || typeof options !== 'object'
      || Array.isArray(options)) invalid();
    const keys = Reflect.ownKeys(options);
    if (keys.some(key => !['deadline', 'signal', 'repetitions'].includes(key))
      || !keys.includes('deadline') || !keys.includes('signal')) invalid();
    const copy = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(options, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
      copy[key] = descriptor.value;
    }
    const {deadline, signal, repetitions = 1} = copy;
    if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 3
      || typeof deadline !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(deadline)) invalid();
    const expiresAt = Date.parse(deadline);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()
      || deadline.replace(/\.000Z$/, 'Z') !== new Date(expiresAt).toISOString().replace(/\.000Z$/, 'Z')
      || !(signal instanceof AbortSignal)) invalid();
    return {execute: request => execute.call(port, request), deadline, signal, repetitions, expiresAt};
  } catch {
    invalid();
  }
}

function sameRef(left, right) {
  return left.id === right.id && left.revision === right.revision;
}

function score(actual, expected) {
  const byId = new Map(actual.changes.map(change => [change.node.id, change]));
  const positions = new Map(actual.changes.map((change, index) => [change.node.id, index]));
  const checks = {
    graphRevision: actual.expectedGraphRevision === expected.expectedGraphRevision,
    nodeSet: actual.changes.length === expected.changes.length
      && expected.changes.every(change => byId.has(change.node.id)),
    nodeRevisions: expected.changes.every(change => {
      const observed = byId.get(change.node.id);
      return observed !== undefined && sameRef(observed.node, change.node);
    }),
    summaries: expected.changes.every(change => byId.get(change.node.id)?.summary === change.summary),
    dependencies: expected.changes.every(change => {
      const observed = byId.get(change.node.id);
      return observed !== undefined && observed.dependencies.length === change.dependencies.length
        && change.dependencies.every(ref => observed.dependencies.some(other => sameRef(ref, other)));
    }),
    // Stored repairs are applied in order: a dependency on a changed node's new
    // revision must follow that node's change. Independent changes can be reordered.
    dependencyOrder: actual.changes.every((change, index) => change.dependencies.every(ref => {
      const target = byId.get(ref.id);
      return !target || ref.revision !== target.node.revision + 1 || positions.get(ref.id) < index;
    })),
  };
  return checks;
}

/**
 * Scores only fixed, synthetic minimum repairs. No service selection, credentials,
 * graph/tool/task writes, or platform trace/quality claims are made by this runner.
 */
export async function runFixedSyntheticRepairBatch(port, options) {
  const {execute, deadline, signal, repetitions, expiresAt} = inputs(port, options);
  const fixtures = buildFixedSyntheticRepairCases().map(item => ({caseId: item.caseId,
    goal: item.goal, expected: parseCoordinationRepairCandidate({kind: 'repair_candidate',
      candidateVersion: '1.0', candidate: item.expected, verification: 'unverified'}).candidate}));
  const coordinator = new CompetitionCoordinator({invoke: execute});
  const lifecycle = () => signal.aborted ? 'CANCELLED' : Date.now() >= expiresAt ? 'TIMEOUT' : null;
  const startedAt = performance.now();
  const cases = [];
  let stopReason = null;
  for (let runIndex = 1; runIndex <= repetitions; runIndex++) {
    for (const fixture of fixtures) {
      stopReason = lifecycle();
      if (stopReason) break;
      const began = performance.now();
      let entry;
      try {
        const result = await coordinator.execute({taskId: randomUUID(), revision: 1,
          goal: fixture.goal, deadline, signal});
        if (result.kind !== 'repair_candidate') {
          entry = {status: 'failed', verification: result.verification,
            errorCode: 'RESULT_KIND_MISMATCH', checks: null};
        } else {
          const checks = score(result.candidate, fixture.expected);
          const matched = Object.values(checks).every(Boolean);
          entry = {status: matched ? 'passed' : 'failed', verification: result.verification,
            errorCode: matched ? 'NONE' : 'REPAIR_MISMATCH', checks};
        }
      } catch (error) {
        let code = 'EVALUATION_EXECUTION_FAILED';
        try {if (error instanceof ProtocolError && ERRORS.has(error.code)) code = error.code;} catch {}
        entry = {status: 'error', verification: null, errorCode: code, checks: null};
      }
      cases.push({caseId: fixture.caseId, runIndex, ...entry,
        durationMs: Math.max(0, Math.round(performance.now() - began))});
      stopReason = ['CANCELLED', 'TIMEOUT'].includes(entry.errorCode) ? entry.errorCode : lifecycle();
      if (stopReason) break;
    }
    if (stopReason) break;
  }
  const counts = {total: fixtures.length * repetitions, attempted: cases.length,
    passed: cases.filter(item => item.status === 'passed').length,
    failed: cases.filter(item => item.status === 'failed').length,
    error: cases.filter(item => item.status === 'error').length,
    notRun: fixtures.length * repetitions - cases.length};
  return {schemaVersion: '1.0', profile: 'huawei_ict_agentarts', synthetic: true,
    verification: 'unverified', requestedRepetitions: repetitions, stopReason, counts,
    accuracy: counts.attempted ? counts.passed / counts.attempted : null, cases,
    durationMs: Math.max(0, Math.round(performance.now() - startedAt))};
}
