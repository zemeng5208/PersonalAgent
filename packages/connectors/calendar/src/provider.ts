/** 日历提供商端口：实现方负责真实 API 或 Fake 夹具，本包只做规范化。 */
export interface CalendarSummary {
  id: string;
  name: string;
  timeZone: string;
}

export type CalendarEventStatus = 'confirmed' | 'tentative' | 'cancelled';
export type CalendarResponse = 'accepted' | 'declined' | 'tentative';

/** 提供商侧事件：UTC 瞬间与原始时区/本地墙上时间成对出现，时区正确性在源头保证。 */
export interface CalendarEventRecord {
  externalId: string;
  calendarId: string;
  title: string;
  startUtc: string;
  endUtc: string;
  timeZone: string;
  startLocal: string;
  endLocal: string;
  status: CalendarEventStatus;
  organizer?: string;
  attendees?: string[];
  /** 提供商修订号：变更后递增，参与 dedupeKey。 */
  sequence: number;
  updatedUtc: string;
}

export interface CalendarWindow {
  fromUtc: string;
  toUtc: string;
}

/** Optional trusted-host read lifetime; deadline is an absolute ISO UTC instant. */
export interface CalendarReadContext {
  readonly signal?: AbortSignal;
  readonly deadline?: string;
}

export interface CalendarFetchPage {
  events: CalendarEventRecord[];
  nextCursor?: string;
  hasMore: boolean;
}

export interface CalendarRespondInput {
  accountRef: string;
  externalId: string;
  response: CalendarResponse;
  idempotencyKey: string;
}

export interface CalendarRespondResult {
  externalId: string;
  response: CalendarResponse;
}

export interface CalendarProvider {
  /** 账号类型（进 manifest.accountTypes），Fake 为 'fixture'。 */
  readonly providerKind: string;
  /** 提供商验证等级（透传到连接器 manifest.verification）：Fake 为 'mock'，网络型真实源为 'conditional'。 */
  readonly verification: 'mock' | 'verified' | 'conditional';
  listCalendars(accountRef: string): CalendarSummary[] | Promise<CalendarSummary[]>;
  fetchWindow(accountRef: string, window: CalendarWindow, cursor?: string, context?: CalendarReadContext): CalendarFetchPage | Promise<CalendarFetchPage>;
  getEvent(accountRef: string, externalId: string, context?: CalendarReadContext): CalendarEventRecord | undefined | Promise<CalendarEventRecord | undefined>;
  respond(input: CalendarRespondInput): CalendarRespondResult | Promise<CalendarRespondResult>;
}
