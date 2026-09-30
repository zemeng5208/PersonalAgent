import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {createKnowledgeFeedReceipt, parseKnowledgeFeedReceipt,
  verifyKnowledgeFeedReceiptBinding, knowledgeFeedReceiptItems} from '../dist/application/knowledge-feed-receipt.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const items = [
  {dedupeKey: 'a', occurredAt: '2026-09-30T00:00:00Z', contentRef: 'https://example.com/rust',
    title: 'Rust update', summary: 'Rust toolchain release.'},
  {dedupeKey: 'b', occurredAt: '2026-09-30T00:01:00Z', contentRef: 'https://example.com/typescript',
    title: 'TypeScript update', summary: 'TypeScript type inference release.'},
];
const input = {namespace: 'fixture-user', sourceId: 'feed-a', observedAt: '2026-09-30T00:02:00Z',
  revision: 'a'.repeat(64), items};
const binding = receipt => ({namespace: receipt.namespace, sourceId: receipt.sourceId,
  observedAt: receipt.observedAt, revision: receipt.revision, contentSha256: receipt.contentSha256,
  citation: receipt.citation, receiptId: receipt.receiptId, summary: receipt.summary.slice(0, 2000)});
const rehash = raw => { const {receiptId, ...core} = raw; return {...core, receiptId: hash(core)}; };

test('different articles preserve their own locator/content hash and the full page hash', () => {
  const receipt = createKnowledgeFeedReceipt({...input, items: [...items].reverse()});
  assert.equal(receipt.version, 2);
  assert.equal(receipt.contentSha256, hash(items));
  assert.notEqual(receipt.citation, items[0].contentRef);
  assert.match(receipt.citation, /^knowledge-feed-citations:[a-f0-9]{64}$/);
  assert.ok(verifyKnowledgeFeedReceiptBinding(receipt, binding(receipt)));
  const {summary: _summary, ...withoutSummary} = binding(receipt);
  assert.ok(verifyKnowledgeFeedReceiptBinding(receipt, withoutSummary));
  const quotes = knowledgeFeedReceiptItems(receipt);
  assert.deepEqual(quotes.map(item => [item.itemKey, item.citation, item.excerpt]),
    [['a', items[0].contentRef, items[0].summary], ['b', items[1].contentRef, items[1].summary]]);
  assert.equal(quotes[1].contentSha256, hash(items[1]));
  assert.equal(quotes[1].sourceRevision, receipt.revision);
  assert.equal(quotes[1].pageContentSha256, hash(items));
  assert.deepEqual(receipt.summary.split('\n').map(line => JSON.parse(line).citation), items.map(item => item.contentRef));
  const parsed = parseKnowledgeFeedReceipt(receipt);
  parsed.items[0].summary = 'mutated copy';
  assert.equal(receipt.items[0].summary, items[0].summary);
});

test('wrong item mapping, missing locator, forged summary, changed hash and foreign context all fail closed', () => {
  const receipt = createKnowledgeFeedReceipt(input);
  const swapped = structuredClone(receipt);
  swapped.citationItems[1].contentRef = items[0].contentRef;
  assert.equal(parseKnowledgeFeedReceipt(rehash(swapped)), undefined);
  const missing = structuredClone(receipt);
  delete missing.items[1].contentRef;
  assert.equal(parseKnowledgeFeedReceipt(rehash(missing)), undefined);
  const forged = structuredClone(receipt);
  forged.summary = 'TypeScript release reported at https://example.com/rust';
  assert.equal(parseKnowledgeFeedReceipt(rehash(forged)), undefined);
  const hashMismatch = structuredClone(receipt);
  hashMismatch.items[1].summary = 'New content under old hash';
  assert.equal(parseKnowledgeFeedReceipt(rehash(hashMismatch)), undefined);
  assert.equal(verifyKnowledgeFeedReceiptBinding(receipt, {...binding(receipt), sourceId:'feed-b'}), undefined);
  assert.equal(verifyKnowledgeFeedReceiptBinding(receipt, {...binding(receipt), revision:'b'.repeat(64)}), undefined);
  assert.equal(verifyKnowledgeFeedReceiptBinding(receipt, {...binding(receipt), summary:items[1].summary}), undefined);
});

test('legacy single-article receipts recover unchanged while ambiguous v1 pages remain readable but unusable', () => {
  const legacy = sourceItems => {
    const core = {version:1,kind:'feeds.collect',namespace:input.namespace,sourceId:input.sourceId,
      observedAt:input.observedAt,revision:input.revision,contentSha256:hash(sourceItems),
      citation:sourceItems[0].contentRef,summary:sourceItems.flatMap(item => [item.title,item.summary]).join('\n'),items:sourceItems};
    return {...core,receiptId:hash(core)};
  };
  const single = legacy([items[1]]);
  assert.deepEqual(parseKnowledgeFeedReceipt(single), single);
  assert.deepEqual(verifyKnowledgeFeedReceiptBinding(single,binding(single)), single);
  assert.equal(knowledgeFeedReceiptItems(single)[0].citation,items[1].contentRef);
  const page = legacy(items);
  assert.deepEqual(parseKnowledgeFeedReceipt(page),page);
  assert.equal(verifyKnowledgeFeedReceiptBinding(page,binding(page)),undefined);
  assert.equal(knowledgeFeedReceiptItems(page),undefined);
  const restored = parseKnowledgeFeedReceipt(JSON.parse(JSON.stringify(createKnowledgeFeedReceipt(input))));
  assert.ok(verifyKnowledgeFeedReceiptBinding(restored,binding(restored)));
  assert.equal(createKnowledgeFeedReceipt({...input,items:[items[1]]}).citation,items[1].contentRef);
});
