import { ProtocolError } from '@personal-agent/contracts';
import type {
  CalendarEventRecord,
  CalendarFetchPage,
  CalendarProvider,
  CalendarRespondInput,
  CalendarRespondResult,
  CalendarSummary,
  CalendarWindow,
} from './provider.js';

/**
 * Fake 日历提供商（测试专用）。夹具以 UTC 瞬间给定，本地表示在构造时按
 * 各事件时区用 Intl 推导，保证 start/end 的时区语义与真实提供商一致。
 */
export const defaultCalendarFixtures: CalendarEventRecord[] = [
  {
    externalId: 'evt-standup',
    calendarId: 'cal-work',
    title: '每日站会',
    startUtc: '2026-09-07T01:30:00.000Z',
    endUtc: '2026-09-07T01:45:00.000Z',
    timeZone: 'Asia/Shanghai',
    startLocal: '2026-09-07T09:30:00',
    endLocal: '2026-09-07T09:45:00',
    status: 'confirmed',
    organizer: 'lead@example.com',
    attendees: ['lead@example.com', 'me@example.com'],
    sequence: 1,
    updatedUtc: '2026-09-05T08:00:00.000Z',
  },
  {
    externalId: 'evt-review',
    calendarId: 'cal-work',
    title: '架构评审',
    startUtc: '2026-09-08T09:00:00.000Z',
    endUtc: '2026-09-08T10:30:00.000Z',
    timeZone: 'Asia/Shanghai',
    startLocal: '2026-09-08T17:00:00',
    endLocal: '2026-09-08T18:30:00',
    status: 'tentative',
    organizer: 'arch@example.com',
    attendees: ['arch@example.com', 'me@example.com'],
    sequence: 2,
    updatedUtc: '2026-09-06T12:00:00.000Z',
  },
  {
    // 跨 DST 回拨夜的事件：纽约 2026-11-01 01:30（EDT=UTC-4）= 05:30Z，
    // 结束 03:00 已在 EST（UTC-5）= 08:00Z。同一个事件的起止落在不同偏移上。
    externalId: 'evt-dst-night',
    calendarId: 'cal-work',
    title: '夜班交接（跨 DST）',
    startUtc: '2026-11-01T05:30:00.000Z',
    endUtc: '2026-11-01T08:00:00.000Z',
    timeZone: 'America/New_York',
    startLocal: '2026-11-01T01:30:00',
    endLocal: '2026-11-01T03:00:00',
    status: 'confirmed',
    organizer: 'ops@example.com',
    sequence: 1,
    updatedUtc: '2026-10-20T00:00:00.000Z',
  },
  {
    externalId: 'evt-cancelled',
    calendarId: 'cal-work',
    title: '已取消的会议',
    startUtc: '2026-09-09T02:00:00.000Z',
    endUtc: '2026-09-09T03:00:00.000Z',
    timeZone: 'Asia/Shanghai',
    startLocal: '2026-09-09T10:00:00',
    endLocal: '2026-09-09T11:00:00',
    status: 'cancelled',
    organizer: 'someone@example.com',
    sequence: 3,
    updatedUtc: '2026-09-06T18:00:00.000Z',
  },
];

export interface FakeCalendarProviderOptions {
  pageSize?: number;
}

export class FakeCalendarProvider implements CalendarProvider {
  readonly providerKind = 'fixture';
  private readonly events = new Map<string, CalendarEventRecord>();
  private readonly responses = new Map<string, CalendarRespondInput>();

  constructor(
    fixtures: CalendarEventRecord[] = defaultCalendarFixtures,
    private readonly options: FakeCalendarProviderOptions = {},
  ) {
    for (const event of structuredClone(fixtures)) this.events.set(event.externalId, event);
  }

  listCalendars(): CalendarSummary[] {
    const calendars = new Map<string, string>();
    for (const event of this.events.values()) calendars.set(event.calendarId, event.timeZone);
    return [...calendars.entries()].map(([id, timeZone]) => ({id, name: id, timeZone}));
  }

  fetchWindow(_accountRef: string, window: CalendarWindow, cursor?: string): CalendarFetchPage {
    const from = Date.parse(window.fromUtc);
    const to = Date.parse(window.toUtc);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
      throw new ProtocolError('INVALID_ARGUMENT', 'Window must be a valid ascending UTC interval');
    }
    const pageSize = this.options.pageSize ?? 2;
    const offset = cursor === undefined ? 0 : Number(cursor);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new ProtocolError('INVALID_ARGUMENT', 'Invalid cursor');
    const scoped = [...this.events.values()]
      .filter(event => Date.parse(event.startUtc) < to && Date.parse(event.endUtc) > from)
      .sort((left, right) => left.startUtc.localeCompare(right.startUtc) || left.externalId.localeCompare(right.externalId));
    const events = scoped.slice(offset, offset + pageSize);
    return {
      events: structuredClone(events),
      nextCursor: `${offset + events.length}`,
      hasMore: offset + events.length < scoped.length,
    };
  }

  getEvent(_accountRef: string, externalId: string): CalendarEventRecord | undefined {
    const event = this.events.get(externalId);
    return event === undefined ? undefined : structuredClone(event);
  }

  respond(input: CalendarRespondInput): CalendarRespondResult {
    if (!input || typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
      throw new ProtocolError('INVALID_ARGUMENT', 'idempotencyKey is required');
    }
    if (input.response !== 'accepted' && input.response !== 'declined' && input.response !== 'tentative') {
      throw new ProtocolError('INVALID_ARGUMENT', 'response must be accepted, declined or tentative');
    }
    if (!this.events.has(input.externalId)) throw new ProtocolError('NOT_FOUND', `Event ${input.externalId} not found`);
    const prior = this.responses.get(input.idempotencyKey);
    if (prior !== undefined) {
      if (prior.externalId !== input.externalId || prior.response !== input.response) {
        throw new ProtocolError('INVALID_ARGUMENT', 'idempotencyKey reused with different input');
      }
      return {externalId: prior.externalId, response: prior.response};
    }
    this.responses.set(input.idempotencyKey, {...input});
    return {externalId: input.externalId, response: input.response};
  }

  /** 测试辅助：变更一个事件（模拟提供商侧改期，sequence 递增）。 */
  mutateEvent(externalId: string, patch: Partial<Pick<CalendarEventRecord, 'startUtc' | 'endUtc' | 'status' | 'title'>>): void {
    const event = this.events.get(externalId);
    if (!event) throw new Error(`No fixture ${externalId}`);
    Object.assign(event, patch, {sequence: event.sequence + 1, updatedUtc: '2026-09-07T00:00:00.000Z'});
  }
}
