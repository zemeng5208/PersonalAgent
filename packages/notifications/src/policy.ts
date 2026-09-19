import { ProtocolError } from '@personal-agent/contracts';

const HH_MM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

/** 安静时段：本地墙上时钟窗口，支持跨午夜（22:00→07:00）。时区用 IANA 名，判定按窗口两端当时的偏移各自换算（DST 安全）。 */
export interface QuietHours {
  startLocal: string;
  endLocal: string;
  timeZone: string;
}

/** 聚合：窗口关闭或条数达到上限时产出一条摘要请求。sources 缺省＝聚合全部来源。 */
export interface DigestPolicy {
  windowMs: number;
  maxItems: number;
  sources?: string[];
}

export interface NotificationPolicy {
  quietHours?: QuietHours;
  /** 暂停到该时刻（含）；过期即自动恢复，无需显式清除。 */
  pauseUntilUtc?: string;
  digest?: DigestPolicy;
}

export function assertPolicyValid(policy: NotificationPolicy): void {
  if (!policy || typeof policy !== 'object') throw new ProtocolError('INVALID_ARGUMENT', 'Policy must be an object');
  if (policy.quietHours !== undefined) {
    const {quietHours} = policy;
    if (!quietHours || typeof quietHours !== 'object') throw new ProtocolError('INVALID_ARGUMENT', 'quietHours must be an object');
    if (!HH_MM_PATTERN.test(quietHours.startLocal) || !HH_MM_PATTERN.test(quietHours.endLocal)) {
      throw new ProtocolError('INVALID_ARGUMENT', 'quietHours times must be HH:mm');
    }
    if (quietHours.startLocal === quietHours.endLocal) {
      throw new ProtocolError('INVALID_ARGUMENT', 'quietHours window must not be empty');
    }
    assertValidTimeZone(quietHours.timeZone);
  }
  if (policy.pauseUntilUtc !== undefined) {
    if (!UTC_PATTERN.test(policy.pauseUntilUtc) || !Number.isFinite(Date.parse(policy.pauseUntilUtc))) {
      throw new ProtocolError('INVALID_ARGUMENT', 'pauseUntilUtc must be an ISO-8601 UTC instant');
    }
  }
  if (policy.digest !== undefined) {
    const {digest} = policy;
    if (!digest || typeof digest !== 'object') throw new ProtocolError('INVALID_ARGUMENT', 'digest must be an object');
    if (!Number.isSafeInteger(digest.windowMs) || digest.windowMs < 60_000) {
      throw new ProtocolError('INVALID_ARGUMENT', 'digest.windowMs must be an integer of at least 60000');
    }
    if (!Number.isSafeInteger(digest.maxItems) || digest.maxItems < 1 || digest.maxItems > 100) {
      throw new ProtocolError('INVALID_ARGUMENT', 'digest.maxItems must be 1..100');
    }
    if (digest.sources !== undefined) {
      if (!Array.isArray(digest.sources) || digest.sources.some(source => typeof source !== 'string' || source.length === 0)) {
        throw new ProtocolError('INVALID_ARGUMENT', 'digest.sources must be non-empty strings');
      }
    }
  }
}

function assertValidTimeZone(timeZone: string): void {
  if (typeof timeZone !== 'string' || timeZone.length === 0) {
    throw new ProtocolError('INVALID_ARGUMENT', 'quietHours.timeZone is required');
  }
  try {
    new Intl.DateTimeFormat('en-US', {timeZone});
  } catch {
    throw new ProtocolError('INVALID_ARGUMENT', `quietHours.timeZone is not a valid IANA time zone: ${timeZone}`);
  }
}

/** 指定时区某时刻的「当地一天内分钟数」（0..1439），经 Intl 换算因而 DST 安全。 */
export function localMinuteOfDay(instantMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(instantMs));
  const fields = new Map(parts.map(part => [part.type, part.value]));
  const hourText = fields.get('hour');
  const minuteText = fields.get('minute');
  if (hourText === undefined || minuteText === undefined) {
    throw new ProtocolError('EXTERNAL_FAILURE', `Cannot read local time in ${timeZone}`, false);
  }
  return (Number(hourText) % 24) * 60 + Number(minuteText as string);
}

function minutesOf(hhMm: string): number {
  const segments = hhMm.split(':').map(Number);
  const hour = segments[0];
  const minute = segments[1];
  if (hour === undefined || minute === undefined) {
    throw new ProtocolError('INVALID_ARGUMENT', `Malformed HH:mm value: ${hhMm}`, false);
  }
  return hour * 60 + minute;
}

/** 窗口是否覆盖该时刻。跨午夜窗口（start>end）＝「晚段或早段」。 */
export function quietHoursActive(quiet: QuietHours, instantMs: number): boolean {
  const minute = localMinuteOfDay(instantMs, quiet.timeZone);
  const start = minutesOf(quiet.startLocal);
  const end = minutesOf(quiet.endLocal);
  return start < end
    ? minute >= start && minute < end
    : minute >= start || minute < end;
}

/**
 * 下一个「安静结束」时刻＝从当前起第一个**不再处于安静期**的整分。已不在安静期则返回 null。
 *
 * 不直接找「当地分钟数等于 endLocal」的瞬间：春季跳时当天 endLocal 可能根本不存在
 * （纽约 2026-03-08 02:00→03:00，22:00–02:30 的窗口里 02:30 被跳过），按分钟数匹配会扫
 * 26 小时一无所获。扫描「首次离开安静区」对跳跃与回拨都正确：跳跃夜在时钟越过 endLocal
 * 的那一刻（03:00）释放；回拨夜在 endLocal 第一次出现（含 start 不含 end）释放。
 */
export function nextQuietEndMs(quiet: QuietHours, nowMs: number): number | null {
  if (!quietHoursActive(quiet, nowMs)) return null;
  for (let probe = nowMs + 60_000; probe <= nowMs + 26 * 3_600_000; probe += 60_000) {
    if (!quietHoursActive(quiet, probe)) {
      // 精确到分钟
      return probe - (probe % 60_000);
    }
  }
  return null;
}
