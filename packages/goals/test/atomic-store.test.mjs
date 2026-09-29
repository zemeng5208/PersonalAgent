import assert from 'node:assert/strict';
import test from 'node:test';
import {appendVersions, FakeCoordinationStoreHost} from '../dist/store.js';

const node = (id, dependencies = []) => ({id, kind:'plan', summary:id, sourceRef:'synthetic/batch',
  validFrom:'2026-09-17T00:00:00.000Z', validUntil:'2026-09-18T00:00:00.000Z',
  sensitivity:'private', state:'active', reason:'synthetic', dependencies});

test('atomic Fake batch validates completely before replacing its bound graph', () => {
  const host = new FakeCoordinationStoreHost();
  const store = host.provision('synthetic/a');
  const other = host.provision('synthetic/b');
  const original = store.read();
  const inputs = [node('first'), node('second', [{id:'first', revision:1}])];
  assert.equal(appendVersions(original, 0, inputs).revision, 2);
  assert.deepEqual(store.read(), original);
  const result = store.appendBatch(0, inputs);
  assert.equal(result.revision, 2);
  result.history[0].summary = 'changed returned copy';
  inputs[0].summary = 'changed input';
  assert.equal(store.read().history[0].summary, 'first');
  assert.equal(other.read().revision, 0);
  const before = store.read();
  assert.throws(() => store.appendBatch(2, [node('third'), node('bad', [{id:'missing',revision:1}])]), {code:'INVALID_ARGUMENT'});
  assert.deepEqual(store.read(), before);
  assert.throws(() => store.appendBatch(0, [node('stale')]), {code:'REVISION_CONFLICT'});
  assert.throws(() => store.appendBatch(2, []), {code:'INVALID_ARGUMENT'});
  assert.deepEqual(store.read(), before);
  assert.equal(store.append(2, node('legacy')).revision, 3);
});
