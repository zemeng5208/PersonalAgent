import assert from 'node:assert/strict';
import {test} from 'node:test';
import {LayaTriageService, prepareTriageDispatch} from '../dist/index.js';

const labels = {work: 'Work', news: 'News'};
const messages = [
  {source: 'mail', messageId: 'routine', sourceRevision: '1', text: 'PRIVATE routine summary'},
  {source: 'mail', messageId: 'impact', sourceRevision: '2', text: 'PRIVATE appointment change', highImpact: true},
  {source: 'mail', messageId: 'uncertain', sourceRevision: '3', text: 'PRIVATE unclear summary'},
];
const answer = (choice, probabilities) => ({choice, probabilities,
  answer_confidence: Math.max(...Object.values(probabilities)), confidence: 0.42});
const request = (selected, signal = new AbortController().signal) => ({messages: selected, labels,
  deadline: new Date(Date.now() + 10_000).toISOString(), signal});
const validFake = {async infer(payload) {
  return {answers: Object.fromEntries(payload.state.events.flatMap((event, index) => [
    [`category_${index}`, answer('work', event.observation.includes('unclear')
      ? {work: 0.55, news: 0.45} : {work: 0.9, news: 0.1})],
    [`impact_${index}`, answer('routine', {routine: 0.9, high_impact: 0.1})],
  ]))};
}};
const input = (results, selected = messages) => ({namespace: 'host/mail/account-1', messages: selected, labels, results});

test('same-call Fake results become stable metadata-only groups and reasoning routes', async () => {
  const results = await new LayaTriageService(validFake).classify(request(messages));
  const dispatch = prepareTriageDispatch(input(results));
  assert.deepEqual(dispatch.groups.map(group => [group.label, group.refs.map(ref => ref.messageId)]),
    [['work', ['routine']]]);
  assert.deepEqual(dispatch.mainAgent.map(ref => ref.messageId), ['impact']);
  assert.deepEqual(dispatch.review.map(ref => ref.messageId), ['uncertain']);
  assert.deepEqual(dispatch.deferred, []);
  assert.doesNotMatch(JSON.stringify(dispatch), /PRIVATE|observation|scores|probabilities/);
  const reordered = prepareTriageDispatch(input([...results].reverse(), [...messages].reverse()));
  assert.deepEqual(reordered, dispatch);
  assert.notEqual(prepareTriageDispatch({...input(results), namespace: 'host/mail/account-2'})
    .groups[0].refs[0].workKey, dispatch.groups[0].refs[0].workKey);
});

test('rejects changed receipt, source version, route downgrade, label and duplicate identity', async () => {
  const results = await new LayaTriageService(validFake).classify(request(messages));
  const replace = (index, patch) => results.map((item, i) => i === index ? {...item, ...patch} : item);
  assert.throws(() => prepareTriageDispatch(input(replace(0, {receipt: {...results[0].receipt, id: '0'.repeat(64)}}))));
  assert.throws(() => prepareTriageDispatch(input(replace(0, {receipt: {...results[0].receipt, contextDigest: '0'.repeat(64)}}))));
  assert.throws(() => prepareTriageDispatch(input(replace(0, {receipt: {...results[0].receipt, criteriaDigest: '0'.repeat(64)}}))));
  assert.throws(() => prepareTriageDispatch(input(replace(0, {sourceRevision: 'stale'}))));
  assert.throws(() => prepareTriageDispatch(input(replace(1, {route: 'group', reason: 'classified'}))));
  assert.throws(() => prepareTriageDispatch(input(replace(0, {label: 'unapproved'}))));
  assert.throws(() => prepareTriageDispatch(input([results[0], results[0], results[2]])));
  assert.throws(() => prepareTriageDispatch(input(results,
    [messages[0], {...messages[0], sourceRevision: 'new', text: 'PRIVATE new'}, messages[2]])));
});

test('cancelled, deadline, unavailable and malformed response stay deferred', async () => {
  const selected = [0, 1, 2, 3].map(index => ({source: 'mail', messageId: `d${index}`,
    sourceRevision: '1', text: `PRIVATE deferred ${index}`, ...(index === 0 ? {highImpact: true} : {})}));
  const abort = new AbortController(); abort.abort();
  const cancelled = await new LayaTriageService(validFake).classify(request(selected.slice(0, 1), abort.signal));
  const expired = await new LayaTriageService(validFake).classify({...request(selected.slice(1, 2)),
    deadline: new Date(Date.now() - 1000).toISOString()});
  const unavailable = await new LayaTriageService({async infer() { throw Error('offline'); }})
    .classify(request(selected.slice(2, 3)));
  const malformed = await new LayaTriageService({async infer() { return {answers: {}}; }})
    .classify(request(selected.slice(3, 4)));
  const dispatch = prepareTriageDispatch(input([...cancelled, ...expired, ...unavailable, ...malformed], selected));
  assert.deepEqual(dispatch.deferred.map(ref => ref.reason),
    ['cancelled', 'deadline', 'unavailable', 'invalid_response']);
  assert.deepEqual(dispatch.deferred.map(ref => ref.requiredRoute),
    ['main_agent', 'review', 'review', 'review']);
  assert.deepEqual(dispatch.groups, []);
  assert.deepEqual(dispatch.mainAgent, []);
  assert.deepEqual(dispatch.review, []);
});
