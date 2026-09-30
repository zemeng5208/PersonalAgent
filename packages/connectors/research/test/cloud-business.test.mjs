import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ResearchService, FakeResearchProvider} from '../dist/index.js';
import {ProtocolError} from '@personal-agent/contracts';

test('research fetchedAt records provider completion, TTL refreshes and stale fallback preserves actual fetch time', async () => {
  let time = Date.parse('2026-09-30T10:00:00.000Z');
  const provider = new FakeResearchProvider();
  const fetch = provider.search.bind(provider);
  provider.search = async (...args) => {time += 2000; return fetch(...args);};
  const service = new ResearchService(provider, {now: () => time, cacheTtlMs: 1000});
  const first = await service.search('fixture', 'agent', {});
  assert.equal(first.cache.fetchedAt, '2026-09-30T10:00:02.000Z');
  assert.equal(first.results[0].record.fetchedAt, first.cache.fetchedAt);
  assert.equal((await service.search('fixture', 'agent', {})).cache.state, 'fresh');
  time += 1000;
  provider.setFailure(new ProtocolError('EXTERNAL_FAILURE', 'offline fixture failure', true));
  const stale = await service.search('fixture', 'agent', {});
  assert.equal(stale.cache.state, 'stale');
  assert.equal(stale.cache.fetchedAt, first.cache.fetchedAt);
  assert.ok(stale.cache.ageMs >= 1000);
});

test('cancelled research cannot return cached content or adopt a cancelled provider result', async () => {
  const provider = new FakeResearchProvider();
  const service = new ResearchService(provider, {now: Date.now});
  await service.search('fixture', 'agent', {});
  await assert.rejects(service.search('fixture', 'agent', {signal: AbortSignal.abort()}), {code: 'CANCELLED'});
  const controller = new AbortController();
  const fetch = provider.search.bind(provider);
  provider.search = async (...args) => {const result = await fetch(...args); controller.abort(); return result;};
  await assert.rejects(service.search('fixture', 'weather', {signal: controller.signal}), {code: 'CANCELLED'});
  await assert.rejects(service.search('fixture', 'agent', {limit: 0}), {code: 'INVALID_ARGUMENT'});
});
