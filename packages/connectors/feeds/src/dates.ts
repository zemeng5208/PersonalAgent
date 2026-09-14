/**
 * Feed timestamps arrive as RFC 822 (RSS `pubDate`) or RFC 3339 (Atom `published`/`updated`).
 * `new Date(string)` is not usable here: ECMA-262 only specifies the ISO 8601 subset, so every
 * other spelling falls through to implementation-defined `Date.parse` behaviour, and the result
 * must still match the contract pattern `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$`.
 * Parsing is therefore explicit, and anything ambiguous yields `null` rather than a guess.
 *
 * Groups are named rather than positional: an off-by-one in the offset groups silently shifts
 * every timestamp instead of failing, which is the worst possible failure mode for a date parser.
 */

const RFC822_MONTHS: Readonly<Record<string, number>> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** Offsets in hours: the zones RFC 822 names, plus the ones real feeds actually emit. */
const RFC822_ZONES: Readonly<Record<string, number>> = {
  ut: 0, utc: 0, gmt: 0, z: 0,
  est: -5, edt: -4, cst: -6, cdt: -5, mst: -7, mdt: -6, pst: -8, pdt: -7,
};

const RFC3339 = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})[Tt ](?<hour>\d{2}):(?<minute>\d{2})(?::(?<second>\d{2})(?:\.(?<fraction>\d{1,9}))?)?(?:(?<utc>[Zz])|(?<sign>[+-])(?<offsetHour>\d{2}):?(?<offsetMinute>\d{2}))$/;

const RFC822 = /^(?:(?:mon|tue|wed|thu|fri|sat|sun)\s*,\s*)?(?<day>\d{1,2})\s+(?<month>jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+(?<year>\d{4})\s+(?<hour>\d{1,2}):(?<minute>\d{2})(?::(?<second>\d{2}))?\s*(?:(?<sign>[+-])(?<offsetHour>\d{2}):?(?<offsetMinute>\d{2})|(?<zone>[a-z]{1,5}))?$/i;

const MIN_YEAR = 1000;
const MAX_YEAR = 9999;

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function toUtcIso(
  year: number, month: number, day: number,
  hour: number, minute: number, second: number, millisecond: number,
  offsetMinutes: number,
): string | null {
  if (year < MIN_YEAR || year > MAX_YEAR) return null;
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  // A leap second (`:60`) is legal in RFC 3339 but has no representation in JS `Date`: `Date.UTC`
  // would roll it into the next minute and report a shifted instant as the real one. Rejected
  // rather than converted, because every possible conversion is a guess.
  if (hour > 23 || minute > 59 || second > 59 || millisecond > 999) return null;
  // The year/month/day ranges above are what keep `Date.UTC` from silently rolling an out-of-range
  // field into the next month, so no post-conversion comparison is needed. Comparing the rebuilt
  // fields against the input would in fact be wrong: a non-zero offset legitimately moves the UTC
  // instant into another day, month or year.
  const ms = Date.UTC(year, month - 1, day, hour, minute, second, millisecond) - offsetMinutes * 60_000;
  if (!Number.isFinite(ms)) return null;
  const built = new Date(ms);
  // A non-zero offset can push the UTC instant past year 9999, where `toISOString` switches to the
  // expanded `+010000-…` form and stops matching the contract timestamp pattern.
  if (built.getUTCFullYear() > MAX_YEAR) return null;
  return built.toISOString();
}

function num(groups: Record<string, string>, name: string, fallback: number): number {
  const raw = groups[name];
  return raw === undefined ? fallback : Number.parseInt(raw, 10);
}

function offsetMinutesOf(groups: Record<string, string>): number | null {
  // RFC 3339 spells UTC as `Z`, a designator that carries no numeric offset group of its own.
  if (groups['utc'] !== undefined) return 0;
  const sign = groups['sign'];
  if (sign !== undefined) {
    const hours = num(groups, 'offsetHour', 0);
    const minutes = num(groups, 'offsetMinute', 0);
    if (hours > 23 || minutes > 59) return null;
    return (sign === '-' ? -1 : 1) * (hours * 60 + minutes);
  }
  const zone = groups['zone'];
  if (zone !== undefined) {
    const hours = RFC822_ZONES[zone.toLowerCase()];
    // An unnamed or military zone is ambiguous, so it is not resolved by guessing.
    return hours === undefined ? null : hours * 60;
  }
  return null;
}

/** Returns a UTC timestamp matching the contract pattern, or `null` when the input is not a usable date. */
export function parseFeedDate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;

  const iso = RFC3339.exec(text);
  if (iso?.groups) {
    const groups = iso.groups;
    // A missing offset is rejected on purpose: assuming UTC or local time would present a guess as
    // the item's real publish instant, and callers can fall back to a labelled feed-level timestamp.
    const offsetMinutes = offsetMinutesOf(groups);
    if (offsetMinutes === null) return null;
    const fraction = groups['fraction'];
    const millisecond = fraction === undefined ? 0 : Number.parseInt(fraction.slice(0, 3).padEnd(3, '0'), 10);
    return toUtcIso(
      num(groups, 'year', 0), num(groups, 'month', 0), num(groups, 'day', 0),
      num(groups, 'hour', 0), num(groups, 'minute', 0), num(groups, 'second', 0),
      millisecond, offsetMinutes,
    );
  }

  const rfc822 = RFC822.exec(text);
  if (rfc822?.groups) {
    const groups = rfc822.groups;
    const monthRaw = groups['month'];
    const month = monthRaw === undefined ? 0 : RFC822_MONTHS[monthRaw.toLowerCase()] ?? 0;
    if (month === 0) return null;
    const offsetMinutes = offsetMinutesOf(groups);
    if (offsetMinutes === null) return null;
    return toUtcIso(
      num(groups, 'year', 0), month, num(groups, 'day', 0),
      num(groups, 'hour', 0), num(groups, 'minute', 0), num(groups, 'second', 0),
      0, offsetMinutes,
    );
  }

  return null;
}
