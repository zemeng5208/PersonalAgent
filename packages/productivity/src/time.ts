import { ProtocolError } from '@personal-agent/contracts';

const UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const LOCAL_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

/** 一个时刻：精确 UTC 瞬间 + 产生它时的本地表示与时区，读回时两者都返回。 */
export interface TodoWhen {
  utc: string;
  timeZone: string;
  localDateTime: string;
}

/** 时间输入：要么给 UTC 瞬间，要么给「本地墙上时间 + IANA 时区」。 */
export interface WhenInput {
  utc?: string;
  localDateTime?: string;
  timeZone?: string;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ProtocolError('INVALID_ARGUMENT', message);
}

function validTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', {timeZone});
    return true;
  } catch {
    return false;
  }
}

function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));
  const fields = new Map(parts.map(part => [part.type, part.value]));
  const asUtc = Date.UTC(
    Number(fields.get('year')),
    Number(fields.get('month')) - 1,
    Number(fields.get('day')),
    Number(fields.get('hour')) % 24,
    Number(fields.get('minute')),
    Number(fields.get('second')),
  );
  return asUtc - Math.floor(instant / 1000) * 1000;
}

function formatInZone(instant: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));
  const fields = new Map(parts.map(part => [part.type, part.value]));
  const pad = (value: string) => value.padStart(2, '0');
  return `${fields.get('year')}-${pad(String(Number(fields.get('month'))))}-${pad(String(Number(fields.get('day'))))}T${pad(String(Number(fields.get('hour')) % 24))}:${pad(String(Number(fields.get('minute'))))}:${pad(String(Number(fields.get('second'))))}`;
}

/**
 * 把「本地墙上时间 + 时区」解析为精确 UTC 瞬间。DST 边界策略（已文档化）：
 * - 秋季回拨（本地时刻出现两次）：取较早的那次（夏令时偏移）；
 * - 春季跳跃（本地时刻不存在）：向前推过跳跃（Temporal 'compatible' 语义）。
 */
export function localToUtc(localDateTime: string, timeZone: string): number {
  const asIfUtc = Date.parse(`${localDateTime}Z`);
  const offsetHere = zoneOffsetMs(asIfUtc, timeZone);
  const guess = asIfUtc - offsetHere;
  // 快路径只在附近无转变时成立：回拨夜同一墙上时刻有两次解释，转变后偏移会让快路径
  // 静默选中较晚的一次（柏林 2026-10-25 02:30 → 01:30Z 而非约定取较早的 00:30Z）。
  // 附近 ±6 小时偏移一致才短路，否则交给慢路径按「取最早」裁决。
  const nearTransition = zoneOffsetMs(guess - 6 * 3600e3, timeZone) !== offsetHere
    || zoneOffsetMs(guess + 6 * 3600e3, timeZone) !== offsetHere;
  if (!nearTransition && zoneOffsetMs(guess, timeZone) === offsetHere && formatInZone(guess, timeZone) === localDateTime) {
    return guess;
  }
  // 慢路径：采样一天内的偏移，收集能精确还原墙上时间的候选（覆盖回拨歧义，取最早）。
  const offsets = new Set<number>();
  for (let probe = asIfUtc - 24 * 3600e3; probe <= asIfUtc + 24 * 3600e3; probe += 6 * 3600e3) {
    offsets.add(zoneOffsetMs(probe, timeZone));
  }
  const [earliest] = [...offsets]
    .map(offset => asIfUtc - offset)
    .filter(instant => formatInZone(instant, timeZone) === localDateTime)
    .sort((left, right) => left - right);
  if (earliest !== undefined) return earliest;
  // 跳跃：墙上时间不存在。二分定位 48 小时窗口内的偏移转变点，把请求时间推到跳跃之后。
  const low = asIfUtc - 24 * 3600e3;
  const high = asIfUtc + 24 * 3600e3;
  if (zoneOffsetMs(low, timeZone) === zoneOffsetMs(high, timeZone)) {
    throw new ProtocolError('INVALID_ARGUMENT', `Local time ${localDateTime} is not representable in ${timeZone}`);
  }
  const boundary = findTransition(timeZone, low, high);
  const before = boundary - 1;
  const offsetBefore = zoneOffsetMs(before, timeZone);
  const offsetAfter = zoneOffsetMs(boundary, timeZone);
  const wallBefore = boundary + offsetBefore;
  const wallAfter = boundary + offsetAfter;
  if (asIfUtc >= wallBefore && asIfUtc < wallAfter) {
    return boundary + (asIfUtc - wallBefore);
  }
  throw new ProtocolError('INVALID_ARGUMENT', `Local time ${localDateTime} is not representable in ${timeZone}`);
}

function findTransition(timeZone: string, low: number, high: number): number {
  const offsetLow = zoneOffsetMs(low, timeZone);
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (zoneOffsetMs(mid, timeZone) === offsetLow) low = mid;
    else high = mid;
  }
  return high;
}

function toIsoUtc(instant: number): string {
  return `${new Date(instant).toISOString().slice(0, 19)}.000Z`;
}

/** 解析时间输入为 TodoWhen。校验失败抛 INVALID_ARGUMENT。 */
export function resolveWhen(input: WhenInput, field: string): TodoWhen {
  assert(input && typeof input === 'object', `${field} must be an object`);
  const hasUtc = typeof input.utc === 'string';
  const hasLocal = typeof input.localDateTime === 'string';
  if (hasUtc === hasLocal) {
    throw new ProtocolError('INVALID_ARGUMENT', `${field}: provide exactly one of utc or localDateTime`);
  }
  if (hasUtc) {
    assert(UTC_PATTERN.test(input.utc as string), `${field}.utc must be an ISO-8601 UTC instant`);
    assert(Number.isFinite(Date.parse(input.utc as string)), `${field}.utc is not a valid date`);
    return {utc: input.utc as string, timeZone: 'UTC', localDateTime: (input.utc as string).slice(0, 19)};
  }
  assert(LOCAL_PATTERN.test(input.localDateTime as string), `${field}.localDateTime must be YYYY-MM-DDTHH:mm:ss`);
  assert(typeof input.timeZone === 'string' && input.timeZone.length > 0, `${field}.timeZone is required with localDateTime`);
  assert(validTimeZone(input.timeZone as string), `${field}.timeZone is not a valid IANA time zone`);
  const instant = localToUtc(input.localDateTime as string, input.timeZone as string);
  return {utc: toIsoUtc(instant), timeZone: input.timeZone as string, localDateTime: input.localDateTime as string};
}

/** 校验已有的 TodoWhen（读回自存储时），失败抛 INVALID_ARGUMENT。 */
export function assertWhenValid(when: TodoWhen, field: string): void {
  assert(UTC_PATTERN.test(when.utc), `${field}.utc must be an ISO-8601 UTC instant`);
  assert(when.timeZone.length > 0, `${field}.timeZone must not be empty`);
  assert(LOCAL_PATTERN.test(when.localDateTime) || UTC_PATTERN.test(when.localDateTime), `${field}.localDateTime is malformed`);
}
