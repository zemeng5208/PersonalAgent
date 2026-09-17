import assert from 'node:assert/strict';
import {test} from 'node:test';
import {appendVersion, createGraph} from '@personal-agent/goals';
import {FakeCoordinationStoreHost} from '@personal-agent/goals/store';
import {commitFactProjection} from '../dist/index.js';

const at = '2026-09-12T09:00:00.000Z';
const node = (id, kind = 'fact', dependencies = [], overrides = {}) => ({
  id,
  kind,
  dependencies,
  summary: id,
  sourceRef: 'synthetic/fact-projection',
  sensitivity: 'private',
  state: 'active',
  reason: 'fixture',
  validFrom: '2026-09-12T00:00:00.000Z',
  validUntil: '2026-09-13T00:00:00.000Z',
  ...overrides,
});

function fixture(namespace = 'person-a') {
  const host = new FakeCoordinationStoreHost();
  const store = host.provision(namespace);
  for (const input of [
    node('meeting'),
    node('goal', 'goal', [{id: 'meeting', revision: 1}]),
    node('plan', 'plan', [{id: 'goal', revision: 1}]),
  ]) store.append(store.read().revision, input);
  return {host, store};
}

function project(snapshot, ...ids) {
  return ids.reduce((candidate, id) => appendVersion(candidate, candidate.revision,
    node(id, 'fact', [], {reason: 'fact projection'})), snapshot);
}

test('commits multiple projected facts in one batch and preserves the exact graph prefix', () => {
  const {store} = fixture();
  const baseline = store.read();
  const projected = project(baseline, 'attendance', 'departure');
  let appendCalls = 0;
  let capturedExpected;
  let capturedInputs;
  const atomic = {
    read: (...args) => store.read(...args),
    append: (...args) => store.append(...args),
    appendBatch(expectedRevision, inputs) {
      appendCalls += 1;
      capturedExpected = expectedRevision;
      capturedInputs = structuredClone(inputs);
      return store.appendBatch(expectedRevision, inputs);
    },
  };

  const result = commitFactProjection(atomic, baseline, projected, at);

  assert.equal(appendCalls, 1);
  assert.equal(capturedExpected, baseline.revision);
  assert.equal(capturedInputs.length, 2);
  assert.ok(capturedInputs.every(input => input.kind === 'fact'
    && input.reason === 'fact projection' && input.dependencies.length === 0));
  assert.ok(capturedInputs.every(input => !Object.hasOwn(input, 'revision')
    && !Object.hasOwn(input, 'graphRevision')));
  assert.deepEqual(result.snapshot, projected);
  assert.deepEqual(store.read(), projected);
  assert.deepEqual(result.snapshot.history.slice(0, baseline.history.length), baseline.history);
  assert.deepEqual(
    result.snapshot.history.filter(item => item.kind === 'goal' || item.kind === 'plan'),
    baseline.history.filter(item => item.kind === 'goal' || item.kind === 'plan'),
  );
  assert.equal(result.report.graphRevision, projected.revision);
});

test('rejects read-time drift and a commit-time race without retry or partial projection writes', () => {
  {
    const {store} = fixture('read-race');
    const baseline = store.read();
    const projected = project(baseline, 'projected-after-stale-read');
    store.append(baseline.revision, node('read-winner'));
    let appendCalls = 0;
    const stale = {
      read: (...args) => store.read(...args),
      append: (...args) => store.append(...args),
      appendBatch(...args) {
        appendCalls += 1;
        return store.appendBatch(...args);
      },
    };

    assert.throws(() => commitFactProjection(stale, baseline, projected, at),
      {code: 'REVISION_CONFLICT'});
    assert.equal(appendCalls, 0);
    assert.deepEqual(store.read().history.map(item => item.id),
      [...baseline.history.map(item => item.id), 'read-winner']);
  }

  {
    const {store} = fixture('append-race');
    const baseline = store.read();
    const projected = project(baseline, 'first-projection', 'second-projection');
    let appendCalls = 0;
    const racing = {
      read: (...args) => store.read(...args),
      append: (...args) => store.append(...args),
      appendBatch(expectedRevision, inputs) {
        appendCalls += 1;
        store.append(expectedRevision, node('append-winner'));
        return store.appendBatch(expectedRevision, inputs);
      },
    };

    assert.throws(() => commitFactProjection(racing, baseline, projected, at),
      {code: 'REVISION_CONFLICT'});
    assert.equal(appendCalls, 1, 'the failed atomic batch must not be retried');
    assert.equal(store.read().revision, baseline.revision + 1);
    assert.deepEqual(store.read().history.map(item => item.id),
      [...baseline.history.map(item => item.id), 'append-winner']);
    assert.equal(store.read().history.some(item => item.id === 'first-projection'
      || item.id === 'second-projection'), false);
  }
});

test('rejects forged candidates while an empty projection is a copy-only no-op', () => {
  const {store} = fixture();
  const baseline = store.read();
  const valid = project(baseline, 'valid-projection');
  const tamperedPrefix = structuredClone(valid);
  tamperedPrefix.history[0].summary = 'forged prior fact';
  const nonFactSuffix = appendVersion(baseline, baseline.revision,
    node('forged-goal', 'goal', [], {reason: 'fact projection'}));
  const wrongReason = appendVersion(baseline, baseline.revision,
    node('wrong-reason', 'fact', [], {reason: 'external observation'}));
  let appendCalls = 0;
  const atomic = {
    read: (...args) => store.read(...args),
    append: (...args) => store.append(...args),
    appendBatch(...args) {
      appendCalls += 1;
      return store.appendBatch(...args);
    },
  };

  for (const candidate of [tamperedPrefix, nonFactSuffix, wrongReason]) {
    assert.throws(() => commitFactProjection(atomic, baseline, candidate, at),
      {code: 'INTEGRITY_ERROR'});
  }
  assert.equal(appendCalls, 0);
  assert.deepEqual(store.read(), baseline);

  const empty = commitFactProjection(atomic, baseline, structuredClone(baseline), at);
  assert.equal(appendCalls, 0);
  assert.deepEqual(empty.snapshot, baseline);
  empty.snapshot.history[0].summary = 'outside mutation';
  assert.deepEqual(store.read(), baseline, 'the no-op result must not alias durable state');
});
