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
  listCalendars(accountRef: string): CalendarSummary[];
  fetchWindow(accountRef: string, window: CalendarWindow, cursor?: string): CalendarFetchPage;
  getEvent(accountRef: string, externalId: string): CalendarEventRecord | undefined;
  respond(input: CalendarRespondInput): CalendarRespondResult;
}
