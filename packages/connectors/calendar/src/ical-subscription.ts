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

export interface ICalSubscriptionOptions {
  /** 订阅 iCal 2.0 只读源地址（如 https://www.officeholidays.com/ics/china）。 */
  url: string;
  /** 日历展示名（从 X-WR-CALNAME 读回，亦可显式指定）。 */
  calendarName?: string;
  fetchImpl?: FetchLike;
}

export type FetchLike = (url: string, init: {signal: AbortSignal; headers: Record<string, string>}) => Promise<FetchResponseLike>;

export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

const USER_AGENT = 'personal-agent-calendar/0.1.0-alpha.1';
/** 一个只读订阅日历没有邀约可回应；respond 在端口层语义明确拒绝。 */
const READ_ONLY_REASON = 'Subscribed iCal feed is read-only; no invitation to respond to';

/** 折叠行展开：iCal 规定续行以空格/制表符开头。 */
export function unfoldLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .filter(line => line.length > 0)
    .reduce<string[]>((lines, line) => {
      if ((line.startsWith(' ') || line.startsWith('\t')) && lines.length > 0) {
        lines[lines.length - 1] += line.slice(1);
      } else {
        lines.push(line);
      }
      return lines;
    }, []);
}

/** iCal 文本转义还原（\\n \\, \\; \\\\）。 */
export function unescapeIcalText(value: string): string {
  return value
    .replace(/\\n/gi, ' ')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim();
}

/** DATE 或 DATE-TIME（UTC Z）→ 毫秒；非法返回 undefined。 */
export function parseIcalDate(value: string): number | undefined {
  const compact = value.replace(/[-:]/g, '').trim();
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(compact);
  if (dateOnly) {
    const ms = Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
    return Number.isFinite(ms) ? ms : undefined;
  }
  const dateTime = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(compact);
  if (dateTime) {
    const ms = Date.UTC(Number(dateTime[1]), Number(dateTime[2]) - 1, Number(dateTime[3]),
      Number(dateTime[4]), Number(dateTime[5]), Number(dateTime[6]));
    return Number.isFinite(ms) ? ms : undefined;
  }
  return undefined;
}

function iso(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19)}.000Z`;
}

function localWall(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms));
  const f = new Map(parts.map(part => [part.type, part.value]));
  const hour = Number(f.get('hour') ?? 0) % 24;
  return `${f.get('year')}-${f.get('month')}-${f.get('day')}T${String(hour).padStart(2, '0')}:${f.get('minute')}:${f.get('second')}`;
}

export interface ParsedIcalEvent {
  uid: string;
  summary: string;
  startMs: number;
  endMs: number;
  allDay: boolean;
  sequence: number;
  lastModifiedMs: number | undefined;
  url?: string;
  status: 'confirmed' | 'tentative' | 'cancelled';
}

/** 解析 VEVENT 块集合；CANCELLED/无 UID/无起止的条目按规范剔除或标注。 */
export function parseIcalEvents(raw: string): ParsedIcalEvent[] {
  const lines = unfoldLines(raw);
  const events: ParsedIcalEvent[] = [];
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
    current[key] = value;
  }
  return events;
}

function readEvent(props: Record<string, string>): ParsedIcalEvent | undefined {
  const uid = props.UID ?? '';
  const summary = unescapeIcalText(props.SUMMARY ?? '(无标题)');
  const startRaw = props.DTSTART ?? '';
  const endRaw = props.DTEND ?? '';
  if (!uid || !startRaw || !endRaw) return undefined;
  const startMs = parseIcalDate(startRaw.split(';')[0] ?? '');
  let endMs = parseIcalDate(endRaw.split(';')[0] ?? '');
  if (startMs === undefined || endMs === undefined) return undefined;
  // 全天事件 DTEND 为排他日界：零长度时后移一天保住 [start, end) 语义。
  const allDay = /VALUE=DATE/.test(startRaw) && !startRaw.includes('T');
  if (endMs === startMs && allDay) endMs = startMs + 86_400_000;
  if (endMs <= startMs) return undefined;
  const sequence = Number(props.SEQUENCE ?? '0');
  const statusRaw = (props.STATUS ?? 'CONFIRMED').toUpperCase();
  const status: 'confirmed' | 'tentative' | 'cancelled' = statusRaw === 'CANCELLED' ? 'cancelled'
    : statusRaw === 'TENTATIVE' ? 'tentative' : 'confirmed';
  const lastModifiedRaw = props['LAST-MODIFIED'];
  const lastModifiedMs = lastModifiedRaw === undefined ? undefined : parseIcalDate(lastModifiedRaw);
  const event: ParsedIcalEvent = {
    uid, summary, startMs, endMs, allDay, sequence,
    lastModifiedMs, status,
  };
  if (props.URL !== undefined) event.url = props.URL;
  return event;
}

/** 只读订阅日历：manifest 标记 read-only，respond 明确拒绝。 */
export class ICalSubscriptionProvider implements CalendarProvider {
  readonly providerKind = 'ical-subscription';
  readonly verification = 'conditional' as const;
  private readonly url: string;
  private readonly calendarName: string | undefined;
  private readonly fetchImpl: FetchLike;
  private cache: {body: string; fetchedAtMs: number} | undefined;

  constructor(options: ICalSubscriptionOptions) {
    if (typeof options.url !== 'string' || !/^https:\/\//.test(options.url)) {
      throw new ProtocolError('INVALID_ARGUMENT', 'iCal subscription url must be HTTPS');
    }
    this.url = options.url;
    this.calendarName = options.calendarName;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  }

  listCalendars(): CalendarSummary[] {
    return [{id: 'subscription', name: this.calendarName ?? '订阅日历', timeZone: 'UTC'}];
  }

  /** 每次调用都重新拉取订阅源（缓存 5 分钟由调用方窗口决定）；成功后缓存原文。 */
  async fetchWindow(_accountRef: string, window: CalendarWindow): Promise<CalendarFetchPage> {
    const body = await this.fetchFeed();
    const events = parseIcalEvents(body)
      .filter(event => event.status !== 'cancelled' && event.startMs < Date.parse(window.toUtc) && event.endMs > Date.parse(window.fromUtc))
      .sort((left, right) => left.startMs - right.startMs || left.uid.localeCompare(right.uid))
      .map(event => this.toRecord(event));
    return {events, hasMore: false};
  }

  getEvent(_accountRef: string, externalId: string): CalendarEventRecord | undefined {
    return undefined;
  }

  /** 只读源无邀约语义：显式 UNSUPPORTED 而非假成功。 */
  respond(_input: CalendarRespondInput): CalendarRespondResult {
    throw new ProtocolError('UNSUPPORTED_CAPABILITY', READ_ONLY_REASON);
  }

  async fetchFeed(signal?: AbortSignal): Promise<string> {
    if (this.cache && Date.now() - this.cache.fetchedAtMs < 300_000) return this.cache.body;
    let response: FetchResponseLike;
    try {
      response = await this.fetchImpl(this.url, {signal: signal ?? new AbortController().signal,
        headers: {'user-agent': USER_AGENT, accept: 'text/calendar, text/plain'}});
    } catch (error) {
      if (signalAborted(signal)) throw new ProtocolError('CANCELLED', 'Calendar fetch cancelled', false);
      throw new ProtocolError('EXTERNAL_FAILURE', `iCal 订阅抓取失败: ${describe(error)}`, true);
    }
    if (response.status === 429) throw new ProtocolError('RATE_LIMITED', 'iCal 订阅源限流', true, 60_000);
    const body = await response.text();
    if (!response.ok || !body.startsWith('BEGIN:VCALENDAR')) {
      throw new ProtocolError('EXTERNAL_FAILURE', `iCal 订阅源返回异常（HTTP ${response.status}）`, response.status >= 500);
    }
    this.cache = {body, fetchedAtMs: Date.now()};
    return body;
  }

  private toRecord(event: ParsedIcalEvent): CalendarEventRecord {
    const timeZone = 'UTC';
    return {
      externalId: event.uid,
      calendarId: 'subscription',
      title: event.summary,
      startUtc: iso(event.startMs),
      endUtc: iso(event.endMs),
      timeZone,
      startLocal: localWall(event.startMs, timeZone),
      endLocal: localWall(event.endMs, timeZone),
      status: event.status,
      sequence: event.sequence,
      updatedUtc: event.lastModifiedMs === undefined ? iso(event.startMs) : iso(event.lastModifiedMs),
    };
  }
}

function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
