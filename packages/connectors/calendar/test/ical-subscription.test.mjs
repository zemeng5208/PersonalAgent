import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ICalSubscriptionProvider, parseIcalEvents, unfoldLines, unescapeIcalText, parseIcalDate} from '../dist/index.js';
import {validateContract} from '@personal-agent/contracts';

const NOW = Date.parse('2026-09-08T00:00:00.000Z');
const ACCOUNT = 'ical-me';

const SAMPLE_ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Test//EN',
  'X-WR-CALNAME:测试日历',
  'BEGIN:VEVENT',
  'UID:evt-1@test',
  'SUMMARY:春季发布日',
  'DTSTART;VALUE=DATE:20260320',
  'DTEND;VALUE=DATE:20260321',
  'SEQUENCE:1',
  'LAST-MODIFIED:20260101T000000Z',
  'URL:https://example.test/evt-1',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:evt-2@test',
  'SUMMARY:带换行与逗号的标题\\n第二行\\, 仍然标题',
  'DTSTART:20260410T090000Z',
  'DTEND:20260410T100000Z',
  'STATUS:TENTATIVE',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:evt-3@test',
  'SUMMARY:已取消',
  'DTSTART:20260501T090000Z',
  'DTEND:20260501T100000Z',
  'STATUS:CANCELLED',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

function jsonResponse(body, status = 200) {
  return {ok: status >= 200 && status < 300, status, text: async () => body};
}

function makeProvider(body = SAMPLE_ICS) {
  const calls = [];
  const provider = new ICalSubscriptionProvider({
    url: 'https://calendar.example.test/feed.ics',
    fetchImpl: async url => {
      calls.push(url);
      return jsonResponse(body);
    },
  });
  return {provider, calls};
}

test('unfoldLines：折叠行合并、空行剔除', () => {
  const lines = unfoldLines('A:1\r\n continue\r\nB:2\r\n\ttab-continue\r\n\r\nC:3');
  assert.deepEqual(lines, ['A:1continue', 'B:2tab-continue', 'C:3']);
});

test('unescapeIcalText：换行/逗号/分号/反斜杠还原', () => {
  assert.equal(unescapeIcalText('a\\nb\\,c\\;d\\\\e'), 'a b,c;d\\e');
});

test('parseIcalDate：DATE 与 DATE-TIME 均可解析，非法返回 undefined', () => {
  assert.equal(parseIcalDate('20260320'), Date.parse('2026-03-20T00:00:00Z'));
  assert.equal(parseIcalDate('20260410T090000Z'), Date.parse('2026-04-10T09:00:00Z'));
  assert.equal(parseIcalDate('not-a-date'), undefined);
});

test('fetchWindow：折叠行/转义/全天事件/取消事件全部按规范处理', async () => {
  const {provider} = makeProvider();
  const page = await provider.fetchWindow(ACCOUNT, {fromUtc: '2026-01-01T00:00:00.000Z', toUtc: '2027-01-01T00:00:00.000Z'});
  assert.equal(page.events.length, 2, '取消事件被剔除');
  const allDay = page.events.find(event => event.externalId === 'evt-1@test');
  assert.equal(allDay.startUtc, '2026-03-20T00:00:00.000Z');
  assert.equal(allDay.endUtc, '2026-03-21T00:00:00.000Z', '全天事件 [start, end)');
  const tentative = page.events.find(event => event.externalId === 'evt-2@test');
  assert.equal(tentative.status, 'tentative');
  assert.match(tentative.title, /第二行, 仍然标题/);
});

test('connectorItem 经 CalendarService 规范化通过契约校验（用 Fake 种子对照）', async () => {
  const {CalendarService} = await import('../dist/index.js');
  const {provider} = makeProvider();
  const service = new CalendarService(provider, {now: () => NOW});
  const page = await service.listEvents(ACCOUNT, {fromUtc: '2026-01-01T00:00:00.000Z', toUtc: '2027-01-01T00:00:00.000Z', limit: 10});
  assert.ok(page.items.length >= 2);
  for (const item of page.items) validateContract('connectorItem', item);
  const allDay = page.items.find(item => item.externalId === 'evt-1@test');
  assert.equal(allDay.validFor, '2026-03-20T00:00:00.000Z/2026-03-21T00:00:00.000Z');
});

test('respond 显式 UNSUPPORTED（只读订阅无邀约语义）', async () => {
  const {provider} = makeProvider();
  assert.throws(
    () => provider.respond({accountRef: ACCOUNT, externalId: 'x', response: 'accepted', idempotencyKey: 'k'}),
    err => err.code === 'UNSUPPORTED_CAPABILITY',
  );
});

test('非 VCALENDAR 响应报 EXTERNAL_FAILURE；HTTP 429 映射 RATE_LIMITED', async () => {
  const badProvider = new ICalSubscriptionProvider({
    url: 'https://calendar.example.test/feed.ics',
    fetchImpl: async () => jsonResponse('<html>not a calendar</html>'),
  });
  await assert.rejects(
    badProvider.fetchWindow(ACCOUNT, {fromUtc: '2026-01-01T00:00:00.000Z', toUtc: '2027-01-01T00:00:00.000Z'}),
    err => err.code === 'EXTERNAL_FAILURE',
  );
  const rateProvider = new ICalSubscriptionProvider({
    url: 'https://calendar.example.test/feed.ics',
    fetchImpl: async () => ({ok: false, status: 429, text: async () => ''}),
  });
  await assert.rejects(
    rateProvider.fetchWindow(ACCOUNT, {fromUtc: '2026-01-01T00:00:00.000Z', toUtc: '2027-01-01T00:00:00.000Z'}),
    err => err.code === 'RATE_LIMITED',
  );
});

test('构造校验：非 HTTPS 订阅地址拒绝', () => {
  assert.throws(() => new ICalSubscriptionProvider({url: 'http://insecure.test/feed.ics'}), /HTTPS/);
});

const LIVE = process.env.PA_CALENDAR_LIVE === '1';
const LIVE_SKIP = LIVE ? false : 'set PA_CALENDAR_LIVE=1 to run the real iCal read-back';

test('live iCal 订阅读回（真实公开源，免 key）', {skip: LIVE_SKIP}, async () => {
  const provider = new ICalSubscriptionProvider({
    url: 'https://www.officeholidays.com/ics/china',
    calendarName: 'China Holidays',
  });
  const year = new Date().getUTCFullYear();
  const page = await provider.fetchWindow(ACCOUNT, {
    fromUtc: `${year}-01-01T00:00:00.000Z`,
    toUtc: `${year + 1}-01-01T00:00:00.000Z`,
  });
  assert.ok(page.events.length >= 5, `真实源返回 ${page.events.length} 条`);
  for (const event of page.events) {
    assert.ok(event.externalId.length > 0);
    assert.ok(event.endUtc > event.startUtc);
  }
});


test('parseIcalDate rejects calendar overflow and invalid clock values', () => {
  assert.equal(parseIcalDate('2026-99-99'), undefined);
  assert.equal(parseIcalDate('2026-02-31'), undefined);
  assert.equal(parseIcalDate('2026-04-10T24:00:00Z'), undefined);
});

test('zero-length DATE event is normalized to one all-day interval', () => {
  const events = parseIcalEvents([
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:zero-day@test',
    'DTSTART;VALUE=DATE:20260320',
    'DTEND;VALUE=DATE:20260320',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n'));
  assert.equal(events.length, 1);
  assert.equal(events[0].endMs - events[0].startMs, 86_400_000);
});

test('getEvent reads a UID from the cached subscription feed', async () => {
  const {provider, calls} = makeProvider();
  const event = await provider.getEvent(ACCOUNT, 'evt-1@test');
  assert.equal(event.externalId, 'evt-1@test');
  assert.equal(event.title, '春季发布日');
  assert.equal(await provider.getEvent(ACCOUNT, 'missing@test'), undefined);
  assert.equal(calls.length, 1);
});

test('fetch failures do not expose subscription URL details and redirects are rejected', async () => {
  const provider = new ICalSubscriptionProvider({
    url: 'https://calendar.example.test/feed.ics?token=private-token',
    fetchImpl: async (_url, init) => {
      assert.equal(init.redirect, 'error');
      throw new Error('failed to read https://calendar.example.test/feed.ics?token=private-token');
    },
  });
  await assert.rejects(
    provider.fetchFeed(),
    error => error.code === 'EXTERNAL_FAILURE' && !error.message.includes('private-token'),
  );
});
