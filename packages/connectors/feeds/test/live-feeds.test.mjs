import assert from 'node:assert/strict';
import {test} from 'node:test';
import {HttpFeedProvider, FeedService, MAX_LIMIT} from '../dist/index.js';
import {validateContract} from '@personal-agent/contracts';

/**
 * Real read-back against two production sources, opt-in via `PA_FEEDS_LIVE=1`.
 *
 * A simulated provider only proves this package's own branches (CONTRIBUTING §91: `模拟测试只验证
 * 程序分支，不能证明第三方平台已连通`). The two sources were chosen because between them they
 * exercise both incremental paths against live servers:
 *
 *   阮一峰的网络日志  Atom, sends ETag and Last-Modified  -> the conditional 304 path
 *   少数派           RSS 2.0, sends neither               -> full fetch filtered by `seen`
 *
 * Skipped by default so CI and offline runs stay deterministic.
 */
const LIVE = process.env.PA_FEEDS_LIVE === '1';
const SKIP_REASON = 'set PA_FEEDS_LIVE=1 to run the real source read-back';

const SOURCES = [
  {id: 'ruanyifeng', url: 'https://www.ruanyifeng.com/blog/atom.xml', title: '阮一峰的网络日志'},
  {id: 'sspai', url: 'https://sspai.com/feed', title: '少数派'},
];

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

/** Wraps the real global fetch only to record the status line, which is the evidence a 304 happened. */
const recordingFetch = () => {
  const requests = [];
  const impl = async (url, init) => {
    const response = await fetch(url, init);
    requests.push({
      url,
      status: response.status,
      sentIfNoneMatch: init.headers['if-none-match'] ?? null,
      sentIfModifiedSince: init.headers['if-modified-since'] ?? null,
      etag: response.headers.get('etag'),
      lastModified: response.headers.get('last-modified'),
    });
    return response;
  };
  impl.requests = requests;
  return impl;
};

const makeService = (impl) => new FeedService({
  provider: new HttpFeedProvider({fetchImpl: impl}),
  subscriptions: SOURCES,
  now: Date.now,
});

test('live read-back: two polls per source, proving both incremental paths', {skip: LIVE ? false : SKIP_REASON}, async () => {
  const impl = recordingFetch();
  const service = makeService(impl);
  const evidence = {};

  for (const source of SOURCES) {
    const first = await service.collect({subscriptionId: source.id, limit: MAX_LIMIT}, AbortSignal.timeout(30_000));
    const second = await service.collect(
      {subscriptionId: source.id, limit: MAX_LIMIT, cursor: first.nextCursor},
      AbortSignal.timeout(30_000),
    );
    evidence[source.id] = {first, second};

    // ---- first poll: a real document, parsed into contract-valid records
    assert.equal(first.collection.state, 'fetched', `${source.id}: the first poll has no validators to send`);
    assert.equal(first.collection.conditional, false);
    assert.ok(first.items.length > 0, `${source.id}: the live source returned no items`);
    assert.equal(first.collection.parsedItemCount >= first.items.length, true);
    assert.match(first.collection.fetchedAt, TIMESTAMP);

    for (const item of first.items) {
      validateContract('connectorItem', item.record);
      assert.equal(item.record.source, 'http-feeds');
      assert.equal(item.record.accountRef, source.id);
      assert.equal(item.record.sensitivity, 'public');
      assert.match(item.record.occurredAt, TIMESTAMP);
      assert.match(item.record.fetchedAt, TIMESTAMP);
      assert.ok(item.record.dedupeKey.startsWith(`http-feeds:${source.id}:`));
      assert.ok(['item_published', 'item_updated', 'feed_build'].includes(item.occurredAtKind));
      assert.ok(['item_guid', 'item_link', 'content_hash'].includes(item.dedupeKeyKind));
      // `validFor` is deliberately absent: a feed entry states no expiry.
      assert.equal('validFor' in item.record, false);
      assert.ok(item.record.contentRef.length > 0);
    }

    // The feed URL is operator configuration, never output — even for a public source.
    const serialized = JSON.stringify({first, second});
    assert.equal(serialized.includes(source.url), false, `${source.id}: the subscription URL leaked into the output`);

    // ---- second poll: the cursor really is what makes it incremental
    assert.equal(second.collection.subscriptionId, source.id);
    assert.match(second.collection.fetchedAt, TIMESTAMP);
    assert.deepEqual(second.items, [], `${source.id}: an immediate re-poll must find nothing new`);
    assert.equal(second.collection.deliveredCount, 0);
    assert.equal(second.hasMore, false);
  }

  // ---- 阮一峰: real conditional request, real 304
  const atom = evidence.ruanyifeng;
  assert.ok(atom.first.collection.validators.etag !== null, 'ruanyifeng is expected to send an ETag');
  assert.ok(atom.first.collection.validators.lastModified !== null, 'ruanyifeng is expected to send Last-Modified');
  assert.equal(atom.second.collection.conditional, true);
  assert.equal(atom.second.collection.state, 'unchanged', 'the second poll must really receive a 304');
  assert.equal(atom.second.collection.parsedItemCount, 0, 'a 304 has no body to parse');
  assert.deepEqual(atom.second.collection.validators, atom.first.collection.validators);
  for (const item of atom.first.items) {
    assert.equal(item.dedupeKeyKind, 'item_guid', 'every Atom entry carries an <id>');
  }

  // ---- 少数派: no validators at all, so the second poll refetches and `seen` filters it to zero
  const rss = evidence.sspai;
  assert.deepEqual(rss.first.collection.validators, {etag: null, lastModified: null});
  assert.equal(rss.second.collection.conditional, false);
  assert.equal(rss.second.collection.state, 'fetched', 'with no validators there is nothing to make conditional');
  assert.ok(rss.second.collection.parsedItemCount > 0, 'the whole document was parsed again');
  assert.equal(rss.second.collection.alreadySeenCount, rss.second.collection.parsedItemCount - rss.second.collection.skipped.length);
  for (const item of rss.first.items) {
    assert.equal(item.dedupeKeyKind, 'item_link', 'no sspai item carries a <guid>, so the link is the identifier');
  }

  // ---- the status lines, which are the actual evidence rather than a claim about them
  const statuses = impl.requests.map(request => ({
    url: new URL(request.url).host,
    status: request.status,
    conditional: request.sentIfNoneMatch !== null || request.sentIfModifiedSince !== null,
  }));
  assert.equal(statuses.length, 4, 'exactly two polls per source, no redirect and no retry');
  assert.deepEqual(statuses.map(entry => entry.status), [200, 304, 200, 200]);
  assert.deepEqual(statuses.map(entry => entry.conditional), [false, true, false, false]);

  console.log('live read-back requests:', JSON.stringify(statuses));
  console.log('live read-back evidence:', JSON.stringify({
    ruanyifeng: {
      validators: atom.first.collection.validators,
      feedKind: atom.first.collection.feedKind,
      feedTitle: atom.first.collection.feedTitle,
      parsed: atom.first.collection.parsedItemCount,
      delivered: atom.first.collection.deliveredCount,
      fetchedAt: atom.first.collection.fetchedAt,
      secondState: atom.second.collection.state,
      etag304: impl.requests[1].etag,
      sample: atom.first.items[0] && {
        externalId: atom.first.items[0].record.externalId,
        dedupeKey: atom.first.items[0].record.dedupeKey,
        dedupeKeyKind: atom.first.items[0].dedupeKeyKind,
        occurredAt: atom.first.items[0].record.occurredAt,
        occurredAtKind: atom.first.items[0].occurredAtKind,
        contentRef: atom.first.items[0].record.contentRef,
        title: atom.first.items[0].title,
      },
    },
    sspai: {
      validators: rss.first.collection.validators,
      feedKind: rss.first.collection.feedKind,
      feedTitle: rss.first.collection.feedTitle,
      parsed: rss.first.collection.parsedItemCount,
      delivered: rss.first.collection.deliveredCount,
      fetchedAt: rss.first.collection.fetchedAt,
      secondState: rss.second.collection.state,
      secondAlreadySeen: rss.second.collection.alreadySeenCount,
      sample: rss.first.items[0] && {
        externalId: rss.first.items[0].record.externalId,
        dedupeKey: rss.first.items[0].record.dedupeKey,
        dedupeKeyKind: rss.first.items[0].dedupeKeyKind,
        occurredAt: rss.first.items[0].record.occurredAt,
        occurredAtKind: rss.first.items[0].occurredAtKind,
        contentRef: rss.first.items[0].record.contentRef,
        summary: rss.first.items[0].summary.slice(0, 80),
      },
    },
  }, null, 2));
});
