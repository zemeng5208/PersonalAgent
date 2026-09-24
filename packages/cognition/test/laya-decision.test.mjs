import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ProactiveDecisionService} from '../dist/proactive-decision.js';
import {LayaDecisionModel, LocalLayaHttpTransport} from '../dist/laya-decision.js';

const event = (overrides = {}) => ({
  eventId: 'change-1', source: 'synthetic-calendar',
  observation: '比赛会议改到周五，原计划需要复查。',
  goal: {ref: {id: 'goal-1', revision: 2}, summary: '准备比赛演示'},
  facts: [{id: 'fact-1', revision: 3}], plan: {id: 'plan-1', revision: 4},
  authorization: {state: 'none', revision: 0}, ...overrides,
});
const request = events => ({events, deadline: new Date(Date.now() + 5_000).toISOString(),
  signal: new AbortController().signal});

test('same version is merged before one model call; changed authorization cannot share its decision', async () => {
  const calls = [];
  const service = new ProactiveDecisionService({async choose(events) {
    calls.push(events);
    return events.map(() => ({intervention: 'REMIND', confidence: 0.9}));
  }});
  const duplicate = event();
  const result = await service.decide(request([event(), duplicate]));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 1);
  assert.deepEqual(result.map(item => [item.intervention, item.reason]),
    [['REMIND', 'model'], ['MERGE', 'rule_duplicate']]);
  await assert.rejects(() => service.decide(request([event(), event({authorization: {state: 'revoked', revision: 1}})])),
    {code: 'INVALID_ARGUMENT'});
});

test('uncalibrated suppression and action labels never become executable results', async () => {
  for (const intervention of ['IGNORE', 'MERGE', 'DEFER', 'EXECUTE']) {
    const service = new ProactiveDecisionService({async choose() { return [{intervention, confidence: 0.99}]; }});
    const [result] = await service.decide(request([event()]));
    assert.equal(result.intervention, 'ESCALATE_AGENTARTS');
    assert.equal(result.reason, 'uncalibrated_model');
    assert.equal(result.authorizationRevision, 0);
    assert.deepEqual(result.facts, [{id: 'fact-1', revision: 3}]);
  }
});

test('low confidence and malformed model response escalate without leaking model text', async () => {
  const low = new ProactiveDecisionService({async choose() { return [{intervention: 'REMIND', confidence: 0.2}]; }});
  const [lowResult] = await low.decide(request([event()]));
  assert.deepEqual([lowResult.intervention, lowResult.reason], ['ESCALATE_AGENTARTS', 'low_confidence']);
  const malformed = new ProactiveDecisionService({async choose() { throw new Error('private provider message'); }});
  const [failed] = await malformed.decide(request([event()]));
  assert.deepEqual([failed.intervention, failed.reason, failed.confidence],
    ['ESCALATE_AGENTARTS', 'model_unavailable', null]);
  assert.doesNotMatch(JSON.stringify(failed), /private provider message/);
});

test('deadline bounds even an uncooperative model, and caller cancellation stays distinct', async () => {
  const service = new ProactiveDecisionService({async choose() { return new Promise(() => {}); }});
  const timed = {...request([event()]), deadline: new Date(Date.now() + 30).toISOString()};
  await assert.rejects(() => service.decide(timed), {code: 'TIMEOUT'});
  const controller = new AbortController();
  const cancelled = {...request([event()]), signal: controller.signal};
  const pending = service.decide(cancelled);
  controller.abort();
  await assert.rejects(pending, {code: 'CANCELLED'});
});

test('Laya adapter sends a bounded multilingual choice batch and rejects unknown labels', async () => {
  let captured;
  const model = new LayaDecisionModel({async infer(payload) {
    captured = payload;
    return {answers: {event_0: {choice: 'REMIND', confidence: 0.91}}};
  }});
  const result = await model.choose([event()], new AbortController().signal);
  assert.deepEqual(result, [{intervention: 'REMIND', confidence: 0.91}]);
  assert.equal(captured.model, 'multilingual');
  assert.deepEqual(Object.keys(captured.questions), ['event_0']);
  assert.equal(captured.questions.event_0.type, 'choice');
  assert.equal(captured.state.events[0].observation, event().observation);
  assert.deepEqual(captured.state.events[0].facts, ['fact-1@3']);
  assert.deepEqual(captured.state.events[0].goal, {ref: 'goal-1@2', summary: '准备比赛演示'});
  assert.equal('authorization' in captured.state.events[0], false);
  const bad = new LayaDecisionModel({async infer() {
    return {answers: {event_0: {choice: 'ALLOW_ALL', confidence: 1}}};
  }});
  await assert.rejects(() => bad.choose([event()], new AbortController().signal), /Invalid Laya response/);
});

test('HTTP transport stays on authenticated loopback and does not return provider errors', async () => {
  let url;
  let authorization;
  const transport = new LocalLayaHttpTransport(8765, () => 'local-test-token',
    async (target, options) => {
      url = target;
      authorization = options.headers.authorization;
      return new Response(JSON.stringify({answers: {event_0: {choice: 'REMIND', confidence: 0.9}}}),
        {status: 200, headers: {'content-type': 'application/json'}});
    });
  const model = new LayaDecisionModel(transport);
  assert.deepEqual(await model.choose([event()], new AbortController().signal),
    [{intervention: 'REMIND', confidence: 0.9}]);
  assert.equal(url, 'http://127.0.0.1:8765/v1/systemone');
  assert.equal(authorization, 'Bearer local-test-token');
  const failed = new LocalLayaHttpTransport(8765, () => 'local-test-token',
    async () => new Response('secret remote error', {status: 500}));
  await assert.rejects(() => failed.infer({model: 'multilingual', state: {events: []}, questions: {}},
    new AbortController().signal), /^Error: Local Laya unavailable$/);
});
