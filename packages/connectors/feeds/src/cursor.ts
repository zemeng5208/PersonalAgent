import { ProtocolError } from '@personal-agent/contracts';

export const CURSOR_VERSION = 1;

/**
 * Bound on the delivered-identifier window. A feed that publishes more than this between two
 * polls will redeliver the overflow, and the host absorbs that by `dedupeKey`. The alternative —
 * an unbounded list — grows forever inside a string the host has to persist.
 */
export const SEEN_LIMIT = 200;

/** Upper bound on an accepted cursor string, applied before it is decoded. */
export const MAX_CURSOR_CHARS = 64_000;

/**
 * Printable ASCII only. These values are replayed as `If-None-Match` and `If-Modified-Since`, so a
 * CR or LF here would be a header injection, and the cursor is caller-supplied.
 */
const HEADER_SAFE = /^[\u0020-\u007e]*$/;

export interface CursorState {
  v: number;
  etag?: string;
  lastModified?: string;
  /** Bounded FIFO of every `dedupeKey` actually delivered, newest last. */
  seen: string[];
}

export function emptyCursor(): CursorState {
  return {v: CURSOR_VERSION, seen: []};
}

function cursorExpired(reason: string): ProtocolError {
  return new ProtocolError('CURSOR_EXPIRED', `Feed cursor is unusable: ${reason}`, false);
}

/**
 * Drops a validator that is not safe to put in a header rather than failing the whole fetch. This
 * only ever fires on a response header that already broke the ASCII assumption, and losing it costs
 * a refetch, not correctness.
 */
function safeValidator(value: string | undefined): string | undefined {
  return value !== undefined && HEADER_SAFE.test(value) && value.trim() !== '' ? value : undefined;
}

export function encodeCursor(state: CursorState): string {
  const payload: CursorState = {v: CURSOR_VERSION, seen: state.seen.slice(-SEEN_LIMIT)};
  const etag = safeValidator(state.etag);
  const lastModified = safeValidator(state.lastModified);
  if (etag !== undefined) payload.etag = etag;
  if (lastModified !== undefined) payload.lastModified = lastModified;
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** An absent or blank cursor means "first poll". A non-blank one that does not decode is tampering. */
export function decodeCursor(raw: string | undefined): CursorState {
  if (raw === undefined || raw.trim() === '') return emptyCursor();
  // Capped before decoding: 200 keys fit in roughly 27 KB of base64url, so this is generous, and
  // checking here stops a caller-supplied megabyte-scale string from being parsed into memory.
  if (raw.length > MAX_CURSOR_CHARS) throw cursorExpired(`it is longer than ${MAX_CURSOR_CHARS} characters`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw.trim(), 'base64url').toString('utf8'));
  } catch {
    throw cursorExpired('it is not base64url-encoded JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw cursorExpired('it does not describe a cursor object');
  }
  const record = parsed as Record<string, unknown>;
  if (record['v'] !== CURSOR_VERSION) {
    throw cursorExpired(`its version is not ${CURSOR_VERSION}`);
  }
  const rawSeen = record['seen'];
  if (rawSeen !== undefined && !Array.isArray(rawSeen)) throw cursorExpired('its delivered list is not an array');
  const seen = rawSeen === undefined ? [] : rawSeen.filter((key): key is string => typeof key === 'string');

  const state: CursorState = {v: CURSOR_VERSION, seen: seen.slice(-SEEN_LIMIT)};
  // Strict here, unlike in encodeCursor: these values came from the caller, not from a response,
  // so anything unexpected means the cursor was altered and the whole thing is rejected.
  const etag = decodedValidator(record['etag'], 'ETag');
  const lastModified = decodedValidator(record['lastModified'], 'Last-Modified');
  if (etag !== undefined) state.etag = etag;
  if (lastModified !== undefined) state.lastModified = lastModified;
  return state;
}

function decodedValidator(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !HEADER_SAFE.test(value) || value.trim() === '') {
    throw cursorExpired(`its ${label} cannot be replayed as a header value`);
  }
  return value;
}

/**
 * Appends the keys delivered by one poll and trims to the bound.
 *
 * There is deliberately no timestamp watermark here. A backfilled entry — published earlier than
 * the last poll but only appearing in the feed now, which is what a source does when it corrects a
 * `pubDate` — would sit below any watermark and, once evicted from a bounded list, be lost forever.
 * Filtering on delivered identifiers alone is order-independent, so a feed that reorders between
 * polls still collects correctly and duplicates are absorbed by the host on `dedupeKey`.
 */
export function appendSeen(state: CursorState, delivered: readonly string[]): CursorState {
  return {...state, seen: [...state.seen, ...delivered].slice(-SEEN_LIMIT)};
}
