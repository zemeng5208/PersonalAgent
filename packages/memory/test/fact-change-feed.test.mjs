import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseFactChangeBatch} from '../dist/index.js';
import {FakeMemoryHost} from '../dist/testing.js';

const deadline = () => new Date(Date.now() + 10_000).toISOString();
const context = () => ({deadline: deadline(), signal: new AbortController().signal});
const read = (overrides = {}) => ({limit: 100, ...context(), ...overrides});
const fact = (id, revision = 1, overrides = {}) => ({
  ref: {id, revision},
  summary: `${id} v${revision}`,
  sourceRef: `fixture/${id}`,
  observedAt: `2026-09-12T0${revision}:00:00.000Z`,
  validFrom: '2026-09-12T00:00:00.000Z',
  validUntil: '2026-09-14T00:00:00.000Z',
  sensitivity: 'public',
  state: 'active',
  confirmation: 'external_observation',
  ...(revision === 1 ? {} : {corrects: {id, revision: revision - 1}}),
  ...overrides,
});
const confirmation = (batch, overrides = {}) => ({
  batchToken: batch.batchToken,
  expectedCheckpoint: batch.baseCheckpoint,
  handled: structuredClone(batch.entries),
  ...context(),
  ...overrides,
});
const refs = batch => batch.entries.map(entry => `${entry.fact.id}@${entry.fact.revision}`);

test('bootstrap fixes latest heads at its first watermark and later appends enter changes without loss', async () => {
  const host = new FakeMemoryHost();
  host.provision('person');
  host.append('person', fact('future', 1, {
    validFrom: '2030-01-01T00:00:00.000Z', validUntil: '2031-01-01T00:00:00.000Z',
  }));
  host.append('person', fact('withdrawn'));
  host.append('person', fact('withdrawn', 2, {state: 'withdrawn'}));
  const feed = host.bindFeed('person', {consumerId: 'graph', allowedSensitivities: ['public']});

  const bootstrap = await feed.read(read({limit: 1}));
  assert.equal(bootstrap.mode, 'bootstrap');
  assert.equal(bootstrap.atWatermark, false);
  assert.deepEqual(refs(bootstrap), ['future@1']);
  assert.deepEqual(parseFactChangeBatch(bootstrap), bootstrap);
  assert.deepEqual(Object.keys(bootstrap).sort(),
    ['atWatermark', 'baseCheckpoint', 'batchToken', 'entries', 'mode', 'watermark']);
  assert.equal(JSON.stringify(bootstrap).includes('sequence'), false);
  assert.match(bootstrap.batchToken, /^memory-feed-batch-[0-9a-f-]{36}$/);
  assert.match(bootstrap.baseCheckpoint, /^memory-feed-checkpoint-[0-9a-f-]{36}$/);
  assert.match(bootstrap.watermark, /^memory-feed-watermark-[0-9a-f-]{36}$/);

  host.append('person', fact('after-watermark'));
  assert.deepEqual(await feed.read(read({limit: 100})), bootstrap,
    'an unconfirmed delivery must be repeated exactly despite a new limit');
  host.confirmFeedBatch('person', 'graph', confirmation(bootstrap));
  const bootstrapTail = await feed.read(read());
  assert.equal(bootstrapTail.mode, 'bootstrap');
  assert.equal(bootstrapTail.atWatermark, true);
  assert.equal(bootstrapTail.watermark, bootstrap.watermark);
  assert.deepEqual(refs(bootstrapTail), ['withdrawn@2']);
  host.confirmFeedBatch('person', 'graph', confirmation(bootstrapTail));
  const changes = await feed.read(read());
  assert.equal(changes.mode, 'changes');
  assert.deepEqual(refs(changes), ['after-watermark@1']);
});

test('empty bootstrap and changes pages require confirmation and confirmation is idempotent', async () => {
  const host = new FakeMemoryHost();
  host.provision('person');
  const feed = host.bindFeed('person', {consumerId: 'graph', allowedSensitivities: ['public']});
  const bootstrap = await feed.read(read({limit: 1}));
  assert.deepEqual(bootstrap.entries, []);
  assert.equal(bootstrap.atWatermark, true);
  assert.deepEqual(await feed.read(read({limit: 100})), bootstrap);

  let lengthReads = 0;
  const forgedHandled = new Proxy([{eventId: 'forged', fact: {id: 'forged', revision: 1}}], {
    get(target, property, receiver) {
      if (property === 'length') return ++lengthReads <= 3 ? 1 : 0;
      return Reflect.get(target, property, receiver);
    },
  });
  assert.throws(() => host.confirmFeedBatch('person', 'graph', confirmation(bootstrap, {
    handled: forgedHandled,
  })), {code: 'INVALID_ARGUMENT'});
  assert.equal(lengthReads, 0, 'array values are copied from own data descriptors without invoking length traps');

  const request = confirmation(bootstrap);
  const firstReceipt = host.confirmFeedBatch('person', 'graph', request);
  assert.deepEqual(host.confirmFeedBatch('person', 'graph', request), firstReceipt);
  const emptyChanges = await feed.read(read());
  assert.equal(emptyChanges.mode, 'changes');
  assert.deepEqual(emptyChanges.entries, []);
  assert.equal(emptyChanges.atWatermark, true);
  host.confirmFeedBatch('person', 'graph', confirmation(emptyChanges));
});

test('namespace, consumer and scope bindings isolate deliveries and scope changes rebuild old readers', async () => {
  const host = new FakeMemoryHost();
  host.provision('person');
  host.provision('other');
  host.append('person', fact('public'));
  host.append('person', fact('private', 1, {sensitivity: 'private'}));
  host.append('other', fact('foreign'));
  const publicFeed = host.bindFeed('person', {consumerId: 'projection-a', allowedSensitivities: ['public']});
  const privateFeed = host.bindFeed('person', {consumerId: 'projection-b', allowedSensitivities: ['private']});
  const publicBatch = await publicFeed.read(read());
  const privateBatch = await privateFeed.read(read());
  assert.deepEqual(refs(publicBatch), ['public@1']);
  assert.deepEqual(refs(privateBatch), ['private@1']);
  assert.throws(() => host.confirmFeedBatch('person', 'projection-b', confirmation(publicBatch)),
    {code: 'SCOPE_DENIED'});
  assert.deepEqual(await publicFeed.read(read()), publicBatch, 'cross-consumer confirmation cannot advance');

  const reused = host.bindFeed('person', {consumerId: 'projection-a', allowedSensitivities: ['public']});
  assert.deepEqual(await reused.read(read({limit: 1})), publicBatch);
  const rebuilt = host.bindFeed('person', {consumerId: 'projection-a', allowedSensitivities: ['private']});
  await assert.rejects(publicFeed.read(read()), {code: 'REBUILD_REQUIRED'});
  assert.throws(() => host.confirmFeedBatch('person', 'projection-a', confirmation(publicBatch)),
    {code: 'REBUILD_REQUIRED'});
  assert.deepEqual(refs(await rebuilt.read(read())), ['private@1']);
  assert.deepEqual(await privateFeed.read(read({limit: 1})), privateBatch,
    'another consumer keeps its own unconfirmed delivery');
  assert.throws(() => host.bindFeed('missing', {consumerId: 'projection', allowedSensitivities: ['public']}),
    {code: 'SCOPE_DENIED'});
});

test('visible heads becoming invisible invalidate the view while never-visible appends do not', async () => {
  const host = new FakeMemoryHost();
  host.provision('person');
  host.append('person', fact('meeting'));
  const feed = host.bindFeed('person', {consumerId: 'graph', allowedSensitivities: ['public']});
  const bootstrap = await feed.read(read());
  const bootstrapRequest = confirmation(bootstrap);
  host.confirmFeedBatch('person', 'graph', bootstrapRequest);

  host.append('person', fact('meeting', 2, {sensitivity: 'restricted'}));
  await assert.rejects(feed.read(read()), {code: 'REBUILD_REQUIRED'});
  assert.throws(() => host.confirmFeedBatch('person', 'graph', bootstrapRequest),
    {code: 'REBUILD_REQUIRED'}, 'binding validity is checked before an idempotent receipt');
  const rebuilt = host.bindFeed('person', {consumerId: 'graph', allowedSensitivities: ['public']});
  assert.deepEqual((await rebuilt.read(read())).entries, [], 'an older visible head is not revived');

  host.provision('hidden-only');
  const hiddenFeed = host.bindFeed('hidden-only', {consumerId: 'graph', allowedSensitivities: ['public']});
  const emptyBootstrap = await hiddenFeed.read(read());
  host.confirmFeedBatch('hidden-only', 'graph', confirmation(emptyBootstrap));
  host.append('hidden-only', fact('secret', 1, {sensitivity: 'restricted'}));
  const hiddenChanges = await hiddenFeed.read(read());
  assert.deepEqual(hiddenChanges.entries, []);
  assert.equal(hiddenChanges.atWatermark, true);
});

test('partial, unread, changed and stale confirmations never advance a delivery', async () => {
  const host = new FakeMemoryHost();
  host.provision('person');
  host.append('person', fact('a'));
  host.append('person', fact('b'));
  const feed = host.bindFeed('person', {consumerId: 'graph', allowedSensitivities: ['public']});
  const batch = await feed.read(read());

  assert.throws(() => host.confirmFeedBatch('person', 'graph', confirmation(batch, {handled: [batch.entries[0]]})),
    {code: 'INVALID_ARGUMENT'});
  assert.throws(() => host.confirmFeedBatch('person', 'graph', confirmation(batch, {
    batchToken: 'memory-feed-batch-unread',
  })), {code: 'SCOPE_DENIED'});
  const changed = structuredClone(batch.entries);
  changed[0].fact.revision = 99;
  assert.throws(() => host.confirmFeedBatch('person', 'graph', confirmation(batch, {handled: changed})),
    {code: 'INVALID_ARGUMENT'});
  assert.throws(() => host.confirmFeedBatch('person', 'graph', confirmation(batch, {
    expectedCheckpoint: 'memory-feed-checkpoint-stale',
  })), {code: 'REVISION_CONFLICT'});
  assert.deepEqual(await feed.read(read({limit: 1})), batch, 'failed confirmation must not advance');

  const request = confirmation(batch);
  const receipt = host.confirmFeedBatch('person', 'graph', request);
  assert.deepEqual(host.confirmFeedBatch('person', 'graph', request), receipt);
  assert.throws(() => host.confirmFeedBatch('person', 'graph', {...request,
    expectedCheckpoint: 'memory-feed-checkpoint-changed'}), {code: 'REVISION_CONFLICT'});
  assert.throws(() => host.confirmFeedBatch('person', 'graph', {...request, handled: []}),
    {code: 'INVALID_ARGUMENT'});
});

test('cancelled, expired and structurally invalid reads or confirmations do not mutate state', async () => {
  const host = new FakeMemoryHost();
  host.provision('person');
  host.append('person', fact('meeting'));
  const feed = host.bindFeed('person', {consumerId: 'graph', allowedSensitivities: ['public']});
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(feed.read(read({signal: cancelled.signal})), {code: 'CANCELLED'});
  await assert.rejects(feed.read(read({deadline: '2000-01-01T00:00:00.000Z'})), {code: 'TIMEOUT'});
  await assert.rejects(feed.read(read({limit: 0})), {code: 'INVALID_ARGUMENT'});
  await assert.rejects(feed.read(read({limit: 101})), {code: 'INVALID_ARGUMENT'});
  await assert.rejects(feed.read({...read(), extra: 'private'}), error =>
    error.code === 'INVALID_ARGUMENT' && error.message === 'Invalid fact change request');

  const batch = await feed.read(read());
  assert.throws(() => host.confirmFeedBatch('person', 'graph', confirmation(batch, {
    signal: cancelled.signal,
  })), {code: 'CANCELLED'});
  assert.throws(() => host.confirmFeedBatch('person', 'graph', confirmation(batch, {
    deadline: '2000-01-01T00:00:00.000Z',
  })), {code: 'TIMEOUT'});
  assert.throws(() => host.confirmFeedBatch('person', 'graph', {...confirmation(batch), extra: 'private'}),
    {code: 'INVALID_ARGUMENT'});
  assert.deepEqual(await feed.read(read({limit: 1})), batch);
  host.confirmFeedBatch('person', 'graph', confirmation(batch));
});
