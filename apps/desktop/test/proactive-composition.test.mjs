import test from 'node:test';
import assert from 'node:assert/strict';
import {createProactiveComposition} from '../electron/proactive-composition.js';

function fixture(extra = {}) {
  let time = Date.parse('2026-09-27T00:00:00.000Z');
  const values = new Map();
  const storage = {get: key => structuredClone(values.get(key)), set: (key, value) => values.set(key, structuredClone(value))};
  const tasks = new Map();
  const calls = [];
  const application = {profile: 'huawei_ict_agentarts', runtime: {getTask: id => structuredClone(tasks.get(id))},
    readRepairCandidate: () => undefined,
    submitLocalRepair: request => { calls.push(request); return {taskId: 'repair-1', state: 'waiting_approval'}; }};
  const options = {application, storage, now: () => time, ...extra};
  const host = createProactiveComposition(options); host.start();
  function sample(seconds, cpu = 95, memory = 30) {
    time = Date.parse('2026-09-27T00:00:00.000Z') + seconds * 1000;
    return {toolName: 'computer.system.observe', toolVersion: '1.0.0', task: {taskId: `observe-${seconds}`, state: 'succeeded'},
      confirmed: {evidenceRefs: [`evidence-${seconds}`], result: {source: 'node:os', capturedAt: new Date(time).toISOString(),
        cpu: {utilizationPercent: cpu}, memory: {utilizationPercent: memory}}}};
  }
  const feed = (seconds, cpu, memory) => host.acceptObservation(sample(seconds, cpu, memory));
  return {host, options, storage, sample, feed, calls, tasks};
}

test('sustained pressure, dedupe, recovery and cooldown survive restart', () => {
  const f = fixture();
  assert.deepEqual(f.feed(0), []);
  assert.deepEqual(f.feed(30), []);
  assert.equal(f.feed(60).length, 1);
  assert.deepEqual(f.feed(60), []);
  assert.deepEqual(f.feed(90), []);
  f.feed(100, 30);
  f.feed(120); f.feed(150);
  assert.deepEqual(f.feed(180), []);
  f.feed(210); f.feed(240); f.feed(270); f.feed(300); f.feed(330);
  assert.equal(f.feed(360).length, 1);
  f.host.stop();
  const restored = createProactiveComposition(f.options); restored.start();
  assert.equal(restored.list().length, 2);
  assert.deepEqual(restored.acceptObservation(f.sample(390)), []);
});

test('spikes, sample gaps, injected samples and pending results cannot alert', () => {
  const f = fixture();
  f.feed(0); f.feed(30, 20); f.feed(60); f.feed(150); f.feed(180);
  assert.equal(f.host.list().length, 0);
  const fake = f.sample(210); fake.confirmed.result.source = 'injected';
  assert.throws(() => f.host.acceptObservation(fake), {code: 'STALE_OR_SYNTHETIC_OBSERVATION'});
  const pending = f.sample(210); pending.task.state = 'waiting_approval';
  assert.throws(() => f.host.acceptObservation(pending), {code: 'UNCONFIRMED_OBSERVATION'});
  f.host.stop();
  assert.throws(() => f.feed(240), {code: 'UNSUPPORTED_CAPABILITY'});
});

test('cloud disabled by default; only approved aggregate projection and tracked task state', async () => {
  let enabled = false;
  const submissions = [];
  const f = fixture({cloudEnabled: () => enabled, client: {call: async (...args) => {
    submissions.push(args); return {taskId: 'analysis-1'};
  }}});
  f.feed(0); f.feed(30); const [item] = f.feed(60);
  await assert.rejects(f.host.analyze(item.id), {code: 'CLOUD_ANALYSIS_DISABLED'});
  enabled = true;
  await Promise.all([f.host.analyze(item.id), f.host.analyze(item.id)]);
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0][0], 'task.submit');
  assert.doesNotMatch(submissions[0][1].goal, /observe-60|evidence-60|sourceTaskId/);
  f.tasks.set('analysis-1', {taskId: 'analysis-1', state: 'waiting_approval'});
  assert.equal(f.host.refresh(item.id).analysisState, 'waiting_approval');
  assert.equal(f.calls.length, 0);
  assert.equal(f.host.submitRepair(item.id, {evidenceId: 'verified-source', deadline: '2026-09-28T00:00:00.000Z'}).repairState, 'waiting_approval');
  assert.equal(f.calls[0].sourceTaskId, 'analysis-1');
});

test('durable Fact receipts reuse existing impact analysis and replay without duplicates', async () => {
  let drains = 0;
  const receipt = {projection: {batchToken: 'batch-1', graphRevision: 2, links: []},
    completed: {batchToken: 'batch-1', report: {namespace: 'private-host-binding', graphRevision: 2,
      evaluatedAt: '2026-09-27T00:00:00.000Z', items: [{node: {id: 'plan-1', revision: 1}, kind: 'plan', action: 'RECHECK', causes: []}]}}};
  const f = fixture({factHost: {drain: async () => { drains++; return {atWatermark: true}; },
    processImpacts() {}, listImpactReceipts: ({afterGraphRevision}) => afterGraphRevision < 2 ? [receipt] : []},
    cloudEnabled: () => true, client: {call() { assert.fail('unapproved Fact data exported'); }}});
  await Promise.all([f.host.drainFacts(), f.host.drainFacts()]);
  assert.equal(drains, 1);
  assert.equal(f.host.list().length, 1);
  const item = f.host.list()[0];
  assert.equal(item.impact.items[0].node.id, 'plan-1');
  await assert.rejects(f.host.analyze(item.id), {code: 'FACT_CLOUD_PROJECTION_UNAVAILABLE'});
  f.host.stop();
  const restored = createProactiveComposition(f.options); restored.start(); await restored.drainFacts();
  assert.equal(restored.list().length, 1);
});

test('unknown submit preserves idempotency key and original projected payload on explicit retry', async () => {
  const calls = [];
  const f = fixture({cloudEnabled: () => true, client: {call: async (...args) => {
    calls.push(args); if (calls.length === 1) throw Error('transport interrupted'); return {taskId: 'analysis-1'};
  }}});
  f.feed(0); f.feed(30); const [item] = f.feed(60);
  await assert.rejects(f.host.analyze(item.id), /interrupted/);
  assert.equal(f.host.list()[0].analysisState, 'submission_unknown');
  await f.host.analyze(item.id);
  assert.deepEqual(calls[0][1], calls[1][1]);
  assert.equal(calls[0][2].idempotencyKey, calls[1][2].idempotencyKey);
});
