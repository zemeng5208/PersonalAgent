import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {Client} from '@personal-agent/client';
import {LayaActionChoiceService} from '@personal-agent/cognition';
import {createRuntimeApplication} from '../dist/application.js';
import {createProactiveCognitionHost} from '../dist/application/proactive-cognition-host.js';

const at = '2026-09-27T03:00:00.000Z';
const graphNamespace = 'synthetic-cognition-graph';
const memoryNamespace = 'synthetic-public-memory';
const source = {vaultId: 'public-demo', path: 'meeting.md', factId: 'meeting/update'};
const ref = (id, revision = 1) => ({id, revision});
const context = (delay = 60_000) => ({deadline: new Date(Date.now() + delay).toISOString(),
  signal: new AbortController().signal});
const node = (id, kind, dependencies, summary = id) => ({
  id, kind, dependencies, summary, sourceRef: 'synthetic/meeting',
  sensitivity: 'public', state: 'active', reason: 'fixture',
  validFrom: '2026-09-25T00:00:00.000Z', validUntil: '2099-01-01T00:00:00.000Z'
});
const cacheRoot = fileURLToPath(new URL('../../../.cache/', import.meta.url));

async function workspace() {
  await mkdir(cacheRoot, {recursive: true});
  const directory = await mkdtemp(join(cacheRoot, 'proactive-cognition-'));
  return {directory, runtimePath: join(directory, 'runtime.sqlite'),
    memoryPath: join(directory, 'memory.sqlite')};
}

function chooser(state) {
  return new LayaActionChoiceService({async infer(payload) {
    state.layaCalls++;
    if (state.onInfer) await state.onInfer(payload);
    const criteria = payload.questions.action.criteria;
    const keys = Object.keys(criteria);
    const selected = keys.find(key =>
      JSON.parse(criteria[key]).description.includes('minimal dependency repair')) ?? keys[0];
    const probabilities = Object.fromEntries(keys.map(key => [key,
      key === selected ? 0.9 : 0.1 / (keys.length - 1)]));
    return {answers: {action: {choice: selected, probabilities,
      answer_confidence: 0.9, confidence: 0.5}}};
  }});
}

function open(paths, state) {
  const application = createRuntimeApplication({path: paths.runtimePath,
    profile: 'huawei_ict_agentarts', coordination: {async execute(request) {
      state.agentArtsCalls++;
      state.goals.push(request.goal);
      return {kind: 'text', text: 'Synthetic AgentArts orchestration accepted', verification: 'mock'};
    }}});
  const facts = application.createCompetitionFactHost({memoryPath: paths.memoryPath,
    memoryNamespace, graphNamespace, consumerKey: 'synthetic-cognition-consumer'});
  const client = new Client(application, Date.now);
  let connected = false;
  const selectionHandoff = state.handoff === false ? undefined : {
    async prepare(review) {
      state.prepares++;
      if (state.prepareGate) {
        state.prepareGate.arrive();
        await state.prepareGate.pending;
      }
      if (state.prepareUnavailable) return undefined;
      assert.equal(review.selectedOption.id, state.selectedId ?? 'revise');
      return {exportPolicyVersion: 'synthetic-public-v1',
        goal: 'Review a synthetic public meeting correction and propose a revised plan.'};
    },
    read(commandId) {
      return application.runtime.findTaskByIdempotencyKey(commandId);
    },
    async dispatch(intent, request) {
      state.dispatchAttempts++;
      if (state.denyDispatch) throw Error('Synthetic export scope was revoked');
      if (state.failDispatchOnce) {
        state.failDispatchOnce = false;
        throw Error('Synthetic interruption before AgentArts task submission');
      }
      if (state.dispatchGate) {
        state.dispatchGate.arrive();
        await state.dispatchGate.pending;
        if (request.signal.aborted) throw Error('Synthetic dispatch cancelled before submission');
      }
      assert.equal(intent.exportPolicyVersion, 'synthetic-public-v1');
      assert.ok(Date.parse(request.deadline) <= Date.parse(intent.deadline));
      state.dispatchDeadlines.push(request.deadline);
      assert.equal(intent.goal, 'Review a synthetic public meeting correction and propose a revised plan.');
      if (!connected) { await client.connect(); connected = true; }
      const submitted = await client.call('task.submit', {
        goal: intent.goal, conversationId: 'synthetic-agentarts-handoff'
      }, {idempotencyKey: intent.commandId, signal: request.signal,
        timeoutMs: Math.max(1, Date.parse(request.deadline) - Date.now())});
      return application.runtime.getTask(submitted.taskId);
    }
  };
  const host = createProactiveCognitionHost({application, facts, graphNamespace,
    bindingVersion: 'test-binding-v1', chooser: chooser(state),
    ...(state.prepareOptions ? {prepareOptions: state.prepareOptions} : {}),
    ...(selectionHandoff ? {selectionHandoff} : {})});
  return {application, facts, host, close() { host.close(); facts.close(); application.close(); }};
}

function state(overrides = {}) {
  return {layaCalls: 0, agentArtsCalls: 0, prepares: 0,
    dispatchAttempts: 0, dispatchDeadlines: [], goals: [], ...overrides};
}

function gate() {
  let arrive, release;
  const entered = new Promise(resolve => { arrive = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  return {entered, pending, arrive, release};
}

function record(facts, revision, expectedFactRevision) {
  return facts.recordPublicSource({...source, sourceRevision: revision.repeat(64), line: 1,
    summary: revision === 'a' ? 'Meeting at 17:00' : 'Meeting at 18:00',
    observedAt: '2026-09-25T00:00:00.000Z',
    validFrom: '2026-09-25T00:00:00.000Z', validUntil: '2099-01-01T00:00:00.000Z',
    expectedFactRevision}, context());
}

async function factChain(binding, request = context()) {
  const {application, facts, host} = binding;
  record(facts, 'a', null);
  const baseline = await host.consumeAndReview({...context(), at, limit: 10, afterGraphRevision: 0});
  assert.equal(baseline.reviews[0].review.action, 'KEEP');
  assert.equal(baseline.nextGraphRevision, 1);
  const store = application.runtime.bindCoordinationStore(graphNamespace);
  const factId = store.read().history[0].id;
  store.append(1, node('goal', 'goal', [ref(factId)]));
  store.append(2, node('decision', 'decision', [ref('goal')]));
  store.append(3, node('plan', 'plan', [ref('decision')]));
  record(facts, 'b', 1);
  const reviewed = await host.consumeAndReview({...request, at, limit: 10, afterGraphRevision: 1});
  assert.equal(reviewed.reviews.length, 1);
  assert.equal(reviewed.nextGraphRevision, 5);
  return {store, baseline, reviewed, review: reviewed.reviews[0]};
}

async function waitFor(application, taskId, expected) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const task = application.runtime.getTask(taskId);
    if (task.state === expected) return task;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw Error(`Task did not reach ${expected}`);
}

test('public Fact correction selects revise and hands off once across SQLite restart', async () => {
  const paths = await workspace();
  const calls = state();
  let binding = open(paths, calls);
  try {
    const {store, baseline, review} = await factChain(binding);
    assert.equal(review.task.state, 'succeeded');
    assert.equal(review.review.action, 'REVISE');
    assert.equal(review.review.selection.selected.id, 'revise');
    assert.deepEqual(review.review.options.map(option => option.id), ['recheck', 'defer', 'revise']);
    assert.deepEqual(review.review.affected.map(item => item.node.id), ['goal', 'decision', 'plan']);
    assert.deepEqual(review.review.selectedOption.repair.changes.map(change => change.node.id),
      ['goal', 'decision', 'plan']);
    assert.equal(review.review.semanticReviewRequired, true);
    assert.equal(review.handoff.state, 'submitted');
    await waitFor(binding.application, review.handoff.task.taskId, 'succeeded');
    assert.equal(calls.layaCalls, 1);
    assert.equal(calls.agentArtsCalls, 1);
    assert.deepEqual(calls.goals,
      ['Review a synthetic public meeting correction and propose a revised plan.']);
    assert.equal(store.read().revision, 5, 'handoff does not commit local Goal/Plan versions');
    binding.close();
    binding = open(paths, calls);
    const replay = await binding.host.consumeAndReview({...context(), at, limit: 10,
      afterGraphRevision: 0});
    assert.deepEqual(replay.reviews.map(item => item.task.taskId),
      [baseline.reviews[0].task.taskId, review.task.taskId]);
    assert.equal(replay.reviews[1].handoff.task.taskId, review.handoff.task.taskId);
    assert.equal(replay.nextGraphRevision, 5);
    assert.equal(calls.layaCalls, 1);
    assert.equal(calls.agentArtsCalls, 1);
    assert.equal(binding.application.runtime.bindCoordinationStore(graphNamespace).read().revision, 5);
  } finally {
    binding.close();
    await rm(paths.directory, {recursive: true, force: true});
  }
});

test('missing handoff or declined export projection never submits an AgentArts task', async () => {
  for (const mode of ['missing', 'unavailable']) {
    const paths = await workspace();
    const calls = state({handoff: mode !== 'missing', prepareUnavailable: mode === 'unavailable'});
    const binding = open(paths, calls);
    try {
      const {store, review} = await factChain(binding);
      assert.equal(review.review.selectedOption.id, 'revise');
      assert.deepEqual(review.handoff, {state: 'unavailable'});
      assert.equal(calls.agentArtsCalls, 0);
      assert.equal(calls.dispatchAttempts, 0);
      assert.equal(store.read().revision, 5);
    } finally {
      binding.close();
      await rm(paths.directory, {recursive: true, force: true});
    }
  }
});

test('custom versioned options let Laya choose a legal approach; out-of-scope repair is rejected', async () => {
  const paths = await workspace();
  const calls = state({selectedId: 'route-b', prepareOptions: review => [
    {id: 'route-a', revision: 2, action: 'RECHECK',
      description: 'Ask AgentArts to verify this synthetic public source.'},
    {id: 'route-b', revision: 3, action: 'REVISE',
      description: 'Ask AgentArts to evaluate this minimal dependency repair.',
      repair: review.options.find(option => option.id === 'revise').repair}
  ]});
  let binding = open(paths, calls);
  try {
    const {review, store} = await factChain(binding);
    assert.deepEqual(review.review.options.map(option => [option.id, option.revision]),
      [['route-a', 2], ['route-b', 3]]);
    assert.deepEqual(review.review.selection.selected, {id: 'route-b', revision: 3});
    assert.equal(review.review.selectedOption.action, 'REVISE');
    assert.equal(review.handoff.state, 'submitted');
    await waitFor(binding.application, review.handoff.task.taskId, 'succeeded');
    assert.equal(store.read().revision, 5);
    assert.equal(calls.agentArtsCalls, 1);
  } finally {
    binding.close();
    await rm(paths.directory, {recursive: true, force: true});
  }

  const invalidPaths = await workspace();
  const invalidCalls = state({prepareOptions: review => [{
    id: 'route-a', revision: 2, action: 'RECHECK', description: 'Verify synthetic public source.'
  }, {
    id: 'route-b', revision: 3, action: 'REVISE', description: 'Evaluate a changed plan.',
    repair: {...review.options.find(option => option.id === 'revise').repair,
      changes: [{...review.options.find(option => option.id === 'revise').repair.changes[0],
        node: ref('outside-scope')}]}
  }]});
  binding = open(invalidPaths, invalidCalls);
  try {
    const {review, store} = await factChain(binding);
    assert.equal(review.task.state, 'failed');
    assert.equal(review.review, undefined);
    assert.equal(invalidCalls.layaCalls, 0);
    assert.equal(invalidCalls.agentArtsCalls, 0);
    assert.equal(store.read().revision, 5);
  } finally {
    binding.close();
    await rm(invalidPaths.directory, {recursive: true, force: true});
  }
});

test('abort or close during a pending export preparation cannot dispatch after it resolves', async () => {
  for (const interruption of ['abort', 'close']) {
    const paths = await workspace();
    const calls = state({handoff: false});
    let binding = open(paths, calls);
    try {
      const {review} = await factChain(binding);
      assert.equal(review.handoff.state, 'unavailable');
      binding.close();
      calls.handoff = true;
      calls.prepareGate = gate();
      binding = open(paths, calls);
      const controller = new AbortController();
      const pending = binding.host.handoffReview(review.task.taskId, {
        deadline: context().deadline, signal: controller.signal});
      await calls.prepareGate.entered;
      if (interruption === 'abort') controller.abort();
      else binding.host.close();
      calls.prepareGate.release();
      await assert.rejects(pending, {code: 'CANCELLED'});
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(calls.dispatchAttempts, 0);
      assert.equal(calls.agentArtsCalls, 0);
      assert.equal(binding.application.runtime.loadCheckpoint(review.task.taskId,
        'proactive-cognition-handoff-v1'), undefined);
      assert.equal(binding.application.runtime.bindCoordinationStore(graphNamespace).read().revision, 5);
    } finally {
      binding.close();
      await rm(paths.directory, {recursive: true, force: true});
    }
  }
});

test('abort or close during dispatch reports pending and retries the same command without rerunning Laya', async () => {
  for (const interruption of ['abort', 'close']) {
    const paths = await workspace();
    const calls = state({handoff: false});
    let binding = open(paths, calls);
    try {
      const {review} = await factChain(binding);
      binding.close();
      calls.handoff = true;
      calls.dispatchGate = gate();
      binding = open(paths, calls);
      const controller = new AbortController();
      const pending = binding.host.handoffReview(review.task.taskId, {
        deadline: context().deadline, signal: controller.signal});
      await calls.dispatchGate.entered;
      const intent = binding.application.runtime.loadCheckpoint(review.task.taskId,
        'proactive-cognition-handoff-v1');
      assert.ok(intent?.commandId);
      if (interruption === 'abort') controller.abort();
      else binding.host.close();
      const interrupted = await pending;
      assert.deepEqual(interrupted.handoff, {state: 'pending'});
      calls.dispatchGate.release();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(calls.agentArtsCalls, 0);
      assert.equal(binding.application.runtime.findTaskByIdempotencyKey(intent.commandId), undefined);
      binding.close();
      delete calls.dispatchGate;
      binding = open(paths, calls);
      const retried = await binding.host.handoffReview(review.task.taskId, context());
      assert.equal(retried.handoff.state, 'submitted');
      await waitFor(binding.application, retried.handoff.task.taskId, 'succeeded');
      assert.equal(binding.application.runtime.loadCheckpoint(review.task.taskId,
        'proactive-cognition-handoff-v1').commandId, intent.commandId);
      assert.equal(calls.layaCalls, 1);
      assert.equal(calls.agentArtsCalls, 1);
      assert.equal(binding.application.runtime.bindCoordinationStore(graphNamespace).read().revision, 5);
    } finally {
      binding.close();
      await rm(paths.directory, {recursive: true, force: true});
    }
  }
});

test('export scope denial before dispatch leaves a durable handoff for same-command retry', async () => {
  const paths = await workspace();
  const calls = state({denyDispatch: true});
  let binding = open(paths, calls);
  try {
    await assert.rejects(factChain(binding), /scope was revoked/);
    const review = binding.application.runtime.listTasks({conversationId:
      `proactive-cognition:${graphNamespace}`}).items.find(task =>
      binding.application.runtime.loadCheckpoint(task.taskId, 'proactive-cognition-handoff-v1'));
    assert.ok(review);
    const saved = binding.application.runtime.loadCheckpoint(review.taskId,
      'proactive-cognition-handoff-v1');
    assert.equal(calls.agentArtsCalls, 0);
    assert.equal(binding.application.runtime.bindCoordinationStore(graphNamespace).read().revision, 5);
    binding.close();
    calls.denyDispatch = false;
    binding = open(paths, calls);
    const shorter = context(5_000);
    const retry = await binding.host.handoffReview(review.taskId, shorter);
    assert.equal(retry.handoff.state, 'submitted');
    await waitFor(binding.application, retry.handoff.task.taskId, 'succeeded');
    assert.deepEqual(binding.application.runtime.loadCheckpoint(review.taskId,
      'proactive-cognition-handoff-v1'), saved);
    assert.equal(calls.dispatchDeadlines.at(-1), shorter.deadline,
      'caller deadline narrows the saved handoff deadline');
    assert.equal(calls.layaCalls, 1);
    assert.equal(calls.agentArtsCalls, 1);
    assert.equal(binding.application.runtime.bindCoordinationStore(graphNamespace).read().revision, 5);
  } finally {
    binding.close();
    await rm(paths.directory, {recursive: true, force: true});
  }
});

test('expired saved handoff is reported without blocking a review or dispatching', async () => {
  const paths = await workspace();
  const calls = state({failDispatchOnce: true});
  const binding = open(paths, calls);
  try {
    await assert.rejects(factChain(binding, context(1_000)), /interruption/);
    const review = binding.application.runtime.listTasks({conversationId:
      `proactive-cognition:${graphNamespace}`}).items.find(task =>
      binding.application.runtime.loadCheckpoint(task.taskId, 'proactive-cognition-handoff-v1'));
    assert.ok(review);
    const intent = binding.application.runtime.loadCheckpoint(review.taskId,
      'proactive-cognition-handoff-v1');
    await new Promise(resolve => setTimeout(resolve, Math.max(1, Date.parse(intent.deadline) - Date.now() + 5)));
    const replay = await binding.host.handoffReview(review.taskId, context());
    assert.equal(replay.review.selectedOption.id, 'revise');
    assert.deepEqual(replay.handoff, {state: 'expired'});
    assert.equal(calls.agentArtsCalls, 0);
    assert.equal(calls.dispatchAttempts, 1);
  } finally {
    binding.close();
    await rm(paths.directory, {recursive: true, force: true});
  }
});

test('bounded receipt cursor reports review backlog after the source feed reaches watermark', async () => {
  const paths = await workspace();
  const calls = state();
  const binding = open(paths, calls);
  try {
    const {review} = await factChain(binding);
    const first = await binding.host.consumeAndReview({...context(), at, limit: 1,
      afterGraphRevision: 0});
    assert.equal(first.atWatermark, true);
    assert.equal(first.nextGraphRevision, 1);
    assert.equal(first.hasMoreReviews, true);
    const second = await binding.host.consumeAndReview({...context(), at, limit: 1,
      afterGraphRevision: 1});
    assert.equal(second.reviews[0].task.taskId, review.task.taskId);
    assert.equal(second.nextGraphRevision, 5);
    assert.equal(second.hasMoreReviews, false);
    assert.equal(calls.layaCalls, 1);
    assert.equal(calls.agentArtsCalls, 1);
  } finally {
    binding.close();
    await rm(paths.directory, {recursive: true, force: true});
  }
});

test('cancellation during Laya choice saves no review and does not submit to AgentArts', async () => {
  const paths = await workspace();
  const calls = state();
  const binding = open(paths, calls);
  try {
    record(binding.facts, 'a', null);
    await binding.host.consumeAndReview({...context(), at, limit: 10, afterGraphRevision: 0});
    const store = binding.application.runtime.bindCoordinationStore(graphNamespace);
    const factId = store.read().history[0].id;
    store.append(1, node('goal', 'goal', [ref(factId)]));
    record(binding.facts, 'b', 1);
    const controller = new AbortController();
    calls.onInfer = async () => controller.abort();
    await assert.rejects(binding.host.consumeAndReview({deadline: context().deadline,
      signal: controller.signal, at, limit: 10, afterGraphRevision: 1}), {code: 'CANCELLED'});
    const failed = binding.application.runtime.listTasks({conversationId:
      `proactive-cognition:${graphNamespace}`}).items.find(task => task.state === 'failed');
    assert.ok(failed);
    assert.equal(binding.application.runtime.loadCheckpoint(failed.taskId,
      'proactive-cognition-review-v1'), undefined);
    assert.equal(calls.agentArtsCalls, 0);
    assert.equal(store.read().revision, 3);
  } finally {
    binding.close();
    await rm(paths.directory, {recursive: true, force: true});
  }
});

test('Goal revision also routes Laya selection to AgentArts without graph mutation', async () => {
  const paths = await workspace();
  const calls = state();
  const binding = open(paths, calls);
  try {
    record(binding.facts, 'a', null);
    await binding.host.consumeAndReview({...context(), at, limit: 10, afterGraphRevision: 0});
    const store = binding.application.runtime.bindCoordinationStore(graphNamespace);
    const factId = store.read().history[0].id;
    store.append(1, node('goal', 'goal', [ref(factId)], 'old goal'));
    store.append(2, node('decision', 'decision', [ref('goal')]));
    store.append(3, node('plan', 'plan', [ref('decision')]));
    store.append(4, node('goal', 'goal', [ref(factId)], 'revised goal'));
    const input = {expectedGraphRevision: 5, previousGoal: ref('goal'), currentGoal: ref('goal', 2)};
    const first = await binding.host.reviewGoalRevision(input, {...context(), at});
    assert.equal(first.review.selectedOption.id, 'revise');
    assert.deepEqual(first.review.affected.map(item => item.node.id), ['decision', 'plan']);
    assert.deepEqual(first.review.selectedOption.repair.changes.map(change => change.node.id),
      ['decision', 'plan']);
    assert.equal(first.handoff.state, 'submitted');
    await waitFor(binding.application, first.handoff.task.taskId, 'succeeded');
    const second = await binding.host.reviewGoalRevision(input, {...context(), at});
    assert.equal(second.task.taskId, first.task.taskId);
    assert.equal(second.handoff.task.taskId, first.handoff.task.taskId);
    assert.equal(calls.layaCalls, 1);
    assert.equal(calls.agentArtsCalls, 1);
    assert.equal(store.read().revision, 5);
  } finally {
    binding.close();
    await rm(paths.directory, {recursive: true, force: true});
  }
});

test('public Fact expiry without a new feed event creates one durable AgentArts review', async () => {
  const paths = await workspace();
  const calls = state({selectedId: 'recheck'});
  let binding = open(paths, calls);
  const expiry = '2026-09-27T04:00:00.000Z';
  try {
    binding.facts.recordPublicSource({...source, sourceRevision: 'a'.repeat(64), line: 1,
      summary: 'Public meeting schedule valid until the announced cutoff',
      observedAt: '2026-09-25T00:00:00.000Z', validFrom: '2026-09-25T00:00:00.000Z',
      validUntil: expiry, expectedFactRevision: null}, context());
    const baseline = await binding.host.consumeAndReview({...context(), at, limit: 10, afterGraphRevision: 0});
    const store = binding.application.runtime.bindCoordinationStore(graphNamespace);
    const factId = store.read().history[0].id;
    store.append(1, node('goal', 'goal', [ref(factId)]));
    store.append(2, node('decision', 'decision', [ref('goal')]));
    store.append(3, node('plan', 'plan', [ref('decision')]));
    const poll = time => binding.host.consumeAndReview({...context(), at: time, limit: 10,
      afterGraphRevision: baseline.nextGraphRevision});
    assert.deepEqual((await poll(at)).reviews, []);
    assert.equal(calls.layaCalls, 0);
    const expired = await poll(expiry);
    assert.equal(expired.atWatermark, true);
    assert.equal(expired.hasMoreReviews, false);
    assert.equal(expired.nextGraphRevision, baseline.nextGraphRevision, 'expiry does not advance the Fact receipt cursor');
    assert.equal(expired.reviews.length, 1);
    const review = expired.reviews[0];
    assert.equal(review.task.state, 'succeeded');
    assert.equal(review.review.action, 'RECHECK');
    assert.deepEqual(review.review.options.map(option => option.id), ['recheck', 'defer']);
    assert.deepEqual(review.review.affected.map(item => item.node.id), ['goal', 'decision', 'plan']);
    assert.equal(review.handoff.state, 'submitted');
    await waitFor(binding.application, review.handoff.task.taskId, 'succeeded');
    assert.equal(store.read().revision, 4, 'expired knowledge is not locally repaired or renewed');
    const later = await poll('2026-09-27T04:01:00.000Z');
    assert.equal(later.reviews[0].task.taskId, review.task.taskId);
    store.append(4, node('unrelated', 'fact', [], 'Unrelated public observation'));
    binding.close();
    binding = open(paths, calls);
    const recovered = await poll('2026-09-27T04:02:00.000Z');
    assert.equal(recovered.reviews[0].task.taskId, review.task.taskId);
    assert.equal(recovered.reviews[0].handoff.task.taskId, review.handoff.task.taskId);
    assert.equal(calls.layaCalls, 1, 'polling, restart and unrelated graph changes do not rerun Laya');
    assert.equal(calls.agentArtsCalls, 1);
    assert.equal(binding.application.runtime.bindCoordinationStore(graphNamespace).read().revision, 5);
  } finally {
    binding.close();
    await rm(paths.directory, {recursive: true, force: true});
  }
});
