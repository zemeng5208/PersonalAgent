import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {runMeetingReplay} from './meeting-replay.mjs';

const repetitions = 3;
const candidateIds = ['attendance', 'departure', 'reminder', 'reading'];
const stageExpectations = [
  ['baseline', []],
  ['corrected', ['attendance', 'departure', 'reminder']],
  ['partiallyRebound', ['departure', 'reminder']],
  ['repaired', []],
];

function recheckIds(items) {
  assert.equal(items.length, candidateIds.length, 'stage must contain only the fixed candidates');
  const candidateItems = items.filter(item => candidateIds.includes(item.id));
  assert.equal(candidateItems.length, candidateIds.length, 'each candidate must appear exactly once');
  const byId = new Map(candidateItems.map(item => [item.id, item]));
  assert.equal(byId.size, candidateIds.length, 'candidate IDs must be unique');
  return candidateIds.filter(id => {
    const item = byId.get(id);
    assert.ok(item, `meeting replay stage is missing ${id}`);
    assert.ok(item.action === 'KEEP' || item.action === 'RECHECK', `unexpected action for ${id}`);
    return item.action === 'RECHECK';
  });
}

function confusion(expectedIds, observedIds) {
  const expected = new Set(expectedIds);
  const observed = new Set(observedIds);
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let trueNegative = 0;
  for (const id of candidateIds) {
    if (expected.has(id) && observed.has(id)) truePositive++;
    else if (!expected.has(id) && observed.has(id)) falsePositive++;
    else if (expected.has(id)) falseNegative++;
    else trueNegative++;
  }
  const predictedPositive = truePositive + falsePositive;
  const actualPositive = truePositive + falseNegative;
  return {
    truePositive,
    falsePositive,
    falseNegative,
    trueNegative,
    precision: predictedPositive === 0 ? null : truePositive / predictedPositive,
    recall: actualPositive === 0 ? null : truePositive / actualPositive,
    unnecessaryRechecks: falsePositive,
  };
}

function aggregate(cases, field) {
  const totals = cases.reduce((result, item) => {
    const metrics = item[field].metrics;
    result.truePositive += metrics.truePositive;
    result.falsePositive += metrics.falsePositive;
    result.falseNegative += metrics.falseNegative;
    result.trueNegative += metrics.trueNegative;
    return result;
  }, {truePositive: 0, falsePositive: 0, falseNegative: 0, trueNegative: 0});
  const totalDecisions = Object.values(totals).reduce((sum, value) => sum + value, 0);
  const correctDecisions = totals.truePositive + totals.trueNegative;
  return {
    ...totals,
    totalDecisions,
    correctDecisions,
    accuracy: totalDecisions === 0 ? null : correctDecisions / totalDecisions,
    unnecessaryRechecks: totals.falsePositive,
  };
}

function evaluateReplay() {
  const replay = runMeetingReplay();
  const cases = stageExpectations.map(([stage, expectedRecheckIds]) => {
    const observedRecheckIds = recheckIds(replay.stages[stage]);
    return {
      stage,
      expectedRecheckIds: [...expectedRecheckIds],
      domainAlgorithm: {
        observedRecheckIds,
        metrics: confusion(expectedRecheckIds, observedRecheckIds),
      },
      naiveReference: {
        observedRecheckIds: [...candidateIds],
        metrics: confusion(expectedRecheckIds, candidateIds),
      },
    };
  });
  return {
    evaluatedAt: replay.evaluatedAt,
    candidateIds: [...candidateIds],
    cases,
    summary: {
      domainAlgorithm: aggregate(cases, 'domainAlgorithm'),
      naiveReference: aggregate(cases, 'naiveReference'),
    },
  };
}

export function runImpactEvaluation() {
  const samples = Array.from({length: repetitions}, () => evaluateReplay());
  const canonical = JSON.stringify(samples[0]);
  const stable = samples.every(sample => JSON.stringify(sample) === canonical);
  assert.equal(stable, true, 'repeated in-memory meeting replay must stay deterministic');
  return {
    profile: 'huawei_ict_agentarts',
    verification: 'mock',
    cloudEvaluation: false,
    externalActionsExecuted: false,
    referenceBaseline: {
      name: 'always_recheck_all_candidates',
      behavior: 'Marks attendance, departure, reminder and reading as RECHECK in every stage.',
    },
    metricSemantics: {
      positiveDecision: 'RECHECK',
      precisionOrRecallWithZeroDenominator: null,
      unnecessaryRechecks: 'False-positive RECHECK decisions.',
    },
    measurementBoundary: 'Decision counts only; no latency, token or cost benefit was measured.',
    stability: {
      repetitions,
      repeatedInMemory: true,
      stable,
      independentSamples: false,
      interpretation: 'Repeated deterministic replays are a stability check, not statistical significance.',
    },
    ...samples[0],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(runImpactEvaluation(), null, 2));
}
