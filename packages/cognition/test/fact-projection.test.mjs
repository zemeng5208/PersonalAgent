import assert from 'node:assert/strict';
import {test} from 'node:test';
import {appendVersion, createGraph} from '@personal-agent/goals';
import {FakeMemoryHost} from '@personal-agent/memory/testing';
import {previewFactProjection} from '../dist/index.js';

const at = '2026-09-17T12:00:00.000Z';
const context = signal => ({
  deadline: new Date(Date.now() + 10_000).toISOString(),
  signal: signal ?? new AbortController().signal,
});
const fact = (id, revision = 1, overrides = {}) => ({
  ref: {id, revision},
  summary: `${id} v${revision}`,
  sourceRef: `fixture/${id}`,
  observedAt: `2026-09-17T0${revision}:00:00.000Z`,
  validFrom: '2026-09-17T00:00:00.000Z',
  validUntil: '2026-09-18T00:00:00.000Z',
  sensitivity: 'private',
  state: 'active',
  confirmation: 'user_confirmed',
  ...(revision === 1 ? {} : {corrects: {id, revision: revision - 1}}),
  ...overrides,
});
const projected = value => ({
  id: value.ref.id,
  kind: 'fact',
  summary: value.summary,
  sourceRef: value.sourceRef,
  validFrom: value.validFrom,
  validUntil: value.validUntil,
  sensitivity: value.sensitivity,
  state: value.state,
  reason: 'fact projection',
  dependencies: [],
});
const node = (id, kind = 'goal', dependencies = []) => ({
  id, kind, dependencies, summary: id, sourceRef: `fixture/${id}`,
  validFrom: '2026-09-17T00:00:00.000Z', validUntil: '2026-09-18T00:00:00.000Z',
  sensitivity: 'private', state: 'active', reason: 'fixture',
});
const add = (graph, input) => appendVersion(graph, graph.revision, input);
const batch = entries => ({mode: 'changes', batchToken: 'batch', baseCheckpoint: 'checkpoint',
  watermark: 'watermark', entries: entries.map((ref, index) => ({eventId: `event-${index}`, fact: ref})),
  atWatermark: true});
const item = (report, id) => report.items.find(entry => entry.node.id === id);

function hostWith(...facts) {
  const host = new FakeMemoryHost();
  host.provision('person');
  for (const value of facts) host.append('person', value);
  return {host, memory: host.bind('person', {allowedSensitivities: ['public', 'private']})};
}

function dependentGraph(initial) {
  let graph = add(createGraph('person'), projected(initial));
  graph = add(graph, node('goal', 'goal', [{id: initial.ref.id, revision: 1}]));
  graph = add(graph, node('decision', 'decision', [{id: 'goal', revision: 1}]));
  graph = add(graph, node('plan', 'plan', [{id: 'decision', revision: 1}]));
  graph = add(graph, node('unrelated', 'plan'));
  return graph;
}

test('continuous correction previews a copied graph and only rechecks exact dependents', async () => {
  const first = fact('meeting'), second = fact('meeting', 2, {summary: 'meeting moved'});
  const {memory} = hostWith(first, second);
  const graph = dependentGraph(first), before = structuredClone(graph);
  const result = await previewFactProjection(graph, batch([second.ref]), memory, context(), at);
  assert.deepEqual(graph, before);
  assert.equal(result.snapshot.revision, graph.revision + 1);
  assert.deepEqual(result.snapshot.history.at(-1), {...projected(second), revision: 2, graphRevision: 6});
  for (const id of ['goal', 'decision', 'plan']) assert.equal(item(result.report, id).action, 'RECHECK');
  assert.equal(item(result.report, 'unrelated').action, 'KEEP');
});

test('an exact repeated version is a no-op but shared-field drift is a fixed integrity error', async () => {
  const stored = fact('meeting');
  const graph = add(createGraph('person'), projected(stored));
  const {memory} = hostWith(stored);
  const repeated = await previewFactProjection(graph, batch([stored.ref]), memory, context(), at);
  assert.deepEqual(repeated.snapshot, graph);

  const {memory: changed} = hostWith({...stored, summary: 'conflicting summary'});
  await assert.rejects(previewFactProjection(graph, batch([stored.ref]), changed, context(), at),
    {name: 'FactProjectionError', code: 'INTEGRITY_ERROR', message: 'Fact projection integrity mismatch'});

  const badCorrection = fact('meeting', 2, {corrects: {id: 'other', revision: 1}});
  const malformed = {getVersion: async () => structuredClone(badCorrection)};
  await assert.rejects(previewFactProjection(graph, batch([badCorrection.ref]), malformed, context(), at),
    {name: 'FactProjectionError', code: 'INTEGRITY_ERROR', message: 'Fact projection integrity mismatch'});
  assert.equal(graph.history[0].summary, stored.summary);
});

test('a first head above revision one or a later gap requires an explicit rebuild', async () => {
  const first = fact('meeting'), second = fact('meeting', 2), third = fact('meeting', 3);
  const {memory} = hostWith(first, second, third);
  await assert.rejects(previewFactProjection(createGraph('person'), batch([second.ref]), memory, context(), at),
    {code: 'REBUILD_REQUIRED'});
  const graph = add(createGraph('person'), projected(first));
  await assert.rejects(previewFactProjection(graph, batch([third.ref]), memory, context(), at),
    {code: 'REBUILD_REQUIRED'});
  assert.equal(graph.revision, 1);
});

test('a repeated withdrawn projection propagates withdrawal without rebinding dependencies', async () => {
  const first = fact('meeting');
  const withdrawn = fact('meeting', 2, {state: 'withdrawn'});
  const {memory} = hostWith(first, withdrawn);
  let graph = add(createGraph('person'), projected(first));
  graph = add(graph, projected(withdrawn));
  graph = add(graph, node('goal', 'goal', [{id: 'meeting', revision: 2}]));
  const result = await previewFactProjection(graph, batch([withdrawn.ref]), memory, context(), at);
  assert.deepEqual(result.snapshot, graph);
  assert.equal(item(result.report, 'goal').action, 'RECHECK');
  assert.equal(item(result.report, 'goal').causes[0].reason, 'withdrawn');
});

test('scope denial rejects the whole batch without exposing a partial candidate', async () => {
  const first = fact('meeting'), second = fact('meeting', 2);
  const secret = fact('secret', 1, {sensitivity: 'restricted'});
  const host = new FakeMemoryHost();
  host.provision('person');
  for (const value of [first, second, secret]) host.append('person', value);
  const memory = host.bind('person', {allowedSensitivities: ['private']});
  const graph = add(createGraph('person'), projected(first));
  const before = structuredClone(graph);
  await assert.rejects(previewFactProjection(graph, batch([second.ref, secret.ref]), memory, context(), at),
    {code: 'SCOPE_DENIED'});
  assert.deepEqual(graph, before);
});

test('cancellation during reads rejects the whole preview without reading or returning a partial graph', async () => {
  const first = fact('first'), second = fact('second');
  const controller = new AbortController();
  let reads = 0;
  const memory = {
    async getVersion({fact: ref}) {
      reads++;
      controller.abort();
      return structuredClone(ref.id === first.ref.id ? first : second);
    },
  };
  const graph = createGraph('person'), before = structuredClone(graph);
  await assert.rejects(previewFactProjection(graph, batch([first.ref, second.ref]), memory,
    context(controller.signal), at), {code: 'CANCELLED'});
  assert.equal(reads, 1);
  assert.deepEqual(graph, before);
});

test('an abort gate releases a never-settling read and removes its listener', async () => {
  const controller = new AbortController();
  let added = 0, removed = 0;
  const signal = {
    get aborted() { return controller.signal.aborted; },
    addEventListener(...args) { added++; return controller.signal.addEventListener(...args); },
    removeEventListener(...args) { removed++; return controller.signal.removeEventListener(...args); },
  };
  const memory = {getVersion: async () => new Promise(() => {})};
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(previewFactProjection(createGraph('person'), batch([fact('meeting').ref]), memory,
    context(signal), at), {code: 'CANCELLED'});
  assert.equal(added, 1);
  assert.equal(removed, 1);
});

test('an immediate abort before the provider microtask starts performs no underlying read', async () => {
  const controller = new AbortController();
  let reads = 0;
  const memory = {getVersion: async () => { reads++; return fact('meeting'); }};
  const pending = previewFactProjection(createGraph('person'), batch([fact('meeting').ref]), memory,
    context(controller.signal), at);
  controller.abort();
  await assert.rejects(pending, {code: 'CANCELLED'});
  assert.equal(reads, 0);
});

test('missing or hostile Memory metadata fails with one fixed projection error', async () => {
  const reference = fact('meeting').ref;
  const values = [];
  const missing = fact('meeting');
  delete missing.observedAt;
  values.push(missing, fact('meeting', 1, {confirmation: 'trusted_by_model'}));
  let reads = 0;
  const hostile = fact('meeting');
  Object.defineProperty(hostile, 'observedAt', {enumerable: true, get() { reads++; throw Error('private metadata'); }});
  values.push(hostile);
  for (const value of values) {
    const memory = {getVersion: async () => value};
    await assert.rejects(previewFactProjection(createGraph('person'), batch([reference]), memory, context(), at),
      {name: 'FactProjectionError', code: 'INTEGRITY_ERROR', message: 'Fact projection integrity mismatch'});
  }
  assert.equal(reads, 0);
});
