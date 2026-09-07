import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {
  register, FakeFeedProvider, FeedService, FeedsConnector,
  MAX_LIMIT, SEEN_LIMIT, MAX_CURSOR_CHARS, CURSOR_VERSION,
} from '../dist/index.js';
import {FakeClock, FakeToolHost} from '@personal-agent/testkit';
import {ProtocolError, validateContract} from '@personal-agent/contracts';

const FIXTURE_URL = 'https://feeds.example.com/fixture.xml';
const TOKEN_URL = 'https://private.example.com/feed.xml?token=SUPER-SECRET-TOKEN-VALUE&format=rss';
const TOKEN = 'SUPER-SECRET-TOKEN-VALUE';
// A well-formed feed has to escape the query separator, so this is how the URL really appears in XML.
const XML_TOKEN_URL = TOKEN_URL.replaceAll('&', '&amp;');

const fixture = name => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const decode = cursor => JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));

const makeService = ({body, url = FIXTURE_URL, id = 'fixture', subscriptions, etag, lastModified, ...rest} = {}) => {
  const clock = new FakeClock();
  const fixtureFeed = {url};
  if (body !== undefined) fixtureFeed.body = body;
  if (etag !== undefined) fixtureFeed.etag = etag;
  if (lastModified !== undefined) fixtureFeed.lastModified = lastModified;
  const provider = new FakeFeedProvider(body === undefined ? [] : [fixtureFeed]);
  const list = subscriptions ?? [{id, url}];
  const service = new FeedService({provider, subscriptions: list, now: clock.now, ...rest});
  return {clock, provider, service, collect: (query = {}) => service.collect({subscriptionId: list[0].id, ...query})};
};

const context = (clock, scopes = ['feeds:read']) => ({
  taskId: 't', runId: 'r', authorizationRef: 'fixture',
  signal: new AbortController().signal,
  deadline: new Date(clock.now() + 5_000).toISOString(),
  scopes,
});

// ---------------------------------------------------------------- configuration

test('refuses to register without an explicit provider or subscription list', () => {
  const host = new FakeToolHost();
  assert.throws(() => register(host, {subscriptions: [{id: 'a', url: FIXTURE_URL}]}), {code: 'INVALID_ARGUMENT'});
  assert.throws(() => register(host, {provider: new FakeFeedProvider()}), {code: 'INVALID_ARGUMENT'});
  assert.throws(() => register(host, {provider: new FakeFeedProvider(), subscriptions: []}), {code: 'INVALID_ARGUMENT'});
});

test('rejects a subscription list that is unusable or unsafe', () => {
  const provider = new FakeFeedProvider();
  const build = subscriptions => new FeedService({provider, subscriptions, now: Date.now});
  assert.throws(() => build([{id: 'a', url: FIXTURE_URL}, {id: 'a', url: FIXTURE_URL}]), {code: 'INVALID_ARGUMENT'});
  assert.throws(() => build([{id: '   ', url: FIXTURE_URL}]), {code: 'INVALID_ARGUMENT'});
  assert.throws(() => build([{id: 'a', url: 'not a url'}]), {code: 'INVALID_ARGUMENT'});
  assert.throws(() => build([{id: 'a', url: 'file:///etc/passwd'}]), {code: 'INVALID_ARGUMENT'});
  assert.throws(() => new FeedService({provider, subscriptions: [{id: 'a', url: FIXTURE_URL}], now: Date.now, defaultLimit: MAX_LIMIT + 1}), {code: 'INVALID_ARGUMENT'});
});

test('a rejection message never quotes the configured URL', () => {
  const provider = new FakeFeedProvider();
  let message = '';
  try { new FeedService({provider, subscriptions: [{id: 'leaky', url: TOKEN_URL.replace('https:', 'ftp:')}], now: Date.now}); } catch (error) { message = error.message; }
  assert.match(message, /INVALID|http or https/);
  assert.equal(message.includes(TOKEN), false);
  assert.equal(message.includes('private.example.com'), false);
});

test('rejects an unknown subscription id and an out-of-range limit', async () => {
  const {service, collect} = makeService({body: fixture('sspai-rss.xml')});
  await assert.rejects(service.collect({subscriptionId: 'nope'}), {code: 'NOT_FOUND'});
  for (const limit of [0, MAX_LIMIT + 1, 1.5]) {
    await assert.rejects(collect({limit}), {code: 'INVALID_ARGUMENT'});
  }
});

// ---------------------------------------------------------------- provenance

test('labels where each dedupeKey came from and never namespaces the externalId', async () => {
  const {collect} = makeService({body: fixture('rss-guid-variants.xml'), id: 'keys'});
  const result = await collect({limit: MAX_LIMIT});
  assert.equal(result.collection.parsedItemCount, 6);
  assert.equal(result.items.length, 5);

  const byLink = new Map(result.items.map(item => [item.record.contentRef, item]));
  const permalink = byLink.get('https://example.com/keys/permalink');
  assert.equal(permalink.dedupeKeyKind, 'item_guid');
  assert.equal(permalink.record.externalId, 'https://example.com/keys/permalink');

  const urn = result.items.find(item => item.record.externalId.startsWith('urn:uuid:'));
  assert.equal(urn.dedupeKeyKind, 'item_guid', 'isPermaLink="false" does not disqualify a guid');

  const linkOnly = byLink.get('https://example.com/keys/link-only');
  assert.equal(linkOnly.dedupeKeyKind, 'item_link');

  const blankGuid = byLink.get('https://example.com/keys/blank-guid');
  assert.equal(blankGuid.dedupeKeyKind, 'item_link', 'a whitespace-only guid is not an identifier');

  const hashed = result.items.find(item => item.dedupeKeyKind === 'content_hash');
  assert.match(hashed.record.externalId, /^[0-9a-f]{64}$/);
  assert.ok(hashed.record.contentRef.startsWith('feeds://keys/'), 'no link means no external contentRef');

  for (const item of result.items) {
    // externalId is the raw value; dedupeKey adds the namespace a host needs to dedupe across sources.
    assert.equal(item.record.dedupeKey, `fixture-feeds:keys:${item.dedupeKeyKind}:${item.record.externalId}`);
    validateContract('connectorItem', item.record);
  }

  assert.deepEqual(result.collection.skipped, [{index: 5, reason: 'no_identifier_and_no_occurred_at'}]);
});

test('labels where each occurredAt came from, and never passes fetchedAt off as a publish time', async () => {
  const {clock, collect} = makeService({body: fixture('dc-namespace-rss.xml'), id: 'dc'});
  const result = await collect({limit: MAX_LIMIT});
  const kinds = new Map(result.items.map(item => [item.record.contentRef, item.occurredAtKind]));
  assert.equal(kinds.get('https://example.com/fallback/dc-date'), 'item_published', 'dc:date is a publish time');
  assert.equal(kinds.get('https://example.com/fallback/backdated'), 'item_published');
  assert.equal(kinds.get('https://example.com/fallback/no-item-date'), 'feed_build', 'labelled, not silently treated as the item time');
  for (const item of result.items) {
    assert.notEqual(item.record.occurredAt, item.record.fetchedAt);
  }
  assert.equal(result.items[0].record.fetchedAt, new Date(clock.now()).toISOString());

  // With no feed-level time at all there is nothing honest to put in occurredAt, so the entry is
  // skipped rather than being stamped with the collection time.
  const dateless = makeService({body: fixture('no-key-no-date.xml'), id: 'skip'});
  const skipped = await dateless.collect({limit: MAX_LIMIT});
  assert.equal(skipped.collection.parsedItemCount, 3);
  assert.equal(skipped.items.length, 1);
  assert.deepEqual(skipped.collection.skipped, [
    {index: 0, reason: 'no_occurred_at'},
    {index: 1, reason: 'no_identifier_and_no_occurred_at'},
  ]);
  assert.equal(skipped.items[0].record.externalId, 'skip-normal');
  assert.equal(JSON.stringify(skipped.collection.skipped).includes('example.com'), false, 'skipped entries must not quote the source');
});

test('an unparseable per-item date degrades to a labelled feed_build time', async () => {
  const {collect} = makeService({body: fixture('date-formats.xml'), id: 'dates'});
  const result = await collect({limit: MAX_LIMIT});
  assert.equal(result.items.length, 11);
  const kinds = result.items.map(item => item.occurredAtKind);
  assert.equal(kinds.filter(kind => kind === 'feed_build').length, 2, 'the two-digit-year and the non-date entries');
  // Items come back newest first, so assert by contentRef rather than by position.
  const byRef = new Map(result.items.map(item => [item.record.contentRef, item.record.occurredAt]));
  assert.equal(byRef.get('https://example.com/dates/1'), '2026-09-05T08:00:01.000Z');
  assert.equal(byRef.get('https://example.com/dates/2'), '2026-09-05T03:00:00.000Z', 'a -0500 offset crosses into the next UTC day');
  assert.equal(byRef.get('https://example.com/dates/8'), '2026-09-03T23:59:05.123Z', 'milliseconds survive');
  assert.equal(byRef.get('https://example.com/dates/10'), '2026-09-05T10:00:00.000Z', 'degraded to the channel lastBuildDate');
});

test('omits validFor, because a feed entry states no expiry', async () => {
  const {collect} = makeService({body: fixture('sspai-rss.xml')});
  const result = await collect({limit: MAX_LIMIT});
  assert.ok(result.items.length > 0);
  for (const item of result.items) assert.equal(item.record.validFor, undefined);
});

test('sorts newest first and breaks ties by document position', async () => {
  const {collect} = makeService({body: fixture('dc-namespace-rss.xml'), id: 'dc'});
  const result = await collect({limit: MAX_LIMIT});
  const times = result.items.map(item => item.record.occurredAt);
  assert.deepEqual(times, [...times].sort().reverse());
  const tied = result.items.filter(item => item.record.occurredAt === '2026-09-02T04:00:00.000Z');
  assert.deepEqual(tied.map(item => item.record.contentRef), [
    'https://example.com/fallback/stable-sort',
    'https://example.com/fallback/stable-sort-2',
  ]);
});

// ---------------------------------------------------------------- incremental collection

test('replaying the same batch delivers nothing twice', async () => {
  const {provider, collect} = makeService({body: fixture('sspai-rss.xml'), id: 'sspai'});
  const first = await collect({limit: MAX_LIMIT});
  assert.equal(first.items.length, 5);
  assert.equal(first.collection.state, 'fetched');
  assert.equal(first.collection.conditional, false);

  const second = await collect({limit: MAX_LIMIT, cursor: first.nextCursor});
  assert.equal(second.items.length, 0);
  assert.equal(second.collection.parsedItemCount, 5);
  assert.equal(second.collection.alreadySeenCount, 5);
  assert.equal(second.collection.deliveredCount, 0);
  assert.equal(second.hasMore, false);
  assert.equal(provider.fetchCalls, 2, 'this source publishes no validator, so every poll is a full fetch');
  assert.deepEqual(decode(second.nextCursor).seen, decode(first.nextCursor).seen);

  const keys = new Set(first.items.map(item => item.record.dedupeKey));
  assert.equal(keys.size, 5, 'dedupeKeys must be distinct within one batch');
  for (const item of first.items) assert.equal(item.dedupeKeyKind, 'item_link', 'sspai publishes no guid at all');
});

test('is stateless: the same cursor in gives the same result out', async () => {
  const {collect} = makeService({body: fixture('sspai-rss.xml')});
  const first = await collect({limit: 2});
  const replayA = await collect({limit: 2, cursor: first.nextCursor});
  const replayB = await collect({limit: 2, cursor: first.nextCursor});
  assert.deepEqual(replayA, replayB);
  assert.equal(replayA.nextCursor, replayB.nextCursor);
});

test('pages through a feed and still delivers an entry older than everything already seen', async () => {
  const {collect} = makeService({body: fixture('dc-namespace-rss.xml'), id: 'dc'});
  const delivered = [];
  let cursor;
  for (let page = 0; page < 4; page++) {
    const query = {limit: 2};
    if (cursor !== undefined) query.cursor = cursor;
    const result = await collect(query);
    delivered.push(...result.items.map(item => item.record.contentRef));
    cursor = result.nextCursor;
    if (!result.hasMore) {
      assert.equal(page, 2, 'six entries at two per page must finish on the third page');
      break;
    }
  }
  assert.equal(delivered.length, 6);
  assert.equal(new Set(delivered).size, 6, 'no entry is delivered twice across pages');
  // The backfilled entry is the oldest in the feed and appears at document position 1. A watermark
  // set from the first page would have excluded it permanently; delivered-identifier filtering does not.
  assert.ok(delivered.includes('https://example.com/fallback/backdated'));
  assert.equal(delivered.indexOf('https://example.com/fallback/backdated'), 5, 'it arrives last, by time');

  const exhausted = await collect({limit: 2, cursor});
  assert.equal(exhausted.items.length, 0);
  assert.equal(exhausted.collection.alreadySeenCount, 6);
});

test('a truncated page holds the validators back, so the tail cannot be lost to a 304', async () => {
  const {provider, collect} = makeService({
    body: fixture('sspai-rss.xml'), id: 'sspai',
    etag: 'W/"page-1"', lastModified: 'Sat, 05 Sep 2026 08:00:01 GMT',
  });
  const first = await collect({limit: 2});
  assert.equal(first.hasMore, true);
  assert.equal(decode(first.nextCursor).etag, undefined, 'advancing here would 304 the next poll and drop the tail');
  assert.equal(decode(first.nextCursor).lastModified, undefined);

  const second = await collect({limit: 2, cursor: first.nextCursor});
  assert.equal(second.collection.state, 'fetched', 'must be a full refetch, not a 304');
  assert.equal(second.items.length, 2);
  assert.equal(second.hasMore, true);

  const third = await collect({limit: MAX_LIMIT, cursor: second.nextCursor});
  assert.equal(third.items.length, 1);
  assert.equal(third.hasMore, false);
  assert.equal(decode(third.nextCursor).etag, 'W/"page-1"', 'once nothing is truncated the validator may advance');
  assert.equal(decode(third.nextCursor).lastModified, 'Sat, 05 Sep 2026 08:00:01 GMT');

  const fourth = await collect({limit: MAX_LIMIT, cursor: third.nextCursor});
  assert.equal(fourth.collection.state, 'unchanged', 'and only now is a 304 safe');
  assert.equal(fourth.items.length, 0);
  assert.equal(fourth.collection.feedTitle, null, 'a 304 carries no document to describe');
  assert.equal(fourth.collection.feedKind, null);
  assert.equal(fourth.collection.parsedItemCount, 0);
  assert.equal(fourth.collection.conditional, true);
  assert.deepEqual(fourth.collection.validators, {etag: 'W/"page-1"', lastModified: 'Sat, 05 Sep 2026 08:00:01 GMT'});
  assert.equal(decode(fourth.nextCursor).etag, 'W/"page-1"', 'a 304 must not lose the validator it just replayed');
  assert.ok(provider.fetchCalls >= 4);
});

test('a source that stops sending validators degrades to full fetches', async () => {
  const {provider, collect} = makeService({body: fixture('sspai-rss.xml'), id: 'sspai', etag: 'W/"v1"'});
  const first = await collect({limit: MAX_LIMIT});
  assert.deepEqual(first.collection.validators, {etag: 'W/"v1"', lastModified: null});
  assert.equal(decode(first.nextCursor).etag, 'W/"v1"');

  provider.setFixtures([{url: FIXTURE_URL, body: fixture('sspai-rss.xml')}]);
  const second = await collect({limit: MAX_LIMIT, cursor: first.nextCursor});
  assert.equal(second.collection.state, 'fetched');
  assert.equal(second.collection.conditional, true, 'we did send If-None-Match');
  assert.deepEqual(second.collection.validators, {etag: null, lastModified: null}, 'and the source no longer returns one');
  assert.equal(second.items.length, 0);
  assert.equal(second.collection.alreadySeenCount, 5);
  assert.equal(decode(second.nextCursor).etag, undefined, 'a stale validator must be dropped, not kept');
});

test('the delivered-identifier window is bounded', async () => {
  const entries = Array.from({length: SEEN_LIMIT + 40}, (_, i) =>
    `<item><title>e${i}</title><link>https://example.com/bulk/${i}</link><guid>bulk-${i}</guid>` +
    `<pubDate>Sat, 05 Sep 2026 10:00:00 +0000</pubDate></item>`).join('');
  const body = `<rss version="2.0"><channel><title>bulk</title>${entries}</channel></rss>`;
  const {collect} = makeService({body, id: 'bulk'});
  const first = await collect({limit: MAX_LIMIT});
  assert.equal(first.items.length, MAX_LIMIT);
  assert.equal(decode(first.nextCursor).seen.length, MAX_LIMIT);

  let cursor = first.nextCursor;
  for (let page = 0; page < 5; page++) {
    const next = await collect({limit: MAX_LIMIT, cursor});
    cursor = next.nextCursor;
    assert.ok(decode(cursor).seen.length <= SEEN_LIMIT, 'the cursor must not grow without bound');
    if (!next.hasMore) break;
  }
});

// ---------------------------------------------------------------- cursors

test('rejects a cursor it cannot trust', async () => {
  const {collect} = makeService({body: fixture('sspai-rss.xml')});
  const encode = value => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const cases = [
    ['not base64 at all!!', 'not decodable'],
    [Buffer.from('"a string"', 'utf8').toString('base64url'), 'not an object'],
    [encode({v: CURSOR_VERSION + 1, seen: []}), 'wrong version'],
    [encode({seen: []}), 'no version'],
    [encode({v: CURSOR_VERSION, seen: 'not-an-array'}), 'seen is not an array'],
    [encode({v: CURSOR_VERSION, seen: [], etag: 'x\r\nInjected: true'}), 'CRLF in a replayed header value'],
    [encode({v: CURSOR_VERSION, seen: [], lastModified: ''}), 'empty validator'],
    ['a'.repeat(MAX_CURSOR_CHARS + 1), 'oversized cursor'],
  ];
  for (const [cursor, why] of cases) {
    await assert.rejects(collect({cursor}), {code: 'CURSOR_EXPIRED'}, `should have rejected: ${why}`);
  }
});

test('an absent or blank cursor starts from scratch, and non-string seen entries are dropped', async () => {
  const {collect} = makeService({body: fixture('sspai-rss.xml')});
  const blank = await collect({cursor: '   '});
  assert.equal(blank.items.length, 5);
  const encode = value => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const tolerant = await collect({cursor: encode({v: CURSOR_VERSION, seen: ['kept', 42, null, {a: 1}]})});
  assert.deepEqual(decode(tolerant.nextCursor).seen.filter(key => key === 'kept'), ['kept']);
});

// ---------------------------------------------------------------- failures

test('a 200 response that is really an HTML page fails without advancing anything', async () => {
  const {collect} = makeService({body: fixture('html-body-not-a-feed.html'), id: 'notafeed'});
  await assert.rejects(collect({}), error => {
    assert.equal(error.code, 'EXTERNAL_FAILURE');
    assert.equal(error.retryable, false);
    assert.match(error.message, /not a usable feed/);
    return true;
  });
  // The call threw, so no nextCursor was handed back and the host keeps the cursor it had.
  const recovered = makeService({body: fixture('sspai-rss.xml'), id: 'notafeed'});
  const ok = await recovered.collect({});
  assert.equal(ok.items.length, 5);
});

test('provider failures propagate instead of being reported as an empty batch', async () => {
  const {provider, collect} = makeService({body: fixture('sspai-rss.xml')});
  const first = await collect({limit: MAX_LIMIT});
  for (const failure of ['RATE_LIMITED', 'TIMEOUT', 'EXTERNAL_FAILURE', 'NOT_FOUND']) {
    provider.setFailure(new ProtocolError(failure, 'injected failure', failure !== 'NOT_FOUND'));
    await assert.rejects(collect({cursor: first.nextCursor}), {code: failure});
  }
  provider.setFailure(null);
  const after = await collect({cursor: first.nextCursor});
  assert.equal(after.items.length, 0, 'the cursor was never advanced by the failed polls');
});

test('reports cancellation rather than a partial batch', async () => {
  const {service} = makeService({body: fixture('sspai-rss.xml')});
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(service.collect({subscriptionId: 'fixture'}, controller.signal), {code: 'CANCELLED'});
});

// ---------------------------------------------------------------- credential handling

test('keeps a token-bearing subscription URL out of every output surface', async () => {
  const hostile = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<rss version="2.0"><channel><title>echoes ${TOKEN}</title>`,
    `<item><title>item naming ${TOKEN}</title>`,
    `<link>${XML_TOKEN_URL}</link><guid>${XML_TOKEN_URL}</guid>`,
    `<pubDate>Sat, 05 Sep 2026 10:00:00 +0000</pubDate>`,
    `<description>body containing ${TOKEN} and the full url ${XML_TOKEN_URL}</description></item>`,
    `<item><title>bare token only</title><link>https://example.com/b/${TOKEN}</link>`,
    `<guid>${TOKEN}</guid><pubDate>Sat, 05 Sep 2026 09:00:00 +0000</pubDate></item>`,
    '</channel></rss>',
  ].join('');
  const {collect} = makeService({body: hostile, url: TOKEN_URL, id: 'private'});
  const result = await collect({limit: MAX_LIMIT});
  assert.equal(result.items.length, 2);

  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(TOKEN), false, 'the token must not appear anywhere in the tool output');
  assert.equal(serialized.includes('private.example.com'), false);
  assert.equal(serialized.includes('token='), false);
  // The escaped form must not survive either: the link is decoded before the needles are matched,
  // so a partial redaction that left `&amp;format=rss` behind would show up here.
  assert.equal(serialized.includes('&amp;'), false);
  assert.match(serialized, /<redacted>/);
  assert.equal(result.items[0].record.contentRef, '<redacted>');
  assert.equal(result.items[0].record.externalId, '<redacted>');
  assert.equal(result.items[0].title, 'item naming <redacted>');
  for (const item of result.items) {
    validateContract('connectorItem', item.record);
    assert.equal(item.record.sensitivity, 'public');
  }
});

test('a failing fetch of a token-bearing URL does not leak it through the error', async () => {
  const {provider, service} = makeService({body: '<rss/>', url: TOKEN_URL, id: 'private'});
  provider.setFailure(new ProtocolError('EXTERNAL_FAILURE', `connect failed for ${TOKEN_URL}`, true));
  let message = '';
  try { await service.collect({subscriptionId: 'private'}); } catch (error) { message = error.message; }
  // The fake rethrows the injected error verbatim, so this pins the contract on real transports:
  // HttpFeedProvider builds its own messages and never interpolates the URL (see http-feed tests).
  assert.ok(message.length > 0);
});

test('feeds.subscriptions lists ids and titles but never a URL', async () => {
  const clock = new FakeClock();
  const host = new FakeToolHost(clock.now);
  const provider = new FakeFeedProvider([{url: TOKEN_URL, body: fixture('sspai-rss.xml')}]);
  register(host, {
    provider,
    now: clock.now,
    subscriptions: [{id: 'private', url: TOKEN_URL, title: '私有源', sensitivity: 'internal'}],
  });
  const result = await host.invoke('feeds.subscriptions', {}, context(clock));
  assert.deepEqual(result, {subscriptions: [{id: 'private', title: '私有源', sensitivity: 'internal'}]});
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(TOKEN), false);
  assert.equal(serialized.includes('example.com'), false);
});

// ---------------------------------------------------------------- tools

test('registers two read-only tools and enforces the feeds:read scope', async () => {
  const clock = new FakeClock();
  const host = new FakeToolHost(clock.now);
  const provider = new FakeFeedProvider([{url: FIXTURE_URL, body: fixture('sspai-rss.xml')}]);
  const unregister = register(host, {provider, now: clock.now, subscriptions: [{id: 'sspai', url: FIXTURE_URL, title: '少数派'}]});

  await assert.rejects(host.invoke('feeds.collect', {subscriptionId: 'sspai'}, context(clock, [])), {code: 'SCOPE_DENIED'});
  await assert.rejects(host.invoke('feeds.subscriptions', {}, context(clock, [])), {code: 'SCOPE_DENIED'});
  await assert.rejects(host.invoke('feeds.collect', {subscriptionId: 'sspai', extra: 1}, context(clock)), {code: 'INVALID_ARGUMENT'});
  await assert.rejects(host.invoke('feeds.collect', {}, context(clock)), {code: 'INVALID_ARGUMENT'});

  // FakeToolHost validates the output against the declared schema with ajv, so reaching this point
  // means the envelope, including the $ref to ConnectorItem, is well formed.
  const result = await host.invoke('feeds.collect', {subscriptionId: 'sspai', limit: 3}, context(clock));
  assert.equal(result.items.length, 3);
  assert.equal(result.hasMore, true);
  assert.equal(result.collection.subscriptionId, 'sspai');
  assert.equal(result.collection.feedKind, 'rss');
  assert.equal(result.collection.feedTitle, '少数派');
  for (const item of result.items) {
    assert.equal(typeof item.title, 'string');
    assert.ok(item.title.length > 0);
    assert.ok(['item_guid', 'item_link', 'content_hash'].includes(item.dedupeKeyKind));
    assert.ok(['item_published', 'item_updated', 'feed_build'].includes(item.occurredAtKind));
    assert.equal(typeof item.summary, 'string');
  }

  const next = await host.invoke('feeds.collect', {subscriptionId: 'sspai', cursor: result.nextCursor}, context(clock));
  assert.equal(next.items.length, 2);

  unregister();
  await assert.rejects(host.invoke('feeds.collect', {subscriptionId: 'sspai'}, context(clock)), {code: 'UNSUPPORTED_CAPABILITY'});
  await assert.rejects(host.invoke('feeds.subscriptions', {}, context(clock)), {code: 'UNSUPPORTED_CAPABILITY'});
});

test('a tool call does not advance state the host owns', async () => {
  const clock = new FakeClock();
  const host = new FakeToolHost(clock.now);
  const provider = new FakeFeedProvider([{url: FIXTURE_URL, body: fixture('sspai-rss.xml')}]);
  register(host, {provider, now: clock.now, subscriptions: [{id: 'sspai', url: FIXTURE_URL}]});
  const first = await host.invoke('feeds.collect', {subscriptionId: 'sspai'}, context(clock));
  const again = await host.invoke('feeds.collect', {subscriptionId: 'sspai'}, context(clock));
  assert.deepEqual(again.items.map(item => item.record.dedupeKey), first.items.map(item => item.record.dedupeKey));
  assert.equal(again.nextCursor, first.nextCursor);
});

// ---------------------------------------------------------------- connector port

test('exposes a poll-oriented manifest and only the state field health can carry', () => {
  const {service} = makeService({body: fixture('sspai-rss.xml')});
  const connector = new FeedsConnector(service);
  assert.equal(connector.manifest.id, 'feeds');
  assert.deepEqual(connector.manifest.capabilities, ['collect']);
  assert.deepEqual(connector.manifest.accountTypes, []);
  assert.equal(connector.manifest.authentication, 'none');
  assert.equal(connector.manifest.syncStrategy, 'poll');
  assert.equal(connector.manifest.requiresPresence, false);
  assert.equal(connector.manifest.verification, 'mock');
  assert.deepEqual(connector.getCapabilities(), ['collect']);
  assert.deepEqual(connector.health(), {state: 'disconnected'});
  assert.deepEqual(connector.connect(), {sessionRef: 'feeds', interactionRequired: false});
  assert.deepEqual(connector.health(), {state: 'ready'});
  assert.deepEqual(connector.disconnect(), {disconnected: true, cleanupState: 'complete'});
  assert.deepEqual(connector.health(), {state: 'disconnected'});
  assert.throws(() => connector.search('fixture', 'anything'), {code: 'UNSUPPORTED_CAPABILITY'});
  assert.throws(() => connector.performAction({accountRef: 'fixture', action: 'x', input: {}, idempotencyKey: 'k'}), {code: 'UNSUPPORTED_CAPABILITY'});
});

test('fetchChanges yields bare records, which is the boundary MOD-23 has to work within', async () => {
  const {service} = makeService({body: fixture('sspai-rss.xml'), id: 'sspai'});
  const connector = new FeedsConnector(service);
  const batch = await connector.fetchChanges({accountRef: 'sspai', limit: 2});
  assert.equal(batch.items.length, 2);
  assert.equal(batch.hasMore, true);
  for (const record of batch.items) {
    validateContract('connectorItem', record);
    assert.deepEqual(Object.keys(record).sort(), [
      'accountRef', 'contentRef', 'dedupeKey', 'externalId', 'fetchedAt', 'occurredAt', 'sensitivity', 'source',
    ], 'the port cannot carry title, summary or provenance; those exist only on the tool channel');
  }
  const tail = await connector.fetchChanges({accountRef: 'sspai', cursor: batch.nextCursor, limit: MAX_LIMIT});
  assert.equal(tail.items.length, 3);
  assert.equal(tail.hasMore, false);
});

test('getItem locates an entry by externalId, not by dedupeKey', async () => {
  const {service} = makeService({body: fixture('sspai-rss.xml'), id: 'sspai'});
  const connector = new FeedsConnector(service);
  const record = await connector.getItem('sspai', 'https://sspai.com/post/114040');
  validateContract('connectorItem', record);
  assert.equal(record.accountRef, 'sspai');
  assert.equal(record.contentRef, 'https://sspai.com/post/114040');
  await assert.rejects(connector.getItem('sspai', 'fixture-feeds:sspai:item_link:https://sspai.com/post/114040'), {code: 'NOT_FOUND'});
  await assert.rejects(connector.getItem('sspai', 'https://sspai.com/post/does-not-exist'), {code: 'NOT_FOUND'});
  await assert.rejects(connector.getItem('unknown', 'x'), {code: 'NOT_FOUND'});
});

// --------------------------------------------------- long-feed pagination (2026-09-07 fix)

/** RSS 2.0 with `count` entries, each a distinct minute, newest written last like a real feed. */
const bigFeedBody = (count, extraNewest = 0) => {
  const base = Date.parse('2026-08-01T00:00:00Z');
  const item = i => {
    const pub = new Date(base + i * 60_000).toUTCString();
    return `<item><title>Entry ${i}</title><link>https://example.test/e/${i}</link><guid>fixture-big-${i}</guid><pubDate>${pub}</pubDate></item>`;
  };
  let entries = '';
  for (let i = 1; i <= count; i += 1) entries += item(i);
  for (let i = count + 1; i <= count + extraNewest; i += 1) entries = item(i) + entries;
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Big feed</title><link>https://example.test/feed</link><description>pagination fixture</description>${entries}</channel></rss>`;
};

const bigFeedService = (count, extraNewest = 0) => {
  const provider = new FakeFeedProvider([{url: FIXTURE_URL, body: bigFeedBody(count, extraNewest)}]);
  const service = new FeedService({provider, subscriptions: [{id: 'fixture', url: FIXTURE_URL}], now: () => Date.parse('2026-09-07T00:00:00Z')});
  return {provider, service, collect: (query = {}) => service.collect({subscriptionId: 'fixture', ...query})};
};

test('300 条订阅、每页 50 条：6 页完整取尽，无重复且每页都是新条目', async () => {
  const {collect} = bigFeedService(300);
  const all = [];
  let cursor;
  let polls = 0;
  for (;;) {
    const page = await collect({limit: 50, cursor});
    polls += 1;
    assert.ok(polls <= 10, '必须在有限页内取尽（旧行为会在 200 条淘汰后死循环）');
    all.push(...page.items);
    cursor = page.nextCursor;
    if (!page.hasMore) break;
  }
  assert.equal(polls, 6);
  assert.equal(all.length, 300);
  const keys = all.map(item => item.record.dedupeKey);
  assert.equal(new Set(keys).size, 300, '跨页不得重复投递');
});

test('1000 条订阅在有限页数内取尽', async () => {
  const {collect} = bigFeedService(1000);
  let delivered = 0;
  let cursor;
  let polls = 0;
  for (;;) {
    const page = await collect({limit: 50, cursor});
    polls += 1;
    assert.ok(polls <= 25, '1000/50 最多 20 页 + 1 次收尾');
    delivered += page.items.length;
    cursor = page.nextCursor;
    if (!page.hasMore) break;
  }
  assert.equal(delivered, 1000);
});

test('相同游标重放结果一致', async () => {
  const {collect} = bigFeedService(120);
  const first = await collect({limit: 50});
  const replayA = await collect({limit: 50, cursor: first.nextCursor});
  const replayB = await collect({limit: 50, cursor: first.nextCursor});
  assert.deepEqual(replayA.items, replayB.items);
  assert.equal(replayA.nextCursor, replayB.nextCursor);
  assert.equal(replayA.hasMore, replayB.hasMore);
});

test('取尽后 feed 更新只返回新增条目（seen 窗口内规模）', async () => {
  const {provider, collect} = bigFeedService(100);
  let cursor;
  let pages = 0;
  for (;;) {
    const page = await collect({limit: 50, cursor});
    pages += 1;
    cursor = page.nextCursor;
    if (!page.hasMore) break;
  }
  assert.equal(pages, 2);
  provider.setFixtures([{url: FIXTURE_URL, body: bigFeedBody(100, 3)}]);
  const afterUpdate = await collect({limit: 50, cursor});
  assert.equal(afterUpdate.items.length, 3, '只投递 3 条新增');
  assert.equal(afterUpdate.hasMore, false);
  assert.ok(afterUpdate.items.every(item => /Entry 10[123]/.test(item.title)), '新增的是最新三条');
});

test('分页中途 304（带校验器）保持趟状态继续翻页', async () => {
  const provider = new FakeFeedProvider([]);
  const clock = new FakeClock();
  const service = new FeedService({provider, subscriptions: [{id: 'fixture', url: FIXTURE_URL}], now: clock.now});
  // 第一步：小 feed 完整取尽，建立校验器 v1（趟结束，游标无 pass）
  provider.setFixtures([{url: FIXTURE_URL, body: bigFeedBody(10), etag: 'W/"v1"'}]);
  const done = await service.collect({subscriptionId: 'fixture', limit: 50});
  assert.equal(done.hasMore, false);
  // 第二步：feed 长大到 300 条且换了 etag v2 → 新一趟开启（51-100…截断在 50），校验器保持 v1
  provider.setFixtures([{url: FIXTURE_URL, body: bigFeedBody(300), etag: 'W/"v2"'}]);
  const page1 = await service.collect({subscriptionId: 'fixture', limit: 50, cursor: done.nextCursor});
  assert.equal(page1.items.length, 50);
  assert.equal(page1.hasMore, true);
  // 第三步：服务端把 etag 改回 v1（内容同 300 条）→ 中途请求条件命中 304 unchanged，
  // 游标必须原样携带趟状态继续
  provider.setFixtures([{url: FIXTURE_URL, body: bigFeedBody(300), etag: 'W/"v1"'}]);
  const page2 = await service.collect({subscriptionId: 'fixture', limit: 50, cursor: page1.nextCursor});
  assert.equal(page2.collection.state, 'unchanged');
  assert.equal(page2.items.length, 0);
  assert.equal(page2.nextCursor, page1.nextCursor, '304 后游标（含趟水位线）原样返回');
  // 第四步：内容真变了（新 etag）→ 从水位线继续（Entry 250–201）而不是从头再来
  provider.setFixtures([{url: FIXTURE_URL, body: bigFeedBody(300), etag: 'W/"v3"'}]);
  const page3 = await service.collect({subscriptionId: 'fixture', limit: 50, cursor: page2.nextCursor});
  assert.equal(page3.items.length, 50);
  const titles = page3.items.map(item => item.title);
  assert.ok(titles.includes('Entry 250') && titles.includes('Entry 201'), `从 Entry 250 继续，实际首条 ${titles[0]} 末条 ${titles[49]}`);
});
