import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFactForImpact} from '../dist/index.js';
import {FakeMemoryHost} from '../dist/testing.js';

const deadline = () => new Date(Date.now() + 10_000).toISOString();
const signal = () => new AbortController().signal;
const context = () => ({deadline: deadline(), signal: signal()});
const fact = (id, revision = 1, overrides = {}) => ({
  ref: {id, revision},
  summary: `${id} v${revision}`,
  sourceRef: `fixture/${id}`,
  observedAt: `2026-09-12T0${revision}:00:00.000Z`,
  validFrom: '2026-09-12T00:00:00.000Z',
  validUntil: '2026-09-14T00:00:00.000Z',
  sensitivity: 'private',
  state: 'active',
  confirmation: 'external_observation',
  ...(revision === 1 ? {} : {corrects: {id, revision: revision - 1}}),
  ...overrides,
});
const current = (overrides = {}) => ({
  at: '2026-09-13T09:30:00.000Z',
  limit: 100,
  ...context(),
  ...overrides,
});
const history = (factId, overrides = {}) => ({factId, limit: 100, ...context(), ...overrides});

test('bound scopes isolate namespaces and exact FactRef consumption returns copies', async () => {
  const host = new FakeMemoryHost();
  host.provision('person-a');
  host.provision('person-b');
  host.append('person-a', fact('meeting'));
  host.append('person-a', fact('weather', 1, {sensitivity: 'public'}));
  host.append('person-a', fact('restricted-note', 1, {sensitivity: 'restricted'}));
  host.append('person-b', fact('other-person', 1, {sensitivity: 'public'}));
  const memory = host.bind('person-a', {allowedSensitivities: ['private', 'public']});

  const page = await memory.listCurrent(current());
  assert.deepEqual(page.facts.map(item => item.ref.id), ['meeting', 'weather']);
  assert.equal(page.facts.some(item => item.ref.id === 'other-person'), false);
  const consumed = await readFactForImpact(memory, {id: 'meeting', revision: 1}, context());
  assert.equal(consumed.summary, 'meeting v1');
  consumed.summary = 'outside mutation';
  assert.equal((await memory.getVersion({fact: {id: 'meeting', revision: 1}, ...context()})).summary, 'meeting v1');

  const denied = [];
  for (const ref of [{id: 'restricted-note', revision: 1}, {id: 'missing', revision: 1}]) {
    await assert.rejects(memory.getVersion({fact: ref, ...context()}), error => {
      denied.push({code: error.code, message: error.message});
      return error.code === 'SCOPE_DENIED' && !error.message.includes(ref.id);
    });
  }
  assert.deepEqual(denied[0], denied[1]);
  await assert.rejects(readFactForImpact({
    getVersion: async () => fact('different'),
  }, {id: 'meeting', revision: 1}, context()), {code: 'INVALID_ARGUMENT'});
  assert.throws(() => host.bind('not-provisioned', {allowedSensitivities: ['public']}), {code: 'NOT_FOUND'});
});

test('current queries choose the latest version at the fixed watermark without reviving withdrawn or hidden history', async () => {
  const host = new FakeMemoryHost();
  host.provision('a');
  host.append('a', fact('meeting'));
  const memory = host.bind('a', {allowedSensitivities: ['private']});
  const before = await memory.listCurrent(current({limit: 1}));
  assert.deepEqual(before.facts.map(item => item.ref), [{id: 'meeting', revision: 1}]);

  host.append('a', fact('meeting', 2, {summary: 'withdrawn', state: 'withdrawn'}));
  assert.deepEqual((await memory.listCurrent(current())).facts, []);
  assert.deepEqual((await memory.listCurrent(current({snapshot: before.snapshot}))).facts.map(item => item.ref),
    [{id: 'meeting', revision: 1}]);

  host.append('a', fact('meeting', 3, {sensitivity: 'restricted'}));
  assert.deepEqual((await memory.listCurrent(current())).facts, [], 'an older visible fact must not replace a hidden latest version');
});

test('pagination tokens bind the snapshot, filter, namespace, scope and query kind', async () => {
  const host = new FakeMemoryHost();
  for (const namespace of ['a', 'b']) host.provision(namespace);
  for (const id of ['a-fact', 'b-fact', 'c-fact']) host.append('a', fact(id, 1, {sensitivity: 'public'}));
  host.append('b', fact('foreign', 1, {sensitivity: 'public'}));
  const publicA = host.bind('a', {allowedSensitivities: ['public']});
  const privateA = host.bind('a', {allowedSensitivities: ['private', 'public']});
  const publicB = host.bind('b', {allowedSensitivities: ['public']});
  const first = await publicA.listCurrent(current({limit: 1}));
  assert.equal(first.facts[0].ref.id, 'a-fact');
  assert.equal(typeof first.nextCursor, 'string');
  const second = await publicA.listCurrent(current({limit: 1, snapshot: first.snapshot, cursor: first.nextCursor}));
  assert.equal(second.facts[0].ref.id, 'b-fact');

  for (const work of [
    () => publicA.listCurrent(current({limit: 1, sourceRef: 'changed', snapshot: first.snapshot, cursor: first.nextCursor})),
    () => privateA.listCurrent(current({limit: 1, snapshot: first.snapshot, cursor: first.nextCursor})),
    () => publicB.listCurrent(current({limit: 1, snapshot: first.snapshot, cursor: first.nextCursor})),
    () => publicA.listHistory(history('a-fact', {limit: 1, snapshot: first.snapshot, cursor: first.nextCursor})),
    () => publicA.listCurrent(current({limit: 1, snapshot: 'unknown-token'})),
    () => publicA.listCurrent(current({limit: 1, cursor: first.nextCursor})),
  ]) await assert.rejects(work(), {code: 'INVALID_ARGUMENT'});
});

test('history and current pagination never mix versions appended after their watermark', async () => {
  const host = new FakeMemoryHost();
  host.provision('a');
  host.append('a', fact('meeting'));
  host.append('a', fact('meeting', 2));
  host.append('a', fact('unrelated', 1, {sensitivity: 'public'}));
  const memory = host.bind('a', {allowedSensitivities: ['public', 'private']});
  const oldHistory = await memory.listHistory(history('meeting', {limit: 1}));
  const oldCurrent = await memory.listCurrent(current({limit: 1}));
  host.append('a', fact('meeting', 3));
  host.append('a', fact('z-new', 1, {sensitivity: 'public'}));

  const historyTail = await memory.listHistory(history('meeting', {
    limit: 10, snapshot: oldHistory.snapshot, cursor: oldHistory.nextCursor,
  }));
  assert.deepEqual([...oldHistory.facts, ...historyTail.facts].map(item => item.ref.revision), [1, 2]);
  assert.deepEqual((await memory.listHistory(history('meeting'))).facts.map(item => item.ref.revision), [1, 2, 3]);

  const currentTail = await memory.listCurrent(current({
    limit: 10, snapshot: oldCurrent.snapshot, cursor: oldCurrent.nextCursor,
  }));
  assert.deepEqual([...oldCurrent.facts, ...currentTail.facts].map(item => item.ref.id), ['meeting', 'unrelated']);
  assert.deepEqual((await memory.listCurrent(current())).facts.map(item => `${item.ref.id}@${item.ref.revision}`),
    ['meeting@3', 'unrelated@1', 'z-new@1']);
});

test('facts and requests require exact fields, bounded text, canonical UTC and explicit scope', async () => {
  const host = new FakeMemoryHost();
  host.provision('a');
  for (const invalid of [
    {...fact('x'), privateBody: 'forbidden'},
    {...fact('x'), summary: 'x'.repeat(4097)},
    {...fact('x'), observedAt: '2026-09-12T01:00:00Z'},
    {...fact('x'), validUntil: '2026-09-11T00:00:00.000Z'},
    fact('x', 1, {state: 'withdrawn'}),
    {...fact('x'), confirmation: 'trusted_by_model'},
  ]) assert.throws(() => host.append('a', invalid), {code: 'INVALID_ARGUMENT'});
  assert.throws(() => host.bind('a', {allowedSensitivities: []}), {code: 'INVALID_ARGUMENT'});
  assert.throws(() => host.bind('a', {allowedSensitivities: ['private', 'private']}), {code: 'INVALID_ARGUMENT'});
  assert.throws(() => host.bind('a', {allowedSensitivities: ['private'], implicitLevel: 'restricted'}), {code: 'INVALID_ARGUMENT'});

  host.append('a', fact('meeting'));
  const memory = host.bind('a', {allowedSensitivities: ['private']});
  for (const input of [
    current({limit: 0}),
    current({at: '2026-09-13T09:30:00Z'}),
    current({privateInput: 'forbidden'}),
  ]) await assert.rejects(memory.listCurrent(input), {code: 'INVALID_ARGUMENT'});

  const hostileRequest = {...current()};
  Object.defineProperty(hostileRequest, 'at', {
    enumerable: true,
    get() { throw new Error('secret getter detail'); },
  });
  await assert.rejects(memory.listCurrent(hostileRequest), error =>
    error.code === 'INVALID_ARGUMENT' && error.message === 'Invalid memory query');
  assert.throws(() => host.bind('a', new Proxy({}, {
    ownKeys() { throw new Error('secret proxy detail'); },
  })), error => error.code === 'INVALID_ARGUMENT' && error.message === 'Invalid memory query');
});

test('expired or cancelled queries fail without returning a partial page', async () => {
  const host = new FakeMemoryHost();
  host.provision('a');
  host.append('a', fact('meeting'));
  const memory = host.bind('a', {allowedSensitivities: ['private']});
  await assert.rejects(memory.listCurrent(current({deadline: '2000-01-01T00:00:00.000Z'})), {code: 'TIMEOUT'});
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(memory.listHistory(history('meeting', {signal: controller.signal})), {code: 'CANCELLED'});
});
