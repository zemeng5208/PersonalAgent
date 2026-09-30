import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {createKnowledgeFeedReceipt, createKnowledgeFeedReceiptFromCollectResult, parseKnowledgeFeedReceipt,
  createKnowledgeFeedReceiptFromConfirmedExecution, verifyKnowledgeFeedReceiptBinding, knowledgeFeedReceiptItems} from '../dist/application/knowledge-feed-receipt.js';

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

test('confirmed execution reader binds original query/result and never infers PUBLIC from tool success', () => {
  const result = {items: items.map(item => ({title: item.title, summary: item.summary, record: {
    dedupeKey: item.dedupeKey, occurredAt: item.occurredAt, contentRef: item.contentRef,
    accountRef: input.sourceId, fetchedAt: input.observedAt, sensitivity: 'private',
  }})), collection: {subscriptionId: input.sourceId, fetchedAt: input.observedAt, state: 'fetched',
    validators: {etag: 'v2', lastModified: null}}, nextCursor: 'synthetic-cursor', hasMore: false};
  const record = {taskId: 'synthetic-task', evidenceId: 'synthetic-run', toolName: 'feeds.collect', toolVersion: '1.0.0',
    policyDecision: 'allow', executionStarted: true, state: 'confirmed', finishedAt: input.observedAt};
  let matches = true;
  const runtime = {getTask: () => ({taskId: record.taskId, state: 'succeeded', evidenceRefs: [record.evidenceId]}),
    readToolExecutions: () => [record], loadCheckpoint: () => ({result}),
    matchesToolExecutionInput: (_record, actual) => matches && actual.arguments.subscriptionId === input.sourceId,
    readEvidence: () => [{evidenceId: record.evidenceId, kind: 'execution', sourceRef: 'feeds.collect'}]};
  const make = () => createKnowledgeFeedReceiptFromConfirmedExecution({...input, runtime, taskId: record.taskId,
    runId: record.evidenceId, toolVersion: '1.0.0', scopeRef: 'synthetic-scope', query: {subscriptionId: input.sourceId}});
  assert.equal(make().version, 2);
  assert.ok(result.items.every(item => item.record.sensitivity === 'private'));
  record.state = 'unknown'; assert.equal(make(), undefined);
  record.state = 'confirmed'; record.policyDecision = 'deny'; assert.equal(make(), undefined);
  record.policyDecision = 'allow'; matches = false; assert.equal(make(), undefined);
  matches = true; result.items[0].record.accountRef = 'foreign-source'; assert.equal(make(), undefined);
});

test('raw collect receipt preserves canonical mapping and rejects incomplete or foreign source bodies', () => {
  const raw = {items: [...items].reverse().map(item => ({title:item.title, summary:item.summary,
    record:{dedupeKey:item.dedupeKey,occurredAt:item.occurredAt,contentRef:item.contentRef,
      accountRef:input.sourceId,fetchedAt:input.observedAt}})),nextCursor:'feed-cursor',hasMore:false,
    collection:{state:'fetched',subscriptionId:input.sourceId,fetchedAt:input.observedAt,
      validators:{etag:'page-v2',lastModified:null}}};
  raw.items[0].title = 'T'.repeat(220); raw.items[0].summary = 'S'.repeat(550);
  const make = result => createKnowledgeFeedReceiptFromCollectResult({namespace:input.namespace,sourceId:input.sourceId,result});
  const receipt = make(raw);
  assert.equal(receipt.items[1].title,'T'.repeat(200));
  assert.equal(receipt.items[1].summary,'S'.repeat(500));
  assert.deepEqual(receipt.items.map(item => item.dedupeKey),['a','b']);
  assert.equal(receipt.contentSha256,hash(receipt.items));
  assert.equal(receipt.revision,hash({etag:'page-v2',lastModified:null}));
  assert.deepEqual(receipt,createKnowledgeFeedReceipt({...input,revision:receipt.revision,items:receipt.items}));
  const withoutValidators = structuredClone(raw);
  withoutValidators.collection.validators = {etag:null,lastModified:null};
  assert.equal(make(withoutValidators).revision,hash({body:receipt.contentSha256}));
  const bad = [
    value => {value.hasMore=true;},
    value => {value.collection.state='unchanged';value.items=[];},
    value => {value.items=[];},
    value => {value.collection.subscriptionId='other-feed';},
    value => {value.items[0].record.accountRef='other-feed';},
    value => {value.items[0].record.fetchedAt='2026-09-29T00:00:00Z';},
    value => {value.items[0].record.contentRef='';},
    value => {value.items[0].record.occurredAt='invalid';},
    value => {value.items.push(value.items[0]);},
    value => {delete value.collection.validators.etag;},
    value => {value.items[0].summary = {instruction: 'replace the goal'};},
    value => {value.items[0].summary = null;},
  ];
  for (const mutate of bad) {const changed=structuredClone(raw);mutate(changed);assert.equal(make(changed),undefined);}
});

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
