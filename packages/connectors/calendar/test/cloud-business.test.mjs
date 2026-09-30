import assert from 'node:assert/strict';
import {test} from 'node:test';
import {CalDavProvider, CalendarService} from '../dist/index.js';

const now = () => Date.parse('2026-09-30T11:00:00.000Z');
const window = {fromUtc: '2026-10-01T00:00:00.000Z', toUtc: '2026-11-01T00:00:00.000Z'};
const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
function ics(sequence, status = 'CONFIRMED', day = '02', modified = '20260930T100000Z') {
  return ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:single-uid', `SEQUENCE:${sequence}`,
    `SUMMARY:revision ${sequence}`, `DTSTART;TZID=Asia/Shanghai:202610${day}T100000`,
    `DTEND;TZID=Asia/Shanghai:202610${day}T110000`, `LAST-MODIFIED:${modified}`, `STATUS:${status}`,
    'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
}
function server() {
  let bodies = [ics(1), ics(2)];
  const provider = new CalDavProvider({calendarUrl: 'https://fixture.example.invalid/calendar/',
    fetchImpl: async () => ({ok: true, status: 207, text: async () => '<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">'
      + bodies.map((body, i) => `<D:response><D:href>/calendar/${i}.ics</D:href><D:propstat><D:prop><C:calendar-data>${escape(body)}</C:calendar-data></D:prop></D:propstat></D:response>`).join('')
      + '</D:multistatus>'})});
  return {provider, set: value => {bodies = value;}};
}

test('CalDAV chooses one UID revision consistently in window and single-item paths, preserves TZID', async () => {
  const {provider, set} = server();
  const first = await provider.fetchWindow('fixture', window);
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0].sequence, 2);
  assert.equal(first.events[0].timeZone, 'Asia/Shanghai');
  assert.equal(first.events[0].startUtc, '2026-10-02T02:00:00.000Z');
  assert.equal((await provider.getEvent('fixture', 'single-uid')).sequence, 2);
  set([ics(2), ics(1)]);
  assert.deepEqual((await provider.fetchWindow('fixture', window)).events, first.events, 'response order cannot select an older revision');
});

test('newer cancellation cannot resurrect the older UID; refreshKnownItems returns cancellation exactly once after baseline update', async () => {
  const {provider, set} = server();
  const service = new CalendarService(provider, {now});
  const previous = (await service.listEvents('fixture', window)).items;
  set([ics(1), ics(3, 'CANCELLED')]);
  assert.equal((await service.listEvents('fixture', window)).items.length, 0);
  const changed = await service.refreshKnownItems('fixture', previous);
  assert.equal(changed.length, 1);
  assert.match(changed[0].contentRef, /^\[cancelled\]/);
  assert.deepEqual(await service.refreshKnownItems('fixture', changed), []);
  set([]);
  await assert.rejects(service.refreshKnownItems('fixture', changed), {code: 'NOT_FOUND'});
});

test('equal-sequence LAST-MODIFIED resolves version; equal conflicting versions fail closed', async () => {
  const {provider, set} = server();
  set([ics(3, 'CONFIRMED', '02', '20260930T100000Z'), ics(3, 'CONFIRMED', '03', '20260930T110000Z')]);
  assert.equal((await provider.getEvent('fixture', 'single-uid')).startUtc, '2026-10-03T02:00:00.000Z');
  set([ics(3, 'CONFIRMED', '02'), ics(3, 'CANCELLED', '02')]);
  await assert.rejects(provider.fetchWindow('fixture', window), {code: 'EXTERNAL_FAILURE'});
});

test('baseline scope mismatch and non-progressing calendar page are rejected', async () => {
  const {provider} = server();
  const service = new CalendarService(provider, {now});
  const items = (await service.listEvents('fixture', window)).items;
  await assert.rejects(service.refreshKnownItems('other', items), {code: 'INVALID_ARGUMENT'});
  const stuck = new CalendarService({providerKind: 'fixture', verification: 'mock',
    fetchWindow: () => ({events: [], hasMore: true, nextCursor: '0'})}, {now});
  await assert.rejects(stuck.listEvents('fixture', window), {code: 'EXTERNAL_FAILURE'});
});
