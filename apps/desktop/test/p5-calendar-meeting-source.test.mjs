import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {eventToItem} from '@personal-agent/calendar';
import {FakeCoordinationStoreHost} from '@personal-agent/goals/store';
import {createCognitionP5Composition} from '../electron/cognition-p5-composition.js';
import {createCalendarMeetingSource, projectCalendarMeetingChange} from '../electron/p5-calendar-meeting-source.js';

const now = Date.parse('2026-09-30T05:00:00.000Z');
const binding = {accountRef: 'subscription-a', calendarId: 'subscription', externalId: 'uid:meeting-a',
  sourceRef: 'calendar:work', meetingFactId: 'meeting-a'};
const record = {externalId: binding.externalId, calendarId: binding.calendarId, title: '项目评审',
  startUtc: '2026-10-02T06:00:00.000Z', endUtc: '2026-10-02T07:00:00.000Z',
  timeZone: 'Asia/Shanghai', startLocal: '2026-10-02 14:00', endLocal: '2026-10-02 15:00',
  status: 'confirmed', sequence: 0, updatedUtc: '2026-09-30T04:00:00.000Z'};
const baseline = eventToItem(record, binding.accountRef, '2026-09-30T04:00:00.000Z');
const current = eventToItem({...record, sequence: 1, startUtc: '2026-10-02T07:00:00.000Z',
  endUtc: '2026-10-02T08:00:00.000Z', startLocal: '2026-10-02 15:00', endLocal: '2026-10-02 16:00'},
  binding.accountRef, '2026-09-30T04:59:00.000Z');
const context = () => ({signal: new AbortController().signal,
  deadline: new Date(Math.max(now, Date.now()) + 60_000).toISOString()});
const input = () => ({binding, baseline, current, detectedAt: new Date(now).toISOString(), ...context()});

test('public calendar projection forms a stable source-bound event before a future meeting starts', () => {
  const result = projectCalendarMeetingChange(input());
  assert.equal(result.status, 'changed');
  assert.equal(result.event.source, binding.sourceRef);
  assert.equal(result.event.expectedBaseRevision, '0');
  assert.equal(result.event.sourceRevision, '1');
  assert.equal(result.event.originalSummary, baseline.contentRef);
  assert.equal(result.event.newSummary, current.contentRef);
  assert.equal(result.calendarWriteVerified, false);
  assert.equal(projectCalendarMeetingChange({...input(), detectedAt: new Date(now + 1000).toISOString()})
    .event.eventId, result.event.eventId);
});

test('unchanged readback avoids inference; same revision changed input and regressions require review', () => {
  assert.equal(projectCalendarMeetingChange({...input(), current: baseline}).status, 'unchanged');
  assert.equal(projectCalendarMeetingChange({...input(), current: {...current,
    dedupeKey: baseline.dedupeKey}}).reason, 'source_revision_conflict');
  assert.equal(projectCalendarMeetingChange({...input(), baseline: current,
    current: {...baseline, fetchedAt: current.fetchedAt}}).reason, 'source_revision_regressed');
});

test('source identity, revision, interval and readback timestamps cannot be substituted', () => {
  for (const change of [{accountRef: 'other'}, {externalId: 'other'}, {source: 'mail'},
    {dedupeKey: 'calendar:other:uid:meeting-a:1'}, {dedupeKey: `${current.dedupeKey}x`},
    {validFor: current.validFor.split('/').reverse().join('/')}, {occurredAt: baseline.occurredAt}]) {
    assert.equal(projectCalendarMeetingChange({...input(), current: {...current, ...change}}).reason,
      'source_mismatch_or_invalid');
  }
  assert.equal(projectCalendarMeetingChange({...input(), current: {...current,
    fetchedAt: '2026-09-30T05:01:00.000Z'}}).reason, 'source_readback_stale');
});

test('cancelled, tentative, missing and metadata-only changes are reviewed without inferred deletion', () => {
  for (const status of ['cancelled', 'tentative']) {
    assert.equal(projectCalendarMeetingChange({...input(), current: {...current,
      contentRef: current.contentRef.replace('[confirmed]', `[${status}]`)}}).reason, 'status_requires_review');
  }
  assert.equal(projectCalendarMeetingChange({...input(), baseline: undefined}).reason, 'baseline_unavailable');
  assert.equal(projectCalendarMeetingChange({...input(), current: undefined}).reason, 'source_not_found');
  assert.equal(projectCalendarMeetingChange({...input(), current: {...baseline,
    dedupeKey: current.dedupeKey, contentRef: baseline.contentRef.replace('评审', '讨论')}}).reason,
    'metadata_change_requires_review');
});

test('trusted reads pass context and process one real projection without a second source database', async () => {
  const calls = [];
  const requestContext = context();
  const source = createCalendarMeetingSource({now: () => now,
    readBaseline: async (bound, ctx) => {calls.push('baseline'); assert.deepEqual(bound, binding);
      assert.equal(ctx.signal, requestContext.signal); return baseline;},
    readCurrent: async (bound, ctx) => {calls.push('current'); assert.deepEqual(bound, binding);
      assert.equal(ctx.deadline, requestContext.deadline); return current;},
    processMeetingEvent: async event => {calls.push('meeting'); assert.equal(event.newSummary, current.contentRef);
      return {status: 'proposal', eventId: event.eventId};}});
  const result = await source.refresh(binding, requestContext);
  assert.deepEqual(calls, ['baseline', 'current', 'meeting']);
  assert.equal(result.receipt.status, 'proposal');
  assert.deepEqual(source.snapshot(), {status: 'processed', calendarWriteVerified: false});
});

test('cancel or expiry after a slow provider read cannot invoke meeting inference or mutation', async () => {
  for (const stop of ['cancel', 'deadline']) {
    const controller = new AbortController();
    let clock = now, processed = 0;
    const source = createCalendarMeetingSource({now: () => clock, readBaseline: () => baseline,
      readCurrent: async () => {if (stop === 'cancel') controller.abort(); else clock += 120_000; return current;},
      processMeetingEvent: () => {processed++;}});
    const result = await source.refresh(binding, {...context(), signal: controller.signal,
      deadline: new Date(now + 60_000).toISOString()});
    assert.equal(result.reason, stop === 'cancel' ? 'cancelled' : 'deadline');
    assert.equal(processed, 0);
  }
});

test('missing baseline does not fetch a provider; NOT_FOUND/errors expose only safe feedback', async () => {
  let read = 0, processed = 0;
  const missing = createCalendarMeetingSource({now: () => now, readBaseline: () => undefined,
    readCurrent: () => {read++;}, processMeetingEvent: () => {processed++;}});
  assert.equal((await missing.refresh(binding, context())).reason, 'baseline_unavailable');
  assert.equal(read, 0);
  for (const code of ['NOT_FOUND', 'UNAVAILABLE']) {
    const source = createCalendarMeetingSource({now: () => now, readBaseline: () => baseline,
      readCurrent: () => {throw Object.assign(Error('private account token and file path'), {code});},
      processMeetingEvent: () => {processed++;}});
    assert.equal((await source.refresh(binding, context())).reason,
      code === 'NOT_FOUND' ? 'source_not_found' : 'source_or_processing_unavailable');
    assert.equal(JSON.stringify(source.snapshot()).includes('private'), false);
  }
  assert.equal(processed, 0);
});

test('composition consumes public source through multi-candidate choice, Policy CAS and durable receipt replay', async t => {
  const root = fileURLToPath(new URL('../../../.cache/p5-calendar-test/', import.meta.url));
  await mkdir(root, {recursive: true});
  const userData = await mkdtemp(path.join(root, 'case-'));
  t.after(() => rm(userData, {recursive: true, force: true}));
  const host = new FakeCoordinationStoreHost();
  const store = host.provision('calendar-test');
  const common = {sensitivity: 'private', state: 'active', validFrom: '2026-09-30T00:00:00.000Z',
    validUntil: '2026-10-03T00:00:00.000Z'};
  store.append(0, {...common, id: binding.meetingFactId, kind: 'fact', summary: baseline.contentRef,
    sourceRef: binding.sourceRef, reason: 'Calendar source [sourceRevision: 0]', dependencies: []});
  store.append(1, {...common, id: 'attendance-goal', kind: 'goal', summary: '准时参会',
    sourceRef: 'user:goal', reason: '已知会议目标', dependencies: [{id: binding.meetingFactId, revision: 1}]});
  let calls = 0, policyCalls = 0;
  const options = {application: {runtime: {bindCoordinationStore: ns => host.bind(ns)}},
    namespace: 'calendar-test', userData, now: () => now,
    calendarReadPort: {readBaseline: () => baseline, readCurrent: () => current},
    inference: {infer: async payload => {
      calls++;
      const keys = Object.keys(payload.questions.action.criteria);
      assert.equal(keys.length, 3);
      return {answers: {action: {choice: keys[0], answer_confidence: 0.9, confidence: 0.8,
        probabilities: Object.fromEntries(keys.map((key, index) => [key, index === 0 ? 0.9 : 0.05]))}}};
    }},
    policyEvaluator: {evaluateExecution: request => {policyCalls++;
      assert.equal(request.source, binding.sourceRef); return {allowed: true};}}};
  const composition = createCognitionP5Composition(options);
  const result = await composition.refreshCalendarMeeting(binding, context());
  assert.equal(result.receipt.status, 'applied', result.receipt.reason);
  assert.equal(store.read().revision, 4);
  const goal = store.read().history.findLast(node => node.id === 'attendance-goal');
  assert.deepEqual(goal.dependencies, [{id: binding.meetingFactId, revision: 2}]);
  assert.equal(calls, 1);
  assert.equal(policyCalls, 1);
  composition.dispose();
  const restarted = createCognitionP5Composition(options);
  const replay = await restarted.refreshCalendarMeeting(binding, context());
  assert.equal(replay.receipt.status, 'already_processed');
  assert.equal(store.read().revision, 4);
  assert.equal(calls, 1);
  assert.equal(policyCalls, 1);
  const projection = await restarted.dialogueProjection();
  assert.equal(projection.meetings[0].calendarWriteVerified, false);
  assert.equal(projection.calendarSource.status, 'processed');
  restarted.dispose();
});

test('composition stop cancels an in-flight source read before Laya/CAS and leaves review feedback', async t => {
  const root = fileURLToPath(new URL('../../../.cache/p5-calendar-test/', import.meta.url));
  await mkdir(root, {recursive: true});
  const userData = await mkdtemp(path.join(root, 'case-stop-'));
  t.after(() => rm(userData, {recursive: true, force: true}));
  const host = new FakeCoordinationStoreHost(); host.provision('default');
  let entered, release;
  const reading = new Promise(resolve => {entered = resolve;});
  const composition = createCognitionP5Composition({userData, now: () => now,
    application: {runtime: {bindCoordinationStore: ns => host.bind(ns)}},
    inference: {infer: () => {throw Error('must not infer after stop');}},
    calendarReadPort: {readBaseline: () => baseline, readCurrent: async () => {
      entered(); await new Promise(resolve => {release = resolve;});
      return current;
    }}});
  const operation = composition.refreshCalendarMeeting(binding, context());
  await reading;
  await composition.stop();
  assert.equal((await operation).reason, 'cancelled');
  assert.equal(composition.snapshot().calendarSource.reason, 'cancelled');
  assert.equal(host.bind('default').read().revision, 0);
  release();
  await Promise.resolve();
  assert.equal(host.bind('default').read().revision, 0);
  composition.dispose();
});
