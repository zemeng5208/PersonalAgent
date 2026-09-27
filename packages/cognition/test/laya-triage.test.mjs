import assert from 'node:assert/strict';
import {test} from 'node:test';
import {LayaTriageService, LocalLayaBatchHttpTransport} from '../dist/index.js';

const answer = (choice, probabilities) => ({choice, probabilities,
  answer_confidence: Math.max(...Object.values(probabilities)), confidence: 0.42});
const result = (label = 'work', impact = 'routine') => ({answers: {
  category_0: answer(label, {work: label === 'work' ? 0.9 : 0.1, news: label === 'news' ? 0.9 : 0.1}),
  impact_0: answer(impact, {routine: impact === 'routine' ? 0.9 : 0.1, high_impact: impact === 'high_impact' ? 0.9 : 0.1}),
}});
const messages = Array.from({length: 6}, (_, i) => ({source: 'mail', messageId: `m${i}`,
  sourceRevision: `r${i}`, text: `PRIVATE header summary ${i}`}));
const request = (selected = messages, signal = new AbortController().signal) => ({messages: selected,
  labels: {work: 'Work-related messages', news: 'Subscriptions and news'},
  deadline: new Date(Date.now() + 10_000).toISOString(), signal});

test('batch triage keeps stable revisions, partial abstention, score semantics and cancellation without fallback', async () => {
  const calls = [];
  const transport = new LocalLayaBatchHttpTransport(8123, () => 'synthetic-test-key', async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:8123/v1/systemone/batch');
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body); calls.push(body);
    if (calls.length === 2) throw Error('provider unavailable');
    assert.equal(body.items.length, 4);
    assert.equal(Object.keys(body.questions).length, 2);
    assert.deepEqual(Object.keys(body.questions.category_0.criteria), ['work', 'news']);
    assert.equal(body.items[1].state.events[0].index, 0);
    return Response.json({items: [...body.items].reverse().map(item => ({requestId: item.requestId,
      result: item.requestId === 'item_1' ? result('news', 'high_impact') : item.requestId === 'item_2' ? {answers: {}} : result()}))});
  });
  const service = new LayaTriageService(transport, {batching: 'multi_state'});
  const output = await service.classify(request());
  assert.equal(calls.length, 2);
  assert.deepEqual(output.map(item => [item.messageId, item.sourceRevision]), messages.map(item => [item.messageId, item.sourceRevision]));
  assert.equal(output[0].route, 'group'); assert.equal(output[0].label, 'work');
  assert.equal(output[0].scores.answerConfidence, 0.9);
  assert.equal(output[0].scores.entropyConcentration, 0.42);
  assert.equal(output[0].calibrated, false);
  assert.equal(output[1].route, 'main_agent'); assert.equal(output[1].label, 'news');
  assert.equal(output[2].reason, 'invalid_response');
  assert.equal(output[3].route, 'group');
  assert.deepEqual(output.slice(4).map(item => item.reason), ['unavailable', 'unavailable']);
  assert.doesNotMatch(JSON.stringify(output), /PRIVATE header/);
  assert.deepEqual(output[0].receipt.candidateLabels, ['work', 'news']);
  assert.equal(output[0].receipt.contextDigest.length, 64);
  const abort = new AbortController(); abort.abort();
  const cancelled = await service.classify(request(messages, abort.signal));
  assert.equal(calls.length, 2);
  assert.ok(cancelled.every(item => item.reason === 'cancelled' && item.abstained));
  const duplicate = new LayaTriageService({...transport,
    infer() { assert.fail('silent fallback'); },
    async inferBatch() { return {items: [{requestId: 'item_0', result: result()}, {requestId: 'item_0', result: result()}]}; },
  }, {batching: 'multi_state'});
  assert.ok((await duplicate.classify(request(messages.slice(0, 2)))).every(item => item.abstained));
  const microCalls = [];
  const micro = new LayaTriageService({async infer(payload) {
    microCalls.push(payload);
    return {answers: Object.fromEntries(payload.state.events.flatMap((_, index) => [
      [`category_${index}`, result().answers.category_0], [`impact_${index}`, result().answers.impact_0],
    ]))};
  }});
  const microOutput = await micro.classify(request(messages.slice(0, 3)));
  assert.equal(microCalls.length, 1); assert.equal(Object.keys(microCalls[0].questions).length, 6);
  assert.ok(microOutput.every(item => item.batching === 'multi_question' && item.route === 'group'));
});
