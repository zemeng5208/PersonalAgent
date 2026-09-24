import assert from 'node:assert/strict';
import test from 'node:test';
import {parseFactChangeBatch} from '../dist/index.js';

const fixture = () => ({mode: 'bootstrap', batchToken: 'batch', baseCheckpoint: 'checkpoint',
  watermark: 'watermark', entries: [{eventId: 'event', fact: {id: 'fact', revision: 1}}], atWatermark: true});

test('feed delivery parser preserves opaque tokens and isolates exact refs', () => {
  const input = fixture();
  const result = parseFactChangeBatch(input);
  assert.deepEqual(result, input);
  result.entries[0].fact.revision = 2;
  assert.equal(input.entries[0].fact.revision, 1);
  assert.equal('sequence' in result, false);
});

test('feed delivery rejects duplicate identities and malformed structural fields', () => {
  for (const mutate of [
    batch => { batch.entries.push(structuredClone(batch.entries[0])); },
    batch => { batch.entries.push({eventId: 'other', fact: {id: 'fact', revision: 1}}); },
    batch => { batch.sequence = 99; },
    batch => { batch.entries[0].fact.revision = 0; },
    batch => { batch.entries = new Array(1); },
    batch => { batch.entries.extra = true; },
    batch => { batch.entries[Symbol('extra')] = true; },
    batch => { batch.entries = Array.from({length: 101}, (_, i) => ({eventId: `e${i}`, fact: {id: `f${i}`, revision: 1}})); },
    batch => { batch.atWatermark = 'true'; },
  ]) {
    const input = fixture(); mutate(input);
    assert.throws(() => parseFactChangeBatch(input), {code: 'INVALID_ARGUMENT'});
  }
});

test('array length property traps cannot hide invalid entries', () => {
  const input = fixture();
  input.entries[0].fact.revision = 0;
  let reads = 0;
  input.entries = new Proxy(input.entries, {get(target, key, receiver) {
    if (key === 'length') { reads++; return 0; }
    return Reflect.get(target, key, receiver);
  }});
  assert.throws(() => parseFactChangeBatch(input), {code: 'INVALID_ARGUMENT'});
  assert.equal(reads, 0);
});

test('accessors and hostile proxies are rejected without evaluating data getters or leaking errors', () => {
  let reads = 0;
  const input = fixture();
  Object.defineProperty(input, 'entries', {enumerable: true, get() { reads++; throw Error('private content'); }});
  assert.throws(() => parseFactChangeBatch(input), {code: 'INVALID_ARGUMENT', message: 'Invalid fact change request'});
  assert.equal(reads, 0);
  assert.throws(() => parseFactChangeBatch(new Proxy({}, {ownKeys() { throw Error('private token'); }})),
    {code: 'INVALID_ARGUMENT', message: 'Invalid fact change request'});
});
