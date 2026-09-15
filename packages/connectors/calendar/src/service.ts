import { ProtocolError } from '@personal-agent/contracts';
import type { ProtocolContracts } from '@personal-agent/contracts';
import type { CalendarEventRecord, CalendarProvider, CalendarWindow } from './provider.js';
import type { CalendarRespondInput } from './provider.js';

export interface CalendarServiceOptions {
  now: () => number;
}

type ConnectorItem = ProtocolContracts['connectorItem'];
type ConnectorAction = ProtocolContracts['connectorAction'];

export interface EventPage {
  items: ConnectorItem[];
  nextCursor: string;
  hasMore: boolean;
  window: CalendarWindow;
}

const UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

/** 把提供商事件规范化为公共 ConnectorItem；validFor 承载 [start, end) UTC 区间。 */
export function eventToItem(event: CalendarEventRecord, accountRef: string, fetchedAt: string): ConnectorItem {
  const item: ConnectorItem = {
    source: 'calendar',
    accountRef,
    externalId: event.externalId,
    occurredAt: event.startUtc,
    fetchedAt,
    contentRef: contentRefOf(event),
    sensitivity: 'normal',
    dedupeKey: `calendar:${event.calendarId}:${event.externalId}:${event.sequence}`,
    validFor: `${event.startUtc}/${event.endUtc}`,
  };
  return item;
}

function contentRefOf(event: CalendarEventRecord): string {
  const when = `${event.startLocal}（${event.timeZone}）→ ${event.endLocal}`;
  const organizer = event.organizer === undefined ? '组织者未知' : `组织者 ${event.organizer}`;
  const attendees = event.attendees === undefined ? '' : `；参与 ${event.attendees.length} 人`;
  return `[${event.status}] ${event.title}｜${when}｜${organizer}${attendees}`;
}

export class CalendarService {
  readonly providerVerification: 'mock' | 'verified' | 'conditional' = 'mock';

  constructor(
    private readonly provider: CalendarProvider,
    private readonly options: CalendarServiceOptions,
  ) {
    if (provider.providerKind === 'fixture') this.providerVerification = 'mock';
  }

  listEvents(accountRef: string, window: CalendarWindow, options?: {cursor?: string; limit?: number}): EventPage {
    const limit = options?.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ProtocolError('INVALID_ARGUMENT', 'limit must be 1..100');
    // 聚合提供商分页直到满足 limit 或取尽，页大小与游标语义由提供商决定。
    let cursor: string | undefined = options?.cursor;
    const collected: CalendarEventRecord[] = [];
    let providerHasMore = true;
    while (providerHasMore && collected.length < limit) {
      const page = this.provider.fetchWindow(accountRef, window, cursor);
      collected.push(...page.events);
      providerHasMore = page.hasMore;
      cursor = page.nextCursor;
    }
    const fetchedAt = this.isoNow();
    const items = collected.slice(0, limit).map(event => eventToItem(event, accountRef, fetchedAt));
    const hasMore = providerHasMore || collected.length > limit;
    const startOffset = options?.cursor === undefined ? 0 : Number(options.cursor);
    const result: EventPage = {
      items,
      nextCursor: hasMore ? String(startOffset + items.length) : '',
      hasMore,
      window,
    };
    return structuredClone(result);
  }

  async searchEvents(accountRef: string, query: string): Promise<ConnectorItem[]> {
    if (typeof query !== 'string' || query.length === 0) throw new ProtocolError('INVALID_ARGUMENT', 'Query must be a non-empty string');
    // Fake 端点没有服务端搜索，这里拉全窗口后按标题过滤；真实提供商实现服务端搜索。
    // 提供商按页返回，必须翻完所有页——只看第一页会漏掉排在后续页的事件。
    const epoch: CalendarWindow = {fromUtc: '1970-01-01T00:00:00.000Z', toUtc: '2999-01-01T00:00:00.000Z'};
    const events: CalendarEventRecord[] = [];
    let cursor: string | undefined;
    for (let round = 0; round < 50; round += 1) {
      const page = await this.provider.fetchWindow(accountRef, epoch, cursor);
      events.push(...page.events);
      if (!page.hasMore) break;
      cursor = page.nextCursor;
    }
    const fetchedAt = this.isoNow();
    return structuredClone(events.filter(event => event.title.includes(query)).map(event => eventToItem(event, accountRef, fetchedAt)));
  }

  async getEventItem(accountRef: string, externalId: string): Promise<ConnectorItem> {
    if (typeof externalId !== 'string' || externalId.length === 0) throw new ProtocolError('INVALID_ARGUMENT', 'externalId must be a non-empty string');
    const event = this.provider.getEvent(accountRef, externalId);
    if (event === undefined) throw new ProtocolError('NOT_FOUND', `Calendar event ${externalId} not found`);
    return eventToItem(event, accountRef, this.isoNow());
  }

  /** 邀请/变更按动作授权：respond 是外部写，actionId 由幂等键决定，可安全重试。 */
  respond(input: CalendarRespondInput): ConnectorAction {
    if (!input || typeof input !== 'object') throw new ProtocolError('INVALID_ARGUMENT', 'respond input must be an object');
    if (typeof input.accountRef !== 'string' || input.accountRef.length === 0) throw new ProtocolError('INVALID_ARGUMENT', 'accountRef is required');
    if (typeof input.externalId !== 'string' || input.externalId.length === 0) throw new ProtocolError('INVALID_ARGUMENT', 'externalId is required');
    if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) throw new ProtocolError('INVALID_ARGUMENT', 'idempotencyKey is required');
    const result = this.provider.respond(input);
    return {
      actionId: `calendar-respond:${input.idempotencyKey}`,
      state: 'confirmed',
      externalId: result.externalId,
      evidenceRefs: [`calendar:${result.externalId}#${result.response}`],
    };
  }

  private isoNow(): string {
    return `${new Date(this.options.now()).toISOString().slice(0, 19)}.000Z`;
  }
}

export function assertUtcInstant(value: string, field: string): void {
  if (!UTC_PATTERN.test(value)) throw new ProtocolError('INVALID_ARGUMENT', `${field} must be an ISO-8601 UTC instant`);
}
