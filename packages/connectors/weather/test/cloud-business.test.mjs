import assert from 'node:assert/strict';
import {test} from 'node:test';
import {OpenMeteoProvider} from '../dist/index.js';

test('geocoding expires at its independent TTL, refetches coordinates, and uses disjoint location/hint keys', async () => {
  let time = 0, calls = 0, longitude = 116;
  const provider = new OpenMeteoProvider({language: 'en', now: () => time, geocodeCacheTtlMs: 100,
    fetchImpl: async () => {calls++; return {ok: true, status: 200, json: async () => ({results: [{
      id: 1, name: 'Beijing', latitude: 39, longitude, timezone: 'Asia/Shanghai', feature_code: 'PPLC', population: 1000000,
    }]})};}});
  const signal = new AbortController().signal;
  assert.equal((await provider.resolvePlace('Beijing', undefined, signal)).longitude, 116);
  assert.equal(calls, 1);
  time = 99;
  await provider.resolvePlace('Beijing', undefined, signal);
  assert.equal(calls, 1);
  longitude = 117; time = 100;
  assert.equal((await provider.resolvePlace('Beijing', undefined, signal)).longitude, 117);
  assert.equal(calls, 2);
  await provider.resolvePlace('a|b', 'c', signal);
  const count = calls;
  await provider.resolvePlace('a', 'b|c', signal);
  assert.ok(calls > count, 'delimiter-containing names must not collide');
});

test('aborted resolution cannot reuse a cache hit; invalid geocode TTL is rejected', async () => {
  const provider = new OpenMeteoProvider({fetchImpl: async () => {throw Error('must not fetch');}});
  await assert.rejects(provider.resolvePlace('Beijing', undefined, AbortSignal.abort()));
  assert.throws(() => new OpenMeteoProvider({geocodeCacheTtlMs: 0}), {code: 'INVALID_ARGUMENT'});
});
