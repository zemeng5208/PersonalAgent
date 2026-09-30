import { ProtocolError } from '@personal-agent/contracts';
import { unfoldLines, unescapeIcalText, parseIcalDate } from './ical-subscription.js';
import type {
  CalendarEventRecord,
  CalendarFetchPage,
  CalendarProvider,
  CalendarRespondInput,
  CalendarRespondResult,
  CalendarSummary,
  CalendarWindow,
} from './provider.js';

/** CalDAV 传输端口：PROPFIND/REPORT 都是 XML 请求体，宿主注入 fetch 实现即可离线测试。 */
export type CalDavFetchLike = (url: string, init: {
  readonly method: 'PROPFIND' | 'REPORT';
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly signal: AbortSignal;
  readonly redirect: 'error';
}) => Promise<CalDavFetchResponseLike>;

export interface CalDavFetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

export interface CalDavReadProviderOptions {
  /** 日历集合完整 URL（RFC 4791 collection，以 / 结尾），如 https://server/calendars/user/default/。 */
  readonly calendarUrl: string;
  /** 完整 Authorization 头值（如 `Basic …`），由受信宿主按账号注入；本连接器不保存凭据本体。 */
  readonly authorization?: string;
  /** 日历展示名（缺省用 URL 尾段）。 */
  readonly calendarName?: string;
  readonly fetchImpl?: CalDavFetchLike;
  /** 单次 HTTP 请求超时；默认 30 秒。 */
  readonly requestTimeoutMs?: number;
}

/** 一次廉价轮询的快照：集合 ctag 与全部子资源 etag（href → etag）。 */
export interface CalDavChangeSnapshot {
  readonly ctag: string | undefined;
  readonly etags: Readonly<Record<string, string>>;
}

const USER_AGENT = 'personal-agent-calendar/0.1.0-alpha.1';
const CALDAV_PAGE_SIZE = 100;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** RFC 4791 要求服务器支持 Depth:1 PROPFIND；集合自身返回 ctag，子资源返回 etag。 */
const PROP_BOTH = '<?xml version="1.0" encoding="utf-8"?>'
  + '<D:propfind xmlns:D="DAV:"><D:prop><D:getctag xmlns="urn:ietf:params:xml:ns:caldav"/>'
  + '<D:getetag/></D:prop></D:propfind>';

/** XML 实体还原（calendar-data 里整段 iCal 文本被转义）。 */
function xmlText(value: string): string {
  return value.replace(/&(lt|gt|quot|apos|#x27|amp);/g, (_, entity: string) => {
    switch (entity) {
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos':
      case '#x27': return "'";
      default: return '&';
    }
  });
}

interface ResponseBlock {
  readonly href: string;
  readonly ctag: string | undefined;
  readonly etag: string | undefined;
  readonly calendarData: string | undefined;
}

/** 宽容解析 multistatus：命名空间前缀随服务器（D:/d:/cal:/c:），按本地名匹配。 */
function parseMultistatus(body: string): ResponseBlock[] {
  const responses: ResponseBlock[] = [];
  const blockPattern = /<(?:[A-Za-z][\w.-]*:)?response(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z][\w.-]*:)?response>/g;
  let match: RegExpExecArray | null;
  while ((match = blockPattern.exec(body)) !== null) {
    const block = match[1] ?? '';
    const pick = (name: string): string | undefined => {
      const found = new RegExp(`<(?:[A-Za-z][\\w.-]*:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[A-Za-z][\\w.-]*:)?${name}>`, 'i').exec(block);
      return found === null ? undefined : xmlText(found[1] ?? '').trim();
    };
    const href = pick('href');
    if (href === undefined) continue;
    responses.push({href, ctag: pick('getctag'), etag: pick('getetag'), calendarData: pick('calendar-data')});
  }
  if (responses.length === 0 && !/<(?:[A-Za-z][\w.-]*:)?multistatus[\s>]/i.test(body)) {
    throw new ProtocolError('EXTERNAL_FAILURE', 'CalDAV 响应不是合法的 multistatus', false);
  }
  return responses;
}

function basicInstant(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number | undefined {
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31
    || hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return undefined;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day
    || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) {
    return undefined;
  }
  return date.getTime();
}

function compactInstant(digits: string): number | undefined {
  return basicInstant(Number(digits.slice(0, 4)), Number(digits.slice(4, 6)), Number(digits.slice(6, 8)),
    Number(digits.slice(9, 11)), Number(digits.slice(11, 13)), Number(digits.slice(13, 15)));
}

/** 某时刻某 IANA 时区的 UTC 偏移（分钟，东为正）；非法时区名返回 undefined。 */
function zoneOffsetMinutes(ts: number, timeZone: string): number | undefined {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {timeZone, hour12: false, year: 'numeric',
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'})
      .formatToParts(new Date(ts));
  } catch {
    return undefined;
  }
  const value = new Map(parts.map(part => [part.type, part.value]));
  const hour = Number(value.get('hour')) % 24;
  return (Date.UTC(Number(value.get('year')), Number(value.get('month')) - 1, Number(value.get('day')),
    hour, Number(value.get('minute')), Number(value.get('second'))) - ts) / 60000;
}

/**
 * 带时区墙上时间 → UTC 瞬间。定点迭代收敛（DST 边界最多两次）。
 * 秋季回拨产生的歧义时刻收敛到较早的一次（RFC 5545 建议），春季空洞收敛到偏移切换后的等价瞬间。
 */
export function zonedWallToUtc(digits: string, timeZone: string): number | undefined {
  const naive = compactInstant(digits);
  if (naive === undefined) return undefined;
  let ts = naive;
  for (let round = 0; round < 3; round += 1) {
    const offset = zoneOffsetMinutes(ts, timeZone);
    if (offset === undefined || !Number.isFinite(offset)) return undefined;
    const next = naive - offset * 60_000;
    if (next === ts) return ts;
    ts = next;
  }
  const final = zoneOffsetMinutes(ts, timeZone);
  return final === undefined ? undefined : ts;
}

interface ParsedCalDavEvent {
  uid: string;
  summary: string;
  startMs: number;
  endMs: number;
  allDay: boolean;
  timeZone: string;
  sequence: number;
  lastModifiedMs: number | undefined;
  status: 'confirmed' | 'tentative' | 'cancelled';
}

/** 读取属性值与其参数串：parseIcalEvents 会同时存 `KEY` 与 `KEY;params` 两个键。 */
function propertyWithParams(props: Record<string, string>, name: string): {value: string; params: string} | undefined {
  for (const key of Object.keys(props)) {
    if (key === name || key.startsWith(`${name};`)) {
      return {value: props[key] ?? '', params: key === name ? '' : key.slice(name.length + 1)};
    }
  }
  return undefined;
}

function parseZonedValue(value: string, params: string): number | undefined {
  const input = value.trim();
  if (/^\d{8}$/u.test(input)) return basicInstant(Number(input.slice(0, 4)), Number(input.slice(4, 6)), Number(input.slice(6, 8)));
  if (/^\d{8}T\d{6}Z?$/u.test(input)) {
    const digits = input.slice(0, 15).replace(/[-:]/g, '');
    if (input.endsWith('Z')) return compactInstant(digits);
    const tzid = /TZID="?([^";]+)"?/i.exec(params);
    return tzid === null ? compactInstant(digits) : zonedWallToUtc(digits, tzid[1] ?? '');
  }
  return undefined;
}

function readEvent(props: Record<string, string>): ParsedCalDavEvent | undefined {
  const uid = props.UID ?? '';
  const summary = unescapeIcalText(props.SUMMARY ?? '(无标题)');
  const start = propertyWithParams(props, 'DTSTART');
  const end = propertyWithParams(props, 'DTEND');
  if (!uid || start === undefined || end === undefined) return undefined;
  const startMs = parseZonedValue(start.value, start.params);
  let endMs = parseZonedValue(end.value, end.params);
  if (startMs === undefined || endMs === undefined) return undefined;
  const allDay = /^\d{8}$/u.test(start.value.trim());
  const timeZone = allDay || start.value.trim().endsWith('Z')
    ? 'UTC' : /TZID="?([^";]+)"?/i.exec(start.params)?.[1] ?? 'UTC';
  if (endMs === startMs && allDay) endMs = startMs + 86_400_000;
  if (endMs <= startMs) return undefined;
  const sequence = Number(props.SEQUENCE ?? '0');
  const statusRaw = (props.STATUS ?? 'CONFIRMED').toUpperCase();
  const status: ParsedCalDavEvent['status'] = statusRaw === 'CANCELLED' ? 'cancelled'
    : statusRaw === 'TENTATIVE' ? 'tentative' : 'confirmed';
  const lastModifiedRaw = props['LAST-MODIFIED'];
  return {
    uid, summary, startMs, endMs, allDay, timeZone, sequence,
    lastModifiedMs: lastModifiedRaw === undefined ? undefined : parseIcalDate(lastModifiedRaw.split(';')[0] ?? ''),
    status,
  };
}

export function parseCalDavEvents(raw: string): ParsedCalDavEvent[] {
  const lines = unfoldLines(raw);
  const events: ParsedCalDavEvent[] = [];
  let current: Record<string, string> | undefined;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { current = {}; continue; }
    if (line === 'END:VEVENT') {
      if (current) {
        const parsed = readEvent(current);
        if (parsed) events.push(parsed);
      }
      current = undefined;
      continue;
    }
    if (current === undefined) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const left = line.slice(0, colon);
    const value = line.slice(colon + 1);
    const keyRaw = left.split(';')[0] ?? '';
    const key = keyRaw.toUpperCase();
    const params = left.slice(key.length + 1);
    current[`${key}${params ? `;${params}` : ''}`] = value;
    if (!(key in current) || params === '') current[key] = value;
  }
  return events;
}

function iso(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19)}.000Z`;
}

function localWall(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms));
  const value = new Map(parts.map(part => [part.type, part.value]));
  const hour = Number(value.get('hour')) % 24;
  return `${value.get('year')}-${value.get('month')}-${value.get('day')}T${String(hour).padStart(2, '0')}:${value.get('minute')}:${value.get('second')}`;
}

function calendarQueryXml(window: CalendarWindow | undefined): string {
  const stamp = (instant: string): string => `${instant.replaceAll(/[-:]/g, '').slice(0, 15)}Z`;
  const range = window === undefined ? '' : `<C:time-range start="${stamp(window.fromUtc)}"
      end="${stamp(window.toUtc)}"/>`;
  return '<?xml version="1.0" encoding="utf-8"?>'
    + '<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">'
    + '<D:prop><D:getetag/><C:calendar-data/></D:prop>'
    + '<C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">'
    + range
    + '</C:comp-filter></C:comp-filter></C:filter></C:calendar-query>';
}

/**
 * 只读 CalDAV 提供商：ctag/etag 廉价轮询 + calendar-query 时间窗。
 * 变更检测 = ctag 或 etag 变化；取消读回走 getEvent（fetchWindow 与订阅源一致会滤掉 cancelled）。
 */
export class CalDavProvider implements CalendarProvider {
  readonly providerKind = 'caldav';
  readonly verification = 'conditional' as const;
  private readonly calendarUrl: string;
  private readonly authorization: string | undefined;
  private readonly calendarName: string | undefined;
  private readonly fetchImpl: CalDavFetchLike;
  private readonly requestTimeoutMs: number;

  constructor(options: CalDavReadProviderOptions) {
    if (typeof options.calendarUrl !== 'string' || !/^https:\/\//u.test(options.calendarUrl)) {
      throw new ProtocolError('INVALID_ARGUMENT', 'CalDAV calendar url must be HTTPS');
    }
    this.calendarUrl = options.calendarUrl.endsWith('/') ? options.calendarUrl : `${options.calendarUrl}/`;
    this.authorization = options.authorization;
    this.calendarName = options.calendarName;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 1 || this.requestTimeoutMs > 120_000) {
      throw new ProtocolError('INVALID_ARGUMENT', 'CalDAV request timeout must be 1..120000 ms');
    }
  }

  listCalendars(): CalendarSummary[] {
    const fallback = decodeURIComponent(this.calendarUrl.split('/').filter(Boolean).pop() ?? 'caldav');
    return [{id: 'caldav', name: this.calendarName ?? fallback, timeZone: 'UTC'}];
  }

  private async request(method: 'PROPFIND' | 'REPORT', body: string, depth: '0' | '1'): Promise<string> {
    const headers: Record<string, string> = {
      'user-agent': USER_AGENT,
      'content-type': 'application/xml; charset=utf-8',
      accept: 'application/xml, text/xml',
      depth,
    };
    if (this.authorization !== undefined) headers.authorization = this.authorization;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      let response: CalDavFetchResponseLike;
      try {
        response = await this.fetchImpl(this.calendarUrl, {method, headers, body,
          signal: controller.signal, redirect: 'error'});
      } catch {
        throw new ProtocolError('EXTERNAL_FAILURE', controller.signal.aborted ? 'CalDAV 请求超时' : 'CalDAV 请求失败', true);
      }
      if (response.status === 429) throw new ProtocolError('RATE_LIMITED', 'CalDAV 服务器限流', true, 60_000);
      if (response.status === 401 || response.status === 403) {
        throw new ProtocolError('UNAUTHORIZED', `CalDAV 认证被拒绝（HTTP ${response.status}）`);
      }
      // PROPFIND/REPORT 的成功状态是 207 Multi-Status（fetch 的 ok 不含 207）。
      if (response.status !== 207 && !(response.status >= 200 && response.status < 300)) {
        throw new ProtocolError('EXTERNAL_FAILURE', `CalDAV 服务器返回异常（HTTP ${response.status}）`, response.status >= 500);
      }
      let text: string;
      try { text = await response.text(); }
      catch {
        throw new ProtocolError('EXTERNAL_FAILURE', controller.signal.aborted ? 'CalDAV 响应读取超时' : 'CalDAV 响应读取失败', true);
      }
      if (text.trim().length === 0) throw new ProtocolError('EXTERNAL_FAILURE', 'CalDAV 响应为空', false);
      return text;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** 廉价变更轮询：一次 Depth:1 PROPFIND 同时取 ctag 与全部子资源 etag。 */
  async pollChanges(): Promise<CalDavChangeSnapshot> {
    const body = await this.request('PROPFIND', PROP_BOTH, '1');
    const responses = parseMultistatus(body);
    const collection = this.calendarUrl.endsWith('/') ? this.calendarUrl : `${this.calendarUrl}/`;
    const etags: Record<string, string> = {};
    let ctag: string | undefined;
    for (const item of responses) {
      if (item.ctag !== undefined || item.href.replace(/\/$/, '') === collection.replace(/\/$/, '')) {
        if (item.ctag !== undefined) ctag = item.ctag;
        continue;
      }
      if (item.etag !== undefined) etags[item.href] = item.etag;
    }
    return {ctag, etags};
  }

  private async queryEvents(window: CalendarWindow | undefined): Promise<ParsedCalDavEvent[]> {
    const body = await this.request('REPORT', calendarQueryXml(window), '1');
    const events: ParsedCalDavEvent[] = [];
    for (const item of parseMultistatus(body)) {
      if (item.calendarData === undefined) continue;
      for (const event of parseCalDavEvents(item.calendarData)) {
        // 时间窗在客户端再过滤一次：服务器 time-range 实现质量参差（RFC 4791 §9.7 允许近似）。
        if (window !== undefined && !(event.startMs < Date.parse(window.toUtc) && event.endMs > Date.parse(window.fromUtc))) continue;
        events.push(event);
      }
    }
    return events;
  }

  async fetchWindow(_accountRef: string, window: CalendarWindow, cursor?: string): Promise<CalendarFetchPage> {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/u.test(window?.fromUtc ?? '')
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/u.test(window?.toUtc ?? '')) {
      throw new ProtocolError('INVALID_ARGUMENT', 'Calendar window must be ISO-8601 UTC instants');
    }
    const offset = cursor === undefined ? 0 : Number(cursor);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new ProtocolError('INVALID_ARGUMENT', 'Invalid cursor');
    const matching = (await this.queryEvents(window))
      .filter(event => event.status !== 'cancelled')
      .sort((left, right) => left.startMs - right.startMs || left.uid.localeCompare(right.uid));
    const events = matching.slice(offset, offset + CALDAV_PAGE_SIZE).map(event => this.toRecord(event));
    const nextOffset = offset + events.length;
    const hasMore = nextOffset < matching.length;
    return {events, hasMore, ...(hasMore ? {nextCursor: String(nextOffset)} : {})};
  }

  async getEvent(_accountRef: string, externalId: string): Promise<CalendarEventRecord | undefined> {
    if (typeof externalId !== 'string' || externalId.length === 0) {
      throw new ProtocolError('INVALID_ARGUMENT', 'externalId must be a non-empty string');
    }
    const event = (await this.queryEvents(undefined)).find(item => item.uid === externalId);
    return event === undefined ? undefined : this.toRecord(event);
  }

  /** 只读首片：CalDAV 写侧（/respond、ETag If-Match 更新）留待独立工作包。 */
  respond(_input: CalendarRespondInput): CalendarRespondResult {
    throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'CalDAV read provider has no write path yet');
  }

  private toRecord(event: ParsedCalDavEvent): CalendarEventRecord {
    return {
      externalId: event.uid,
      calendarId: 'caldav',
      title: event.summary,
      startUtc: iso(event.startMs),
      endUtc: iso(event.endMs),
      timeZone: event.timeZone,
      startLocal: localWall(event.startMs, event.timeZone),
      endLocal: localWall(event.endMs, event.timeZone),
      status: event.status,
      sequence: event.sequence,
      updatedUtc: event.lastModifiedMs === undefined ? iso(event.startMs) : iso(event.lastModifiedMs),
    };
  }
}
