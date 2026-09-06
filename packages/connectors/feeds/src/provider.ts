import { ProtocolError } from '@personal-agent/contracts';

/** Mirrors the weather connector: `mock` is test-only, `conditional` means the live path is reachable but not proven this round. */
export type FeedVerification = 'mock' | 'verified' | 'conditional';

export interface FeedFetchRequest {
  url: string;
  /** Replay of the validators stored in the cursor, sent as `If-None-Match` / `If-Modified-Since`. */
  etag?: string;
  lastModified?: string;
}

/**
 * The provider is transport only: it hands back the raw document and the validators it observed.
 * Parsing lives in `parser.ts` so the same code path handles recorded fixtures and live responses.
 */
export interface FeedFetch {
  /** `unchanged` is a real 304 — no body, and the caller must not treat it as "zero new items". */
  state: 'fetched' | 'unchanged';
  body?: string;
  etag?: string;
  lastModified?: string;
}

export interface FeedProvider {
  readonly source: string;
  readonly verification: FeedVerification;
  fetchFeed(request: FeedFetchRequest, signal: AbortSignal): Promise<FeedFetch>;
}

export interface FixtureFeed {
  url: string;
  body: string;
  etag?: string;
  lastModified?: string;
}

/**
 * Two items, hand written. Enough for `new FakeFeedProvider()` to be usable with no arguments,
 * which is what an offline demo needs; the test suite supplies the recorded fixtures instead.
 */
export const defaultFeedFixtures: FixtureFeed[] = [
  {
    url: 'https://example.invalid/feed.xml',
    etag: 'W/"fixture-1"',
    lastModified: 'Sat, 05 Sep 2026 08:30:00 GMT',
    body: [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<rss version="2.0"><channel>',
      '<title>内置夹具源</title><link>https://example.invalid/</link>',
      '<lastBuildDate>Sat, 05 Sep 2026 08:30:00 +0000</lastBuildDate>',
      '<item><title>第一条</title><link>https://example.invalid/1</link>',
      '<guid>https://example.invalid/1</guid><pubDate>Sat, 05 Sep 2026 08:00:00 +0000</pubDate>',
      '<description>合成夹具，非真实源响应。</description></item>',
      '<item><title>第二条</title><link>https://example.invalid/2</link>',
      '<guid>https://example.invalid/2</guid><pubDate>Fri, 04 Sep 2026 08:00:00 +0000</pubDate>',
      '<description>合成夹具，非真实源响应。</description></item>',
      '</channel></rss>',
    ].join(''),
  },
];

export class FakeFeedProvider implements FeedProvider {
  readonly source = 'fixture-feeds';
  readonly verification = 'mock' as const;
  private calls = 0;
  private failure: ProtocolError | null = null;
  private fixtures: FixtureFeed[];

  constructor(fixtures: FixtureFeed[] = defaultFeedFixtures) {
    this.fixtures = [...fixtures];
  }

  get fetchCalls(): number { return this.calls; }

  setFailure(error: ProtocolError | null): void { this.failure = error; }

  /** Lets a test drop or change the validators between two polls, which real sources do. */
  setFixtures(fixtures: FixtureFeed[]): void { this.fixtures = [...fixtures]; }

  async fetchFeed(request: FeedFetchRequest, signal: AbortSignal): Promise<FeedFetch> {
    this.calls++;
    if (signal.aborted) throw new ProtocolError('CANCELLED', 'Feed fetch cancelled');
    if (this.failure) throw this.failure;
    // The URL never appears in an error message: configured feed URLs may carry a token.
    const fixture = this.fixtures.find(item => item.url === request.url);
    if (!fixture) throw new ProtocolError('NOT_FOUND', 'The fake feed provider has no fixture for this subscription');

    const etagMatches = fixture.etag !== undefined && request.etag === fixture.etag;
    const modifiedMatches = fixture.lastModified !== undefined && request.lastModified === fixture.lastModified;
    if (etagMatches || modifiedMatches) return withValidators({state: 'unchanged'}, fixture);
    return withValidators({state: 'fetched', body: fixture.body}, fixture);
  }
}

function withValidators(fetch: FeedFetch, fixture: FixtureFeed): FeedFetch {
  if (fixture.etag !== undefined) fetch.etag = fixture.etag;
  if (fixture.lastModified !== undefined) fetch.lastModified = fixture.lastModified;
  return fetch;
}
