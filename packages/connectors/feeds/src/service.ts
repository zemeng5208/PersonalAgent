import { createHash } from 'node:crypto';
import { ProtocolError, validateContract } from '@personal-agent/contracts';
import type { ProtocolContracts } from '@personal-agent/contracts';
import { parseFeedDate } from './dates.js';
import { parseFeedDocument, toPlainText } from './parser.js';
import { appendSeen, CURSOR_VERSION, decodeCursor, encodeCursor } from './cursor.js';
import type { CursorState, PassState } from './cursor.js';
import type { FeedFetch, FeedFetchRequest, FeedProvider } from './provider.js';
import { makeContentRedactor } from './redact.js';

export type FeedRecord = ProtocolContracts['connectorItem'];

/** Where a `dedupeKey` came from, so a consumer can tell a stable identifier from a derived one. */
export type DedupeKeyKind = 'item_guid' | 'item_link' | 'content_hash';

/** Where an `occurredAt` came from. `feed_build` is a feed-level timestamp, not the item's own. */
export type OccurredAtKind = 'item_published' | 'item_updated' | 'feed_build';

/** Content-free by design: these reach logs and tool output, so they never quote the source. */
export type SkipReason = 'no_identifier' | 'no_occurred_at' | 'no_identifier_and_no_occurred_at';

export interface FeedSubscription {
  id: string;
  url: string;
  title?: string;
  sensitivity?: string;
}

export interface CollectedItem {
  record: FeedRecord;
  /**
   * The entry's own headline, plain-text normalized. `ConnectorItem` has no title field and is
   * `additionalProperties: false`, so a digest built from the port alone has to follow `contentRef`
   * to get one; the tool channel can carry it directly.
   */
  title: string;
  dedupeKeyKind: DedupeKeyKind;
  occurredAtKind: OccurredAtKind;
  summary: string;
}

export interface CollectionState {
  state: 'fetched' | 'unchanged';
  subscriptionId: string;
  fetchedAt: string;
  /** `null` on a 304: no document was read, so nothing about it can honestly be reported. */
  feedTitle: string | null;
  feedKind: 'rss' | 'atom' | null;
  parsedItemCount: number;
  deliveredCount: number;
  alreadySeenCount: number;
  /** Whether conditional headers were actually sent on this poll. */
  conditional: boolean;
  validators: {etag: string | null; lastModified: string | null};
  skipped: {index: number; reason: SkipReason}[];
}

export interface CollectResult {
  items: CollectedItem[];
  collection: CollectionState;
  nextCursor: string;
  hasMore: boolean;
}

export interface CollectQuery {
  subscriptionId: string;
  cursor?: string;
  limit?: number;
}

export interface FeedServiceOptions {
  provider: FeedProvider;
  subscriptions: FeedSubscription[];
  now: () => number;
  defaultLimit?: number;
}

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

const HASH_BODY_LIMIT = 4096;
const TITLE_LIMIT = 200;

interface ResolvedEntry {
  index: number;
  externalId: string;
  dedupeKey: string;
  dedupeKeyKind: DedupeKeyKind;
  occurredAt: string;
  occurredAtKind: OccurredAtKind;
  link: string;
  title: string;
  summary: string;
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** The public `FeedSubscription` with `id` trimmed and `sensitivity` resolved once, at construction. */
interface ConfiguredSubscription {
  id: string;
  url: string;
  title?: string;
  sensitivity: string;
}

/**
 * Collects feeds incrementally.
 *
 * The service is strictly stateless with respect to cursors: one comes in, one goes out, and
 * nothing is stored between calls. The host is the only party that persists a cursor, so a
 * tool call that advanced subscription state internally would race the host's poller and cause
 * missed or duplicated delivery at the seam.
 */
export class FeedService {
  private readonly subscriptions: Map<string, {subscription: ConfiguredSubscription; url: URL}>;
  private readonly defaultLimit: number;

  constructor(private readonly options: FeedServiceOptions) {
    this.subscriptions = new Map();
    for (const entry of options.subscriptions) {
      const id = entry.id.trim();
      if (!id) throw new ProtocolError('INVALID_ARGUMENT', 'Every feed subscription needs a non-empty id', false);
      if (this.subscriptions.has(id)) throw new ProtocolError('INVALID_ARGUMENT', `Feed subscription id is configured twice: ${id}`, false);
      let url: URL;
      try {
        url = new URL(entry.url);
      } catch {
        throw new ProtocolError('INVALID_ARGUMENT', `Feed subscription ${id} does not have a parseable absolute URL`, false);
      }
      if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
        throw new ProtocolError('INVALID_ARGUMENT', `Feed subscription ${id} must use http or https, not ${url.protocol.replace(':', '')}`, false);
      }
      const sensitivity = entry.sensitivity?.trim() || 'public';
      const subscription: ConfiguredSubscription = {id, url: entry.url, sensitivity};
      const title = entry.title?.trim();
      if (title) subscription.title = title;
      this.subscriptions.set(id, {subscription, url});
    }
    if (this.subscriptions.size === 0) {
      throw new ProtocolError('INVALID_ARGUMENT', 'Feed collection needs at least one configured subscription', false);
    }
    this.defaultLimit = options.defaultLimit ?? DEFAULT_LIMIT;
    if (!Number.isInteger(this.defaultLimit) || this.defaultLimit < 1 || this.defaultLimit > MAX_LIMIT) {
      throw new ProtocolError('INVALID_ARGUMENT', `defaultLimit must be an integer between 1 and ${MAX_LIMIT}`, false);
    }
  }

  get providerVerification(): FeedProvider['verification'] { return this.options.provider.verification; }

  /** Id, configured title and sensitivity only. The URL is never returned: it may carry a token. */
  listSubscriptions(): {id: string; title: string; sensitivity: string}[] {
    return [...this.subscriptions.values()].map(({subscription}) => ({
      id: subscription.id,
      title: subscription.title ?? subscription.id,
      sensitivity: subscription.sensitivity,
    }));
  }

  async collect(query: CollectQuery, signal?: AbortSignal): Promise<CollectResult> {
    const configured = this.subscriptions.get(query.subscriptionId);
    if (!configured) {
      throw new ProtocolError('NOT_FOUND', `No feed subscription is configured with id ${query.subscriptionId}`, false);
    }
    const limit = query.limit ?? this.defaultLimit;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new ProtocolError('INVALID_ARGUMENT', `limit must be an integer between 1 and ${MAX_LIMIT}`, false);
    }
    const cursor = decodeCursor(query.cursor);
    if (signal?.aborted) throw new ProtocolError('CANCELLED', 'Feed collection cancelled', false);

    const {subscription, url} = configured;
    const redact = makeContentRedactor(url);
    const request: FeedFetchRequest = {url: subscription.url};
    if (cursor.etag !== undefined) request.etag = cursor.etag;
    if (cursor.lastModified !== undefined) request.lastModified = cursor.lastModified;

    const fetched = await this.options.provider.fetchFeed(request, signal ?? new AbortController().signal);
    if (signal?.aborted) throw new ProtocolError('CANCELLED', 'Feed collection cancelled', false);
    const fetchedAt = new Date(this.options.now()).toISOString();
    const conditional = cursor.etag !== undefined || cursor.lastModified !== undefined;

    if (fetched.state === 'unchanged') {
      return {
        items: [],
        hasMore: false,
        nextCursor: encodeCursor(carryValidators(cursor, fetched)),
        collection: {
          state: 'unchanged',
          subscriptionId: subscription.id,
          fetchedAt,
          feedTitle: null,
          feedKind: null,
          parsedItemCount: 0,
          deliveredCount: 0,
          alreadySeenCount: 0,
          conditional,
          validators: validatorsOf(fetched, cursor),
          skipped: [],
        },
      };
    }
    if (fetched.body === undefined) {
      throw new ProtocolError('EXTERNAL_FAILURE', 'The feed provider reported a fetch but returned no body', false);
    }

    const document = parseFeedDocument(fetched.body);
    const buildDate = parseFeedDate(document.buildText);
    const resolved: ResolvedEntry[] = [];
    const skipped: CollectionState['skipped'] = [];

    for (const entry of document.entries) {
      const occurred = resolveOccurredAt(entry.publishedText, entry.updatedText, buildDate);
      const identified = resolveIdentifier(entry, occurred, redact);
      if (occurred === null || identified === null) {
        skipped.push({index: entry.index, reason: skipReason(occurred === null, identified === null)});
        continue;
      }
      const dedupeKey = `${this.options.provider.source}:${subscription.id}:${identified.kind}:${identified.externalId}`;
      resolved.push({
        index: entry.index,
        externalId: identified.externalId,
        dedupeKey,
        dedupeKeyKind: identified.kind,
        occurredAt: occurred.at,
        occurredAtKind: occurred.kind,
        link: redact(entry.link),
        title: redact(toPlainText(entry.title, TITLE_LIMIT)),
        summary: redact(toPlainText(entry.bodyText)),
      });
    }

    // Newest first, ties broken by `externalId` so the sequence is a stable function of the entry
    // set — document position shifts when a feed inserts or reorders, which would move a
    // pagination watermark mid-pass.
    resolved.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.externalId.localeCompare(b.externalId));

    const seen = new Set(cursor.seen);
    // During an open pass everything sorting at or above the watermark was already delivered in
    // this pass; `seen` cannot be relied on there because its 200-key bound evicts the head of a
    // long pass, which used to re-enter pagination and loop forever.
    const pass = cursor.pass;
    const unseen = resolved.filter(item => !seen.has(item.dedupeKey) && !(pass !== undefined && deliveredInPass(item, pass)));
    const delivered = unseen.slice(0, limit);
    const hasMore = unseen.length > delivered.length;

    const items: CollectedItem[] = delivered.map(entry => {
      const record: FeedRecord = {
        source: this.options.provider.source,
        accountRef: subscription.id,
        externalId: entry.externalId,
        occurredAt: entry.occurredAt,
        fetchedAt,
        contentRef: entry.link === '' ? `feeds://${subscription.id}/${encodeURIComponent(entry.externalId)}` : entry.link,
        sensitivity: subscription.sensitivity,
        dedupeKey: entry.dedupeKey,
        // `validFor` is left out on purpose: a feed entry states no expiry, and inventing one would
        // be a claim about the source that nothing in the document supports.
      };
      validateContract('connectorItem', record);
      return {
        record,
        title: entry.title,
        dedupeKeyKind: entry.dedupeKeyKind,
        occurredAtKind: entry.occurredAtKind,
        summary: entry.summary,
      };
    });

    const nextState: CursorState = {v: CURSOR_VERSION, seen: appendSeen(cursor, delivered.map(item => item.dedupeKey)).seen};
    if (hasMore) {
      // The tail was truncated, so the validators must NOT advance. If they did, the next poll
      // would get a 304 and report `unchanged`, and the entries beyond the limit would never be
      // delivered by anyone. Holding the validators forces a full refetch that the `seen` list
      // then filters down to exactly the remainder.
      if (cursor.etag !== undefined) nextState.etag = cursor.etag;
      if (cursor.lastModified !== undefined) nextState.lastModified = cursor.lastModified;
      const last = delivered[delivered.length - 1];
      if (last !== undefined) {
        const pass: PassState = {
          lastTime: last.occurredAt,
          lastId: last.externalId,
          delivered: (cursor.pass?.delivered ?? 0) + delivered.length,
        };
        // 记录趟开启时源携带的校验器：取尽时用于判断趟期间源是否变化。
        if (cursor.pass === undefined) {
          if (fetched.etag !== undefined) pass.startEtag = fetched.etag;
          if (fetched.lastModified !== undefined) pass.startModified = fetched.lastModified;
        } else {
          if (cursor.pass.startEtag !== undefined) pass.startEtag = cursor.pass.startEtag;
          if (cursor.pass.startModified !== undefined) pass.startModified = cursor.pass.startModified;
        }
        nextState.pass = pass;
      }
    } else if (cursor.pass !== undefined && sourceChangedDuringPass(cursor.pass, fetched)) {
      // Pass exhausted on a CONTINUATION poll AND the source changed while it ran: the watermark
      // suppressed everything above it — including entries inserted mid-pass (id4 above id2's
      // watermark). Adopting the response validator would 304 the next poll and strand them
      // forever (goo122 2026-09-13 复审 P1). Hold the previous validators once more: the next
      // poll refetches fully, the pass is gone so `seen` alone filters, and the inserted entry
      // arrives as a seen-miss.
      if (cursor.etag !== undefined) nextState.etag = cursor.etag;
      if (cursor.lastModified !== undefined) nextState.lastModified = cursor.lastModified;
    } else {
      // Pass exhausted with the source unchanged (or no pass continued): the watermark
      // suppressed nothing undelivered, so the response validators describe a fully consumed
      // document and are safe to adopt. Assigned from the response, not merged: a validator that
      // disappears between polls has to be dropped, otherwise the next conditional request could
      // 304 against a changed document.
      if (fetched.etag !== undefined) nextState.etag = fetched.etag;
      if (fetched.lastModified !== undefined) nextState.lastModified = fetched.lastModified;
    }

    return {
      items,
      hasMore,
      nextCursor: encodeCursor(nextState),
      collection: {
        state: 'fetched',
        subscriptionId: subscription.id,
        fetchedAt,
        feedTitle: document.title === '' ? null : redact(toPlainText(document.title, TITLE_LIMIT)),
        feedKind: document.kind,
        parsedItemCount: document.entries.length,
        deliveredCount: items.length,
        alreadySeenCount: resolved.length - unseen.length,
        conditional,
        validators: validatorsOf(fetched, cursor),
        skipped,
      },
    };
  }

  /** Re-fetches and locates one entry by `externalId`, matching `getItem`'s contract rather than `dedupeKey`. */
  async findItem(subscriptionId: string, externalId: string, signal?: AbortSignal): Promise<CollectedItem> {
    const result = await this.collect({subscriptionId, limit: MAX_LIMIT}, signal);
    const match = result.items.find(item => item.record.externalId === externalId);
    if (!match) {
      throw new ProtocolError('NOT_FOUND', `No entry with externalId ${externalId} is currently published by subscription ${subscriptionId}`, false);
    }
    return match;
  }
}

function carryValidators(cursor: CursorState, fetched: FeedFetch): CursorState {
  const state: CursorState = {v: CURSOR_VERSION, seen: cursor.seen};
  const etag = fetched.etag ?? cursor.etag;
  const lastModified = fetched.lastModified ?? cursor.lastModified;
  if (etag !== undefined) state.etag = etag;
  if (lastModified !== undefined) state.lastModified = lastModified;
  // A 304 mid-pass leaves the document unchanged, so the pass watermark survives untouched.
  if (cursor.pass !== undefined) state.pass = cursor.pass;
  return state;
}

/**
 * Whether the source changed while the pass ran: its validators now differ from the ones the
 * document carried when the pass started. Only a change makes exhaust-time watermark suppression
 * suspect — an unchanged document was fully paginated by definition.
 */
function sourceChangedDuringPass(pass: NonNullable<CursorState['pass']>, fetched: FeedFetch): boolean {
  if (pass.startEtag !== undefined || pass.startModified !== undefined) {
    return fetched.etag !== pass.startEtag || fetched.lastModified !== pass.startModified;
  }
  // The pass started under a validator-less document, so there is nothing to compare against;
  // treat any validator the source now sends as a change.
  return fetched.etag !== undefined || fetched.lastModified !== undefined;
}

/**
 * Whether the entry sorts strictly above the pass watermark — i.e. at a later `occurredAt`, or the
 * same instant with a smaller `externalId` — meaning this pass has already delivered it. Entries
 * inserted above the watermark mid-pass are genuinely new and are picked up after the pass ends
 * (they are not in `seen`), never silently skipped.
 */
function deliveredInPass(entry: ResolvedEntry, pass: CursorState['pass']): boolean {
  if (pass === undefined) return false;
  const byTime = entry.occurredAt.localeCompare(pass.lastTime);
  return byTime > 0 || (byTime === 0 && entry.externalId.localeCompare(pass.lastId) < 0);
}

/**
 * What the source actually gave us this poll.
 *
 * The two states mean different things. On a 304 the response may omit the validators entirely, and
 * the ones just replayed still describe an unchanged document, so they are reported. On a full fetch
 * the response is authoritative: a validator that is absent means the source stopped providing one,
 * and echoing the previous value would claim conditional-request support that no longer exists.
 */
function validatorsOf(fetched: FeedFetch, cursor: CursorState): CollectionState['validators'] {
  if (fetched.state === 'unchanged') {
    return {
      etag: fetched.etag ?? cursor.etag ?? null,
      lastModified: fetched.lastModified ?? cursor.lastModified ?? null,
    };
  }
  return {etag: fetched.etag ?? null, lastModified: fetched.lastModified ?? null};
}

function skipReason(missingOccurredAt: boolean, missingIdentifier: boolean): SkipReason {
  if (missingOccurredAt && missingIdentifier) return 'no_identifier_and_no_occurred_at';
  return missingOccurredAt ? 'no_occurred_at' : 'no_identifier';
}

function resolveOccurredAt(
  publishedText: string,
  updatedText: string,
  buildDate: string | null,
): {at: string; kind: OccurredAtKind} | null {
  const published = parseFeedDate(publishedText);
  if (published !== null) return {at: published, kind: 'item_published'};
  const updated = parseFeedDate(updatedText);
  if (updated !== null) return {at: updated, kind: 'item_updated'};
  // A feed-level build time is still a real timestamp from the document, so it is delivered with
  // its provenance labelled rather than dropped. What is never substituted is `fetchedAt`: that
  // would present the moment of collection as the moment of publication.
  if (buildDate !== null) return {at: buildDate, kind: 'feed_build'};
  return null;
}

function resolveIdentifier(
  entry: {title: string; link: string; nativeId: string; bodyText: string},
  occurred: {at: string} | null,
  redact: (text: string) => string,
): {externalId: string; kind: DedupeKeyKind} | null {
  if (entry.nativeId !== '') return {externalId: redact(entry.nativeId), kind: 'item_guid'};
  if (entry.link !== '') return {externalId: redact(entry.link), kind: 'item_link'};
  // Nothing to hash means nothing to identify: hashing an all-empty tuple would give every such
  // entry the same key and silently merge distinct items into one.
  if (entry.title === '' && entry.bodyText === '') return null;
  const digest = createHash('sha256')
    .update([entry.title, occurred?.at ?? '', toPlainText(entry.bodyText, HASH_BODY_LIMIT)].join('\u0000'), 'utf8')
    .digest('hex');
  return {externalId: digest, kind: 'content_hash'};
}
