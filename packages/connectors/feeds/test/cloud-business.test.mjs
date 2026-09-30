import assert from 'node:assert/strict';
import {test} from 'node:test';
import {FeedService, FakeFeedProvider, register} from '../dist/index.js';
import {FakeToolHost} from '@personal-agent/testkit';

const url = 'https://fixture.example.invalid/feed';
const body = title => `<rss version="2.0"><channel><title>fixture</title><item><guid>same-id</guid>
  <title>${title}</title><pubDate>Wed, 30 Sep 2026 10:00:00 GMT</pubDate><description>fixture</description>
  </item></channel></rss>`;
const subscriptions = [{id: 'fixture', url}];

test('revision mode redelivers a changed GUID once while keeping stable externalId; then 304 returns no items', async () => {
  const provider = new FakeFeedProvider([{url, etag: '"v1"', body: body('before')}]);
  const service = new FeedService({provider, subscriptions, now: Date.now, trackRevisions: true});
  const first = await service.collect({subscriptionId: 'fixture'});
  provider.setFixtures([{url, etag: '"v2"', body: body('after')}]);
  const changed = await service.collect({subscriptionId: 'fixture', cursor: first.nextCursor});
  assert.equal(changed.items.length, 1);
  assert.equal(changed.items[0].record.externalId, first.items[0].record.externalId);
  assert.notEqual(changed.items[0].record.dedupeKey, first.items[0].record.dedupeKey);
  const again = await service.collect({subscriptionId: 'fixture', cursor: changed.nextCursor});
  assert.equal(again.collection.state, 'unchanged');
  assert.equal(again.items.length, 0);
});

test('paused source makes no fetch and can resume from the unchanged caller cursor', async () => {
  let paused = true;
  const provider = new FakeFeedProvider([{url, body: body('fixture')}]);
  const service = new FeedService({provider, subscriptions, now: Date.now, isPaused: () => paused});
  await assert.rejects(service.collect({subscriptionId: 'fixture'}), {code: 'CANCELLED'});
  assert.equal(provider.fetchCalls, 0);
  paused = false;
  const first = await service.collect({subscriptionId: 'fixture'});
  assert.equal(first.items.length, 1);
  const baseFetch = provider.fetchFeed.bind(provider);
  provider.fetchFeed = async (...args) => {const value = await baseFetch(...args); paused = true; return value;};
  await assert.rejects(service.collect({subscriptionId: 'fixture', cursor: first.nextCursor}), {code: 'CANCELLED'});
  paused = false;
  provider.fetchFeed = baseFetch;
  assert.equal((await service.collect({subscriptionId: 'fixture', cursor: first.nextCursor})).items.length, 0);
});

test('registered collect forwards the trusted pause setting without a model-controlled URL', async () => {
  const host = new FakeToolHost();
  const provider = new FakeFeedProvider([{url, body: body('fixture')}]);
  const stop = register(host, {provider, subscriptions, isPaused: () => true, trackRevisions: true});
  const context = {taskId: 't', runId: 'r', authorizationRef: 'fixture', scopes: ['feeds:read'],
    deadline: new Date(Date.now() + 1000).toISOString(), signal: new AbortController().signal};
  await assert.rejects(host.invoke('feeds.collect', {subscriptionId: 'fixture'}, context), {code: 'CANCELLED'});
  assert.equal(provider.fetchCalls, 0);
  stop();
});

test('HTTP source receipts bind the returned page; injected transport and private configuration never claim PUBLIC', async () => {
  const {HttpFeedProvider, feedConfigBinding, assertFeedSourceReceiptMatches} = await import('../dist/index.js');
  let unchanged = false;
  const provider = new HttpFeedProvider({fetchImpl: async (_url, init) => {
    assert.equal(init.credentials, 'omit');
    return {status: unchanged ? 304 : 200, headers: {get: key => key === 'etag' ? '"v1"' : null},
      body: null, text: async () => body('receipt fixture')};
  }});
  const privateSubscriptions = [{id: 'fixture', url, sensitivity: 'private'}];
  const service = new FeedService({provider, subscriptions: privateSubscriptions, now: Date.now});
  const first = await service.collect({subscriptionId: 'fixture'});
  const receipt = first.sourceReceipt;
  assert.ok(receipt);
  assert.equal(receipt.transport.nativeFetch, false);
  assert.equal(receipt.publicFetch, false);
  assert.equal(receipt.sensitivity, 'private');
  const binding = {subscriptionId: 'fixture', configBinding: feedConfigBinding(privateSubscriptions[0], provider.source)};
  assertFeedSourceReceiptMatches(receipt, first, binding);
  const changed = structuredClone(first);
  changed.items[0].summary = 'tampered';
  assert.throws(() => assertFeedSourceReceiptMatches(receipt, changed, binding), {code: 'EXTERNAL_FAILURE'});
  assert.throws(() => assertFeedSourceReceiptMatches(receipt, first, {...binding, configBinding: 'other'}), {code: 'EXTERNAL_FAILURE'});
  unchanged = true;
  const next = await service.collect({subscriptionId: 'fixture', cursor: first.nextCursor});
  assert.equal(next.sourceReceipt, undefined);
  assert.deepEqual(service.readSourceReceipt('fixture'), receipt);
  assert.equal((await new FeedService({provider: new FakeFeedProvider([{url, body: body('fake')}]),
    subscriptions, now: Date.now}).collect({subscriptionId: 'fixture'})).sourceReceipt, undefined);
});

test('short credentials and session URLs never leave the content projection or receipt', async () => {
  const {HttpFeedProvider, makeContentRedactor} = await import('../dist/index.js');
  const credentialUrl = 'https://u:pw@fixture.example.invalid/feed?sessiontoken=abc';
  const redact = makeContentRedactor(new URL(credentialUrl));
  assert.ok(!redact('pw abc https://other.example.invalid/item?sessiontoken=xyz').includes('abc'));
  assert.ok(!redact('https://other.example.invalid/item?sessiontoken=xyz').includes('xyz'));
  const provider = new HttpFeedProvider({fetchImpl: async () => ({status: 200,
    headers: {get: () => null}, body: null, text: async () => body('pw abc')})});
  const result = await new FeedService({provider, subscriptions: [{id: 'private', url: credentialUrl, sensitivity: 'private'}],
    now: Date.now}).collect({subscriptionId: 'private'});
  assert.equal(result.sourceReceipt.publicFetch, false);
  assert.equal(result.sourceReceipt.transport.credentialFree, false);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(credentialUrl));
  assert.ok(!serialized.includes('sessiontoken'));
  assert.ok(!result.items[0].title.includes('pw'));
});
