import assert from 'node:assert/strict';
import {test} from 'node:test';
import {register, FakeWeatherProvider, WeatherService, WeatherConnector} from '../dist/index.js';
import {FakeClock, FakeToolHost} from '@personal-agent/testkit';
import {ProtocolError, validateContract} from '@personal-agent/contracts';

const ttl = 600_000;
const makeService = (options = {}) => {
  const clock = new FakeClock();
  const provider = new FakeWeatherProvider();
  return {clock, provider, service: new WeatherService({provider, now: clock.now, ...options})};
};

const makeServiceAt = (nowMs, fixtures, options = {}) => {
  const clock = new FakeClock(nowMs);
  const provider = new FakeWeatherProvider(fixtures);
  return {clock, provider, service: new WeatherService({provider, now: clock.now, ...options})};
};

/**
 * `FakeWeatherProvider` cannot fail resolution, because a fixture lookup has no I/O. These cases
 * need the two operations to fail independently, so they get their own stub.
 */
const stubProvider = (timezone = 'Asia/Shanghai') => {
  const state = {resolveCalls: 0, fetchCalls: 0, resolveFailure: null, fetchFailure: null};
  return {
    state,
    source: 'stub-weather',
    verification: 'mock',
    async resolvePlace(location) {
      state.resolveCalls++;
      if (state.resolveFailure) throw state.resolveFailure;
      return {name: location, latitude: 0, longitude: 0, timezone, ambiguous: false, alternatives: [], confidence: 'high'};
    },
    async fetchForecast() {
      state.fetchCalls++;
      if (state.fetchFailure) throw state.fetchFailure;
      return {
        summary: '晴', temperatureMin: 20, temperatureMax: 26, precipitationProbability: 0,
        publishedAt: '2026-09-05T08:30:00.000Z', publishedTimeKind: 'provider_published',
      };
    },
  };
};

const makeStubService = (nowMs, timezone) => {
  const provider = stubProvider(timezone);
  const clock = new FakeClock(nowMs);
  return {clock, provider, state: provider.state, service: new WeatherService({provider, now: clock.now})};
};

test('refuses to guess a location when none is configured or given', async () => {
  const {service} = makeService();
  await assert.rejects(service.getForecast({}), {code: 'INVALID_ARGUMENT'});
  await assert.rejects(service.getForecast({date: '2026-09-05'}), {code: 'INVALID_ARGUMENT'});
  await assert.rejects(service.getForecast({location: '   '}), {code: 'INVALID_ARGUMENT'});
});

test('uses configured default location and per-request location overrides it', async () => {
  const {service} = makeService({defaultLocation: 'Beijing'});
  const defaulted = await service.getForecast({date: '2026-09-06'});
  assert.equal(defaulted.forecast.location, 'Beijing');
  const overridden = await service.getForecast({location: 'Shanghai', date: '2026-09-05'});
  assert.equal(overridden.forecast.location, 'Shanghai');
});

test('defaults the date to the destination local day, not the UTC day', async () => {
  // 20:00Z on 2026-09-05 is 04:00 on 2026-09-06 in Beijing. The UTC day asked for the 5th and
  // silently returned yesterday's forecast.
  const {service} = makeServiceAt(Date.parse('2026-09-05T20:00:00.000Z'), undefined, {defaultLocation: 'Beijing'});
  const result = await service.getForecast({});
  assert.equal(result.forecast.date, '2026-09-06');
  assert.equal(result.forecast.summary, '多云，午后局部阵雨', 'the row for the local day, not the UTC one');
  assert.equal(result.record.dedupeKey, 'fixture-weather:Beijing:2026-09-06:metric');
});

test('a destination behind UTC keeps the previous local day', async () => {
  const fixtures = [{
    location: 'New York', date: '2026-09-05', summary: 'Clear', temperatureMinC: 18, temperatureMaxC: 24,
    precipitationProbability: 0, publishedAt: '2026-09-05T08:30:00.000Z', timezone: 'America/New_York',
  }];
  // 02:00Z on the 6th is 22:00 EDT on the 5th.
  const {service} = makeServiceAt(Date.parse('2026-09-06T02:00:00.000Z'), fixtures, {defaultLocation: 'New York'});
  assert.equal((await service.getForecast({})).forecast.date, '2026-09-05');
});

test('the furthest-ahead zone crosses the day boundary first', async () => {
  const fixtures = [{
    location: 'Kiritimati', date: '2026-09-06', summary: '多云', temperatureMinC: 26, temperatureMaxC: 30,
    precipitationProbability: 20, publishedAt: '2026-09-05T08:30:00.000Z', timezone: 'Pacific/Kiritimati',
  }];
  // UTC+14 with no DST, so noon UTC is already 02:00 the next day.
  const {service} = makeServiceAt(Date.parse('2026-09-05T12:00:00.000Z'), fixtures, {defaultLocation: 'Kiritimati'});
  assert.equal((await service.getForecast({})).forecast.date, '2026-09-06');
});

test('a fixture that claims no local day falls back to the UTC day', async () => {
  const fixtures = [{
    location: 'Nowhere', date: '2026-09-05', summary: '晴', temperatureMinC: 10, temperatureMaxC: 20,
    precipitationProbability: 0, publishedAt: '2026-09-05T08:30:00.000Z',
  }];
  const {service} = makeServiceAt(Date.parse('2026-09-05T20:00:00.000Z'), fixtures, {defaultLocation: 'Nowhere'});
  assert.equal((await service.getForecast({})).forecast.date, '2026-09-05', 'UTC, because nothing better is claimed');
});

test('a timezone the platform cannot resolve is an upstream failure, not a bad argument', async () => {
  const {service} = makeStubService(Date.parse('2026-09-05T12:00:00.000Z'), 'Mars/Olympus_Mons');
  await assert.rejects(service.getForecast({location: '北京'}), {code: 'EXTERNAL_FAILURE', retryable: false});
});

test('an explicit date is taken as given and never resolves the place', async () => {
  const {provider, service} = makeService({defaultLocation: 'Beijing'});
  await service.getForecast({date: '2026-09-06'});
  assert.equal(provider.fetchCalls, 1);
  assert.equal(provider.resolveCalls, 0, 'the caller already said which day they meant');
});

test('the hint reaches both provider calls and joins the record identity', async () => {
  const calls = [];
  const provider = {
    source: 'recording-weather',
    verification: 'mock',
    async resolvePlace(location, locationQuery) {
      calls.push(['resolve', location, locationQuery]);
      return {name: location, latitude: 40.71427, longitude: -74.00597, timezone: 'America/New_York', ambiguous: false, alternatives: [], confidence: 'high'};
    },
    async fetchForecast(request) {
      calls.push(['fetch', request.location, request.locationQuery, request.date]);
      return {
        summary: 'Clear', temperatureMin: 18, temperatureMax: 24, precipitationProbability: 0,
        publishedAt: '2026-09-05T08:30:00.000Z', publishedTimeKind: 'provider_published',
      };
    },
  };
  const clock = new FakeClock(Date.parse('2026-09-05T12:00:00.000Z'));
  const service = new WeatherService({provider, now: clock.now});

  const result = await service.getForecast({location: '纽约', locationQuery: 'New York'});
  assert.deepEqual(calls, [
    ['resolve', '纽约', 'New York'],
    ['fetch', '纽约', 'New York', '2026-09-05'],
  ]);
  // The hint can change which place is resolved, so it has to be part of what the host dedupes on.
  assert.equal(result.record.dedupeKey, 'recording-weather:纽约|New York:2026-09-05:metric');
  assert.equal(result.record.externalId, '纽约|New York|2026-09-05|metric');
  assert.match(result.record.contentRef, /^weather:\/\/forecast\/%E7%BA%BD%E7%BA%A6%7CNew%20York\/2026-09-05\?units=metric$/);

  const unhinted = await service.getForecast({location: '纽约'});
  assert.notEqual(unhinted.record.dedupeKey, result.record.dedupeKey, 'a different hint is a different claim');
});

test('forecast separates published, fetched and validity times and echoes units', async () => {
  const {service} = makeService({defaultLocation: 'Beijing'});
  const result = await service.getForecast({date: '2026-09-06', units: 'imperial'});
  assert.equal(result.record.occurredAt, '2026-09-05T08:30:00.000Z');
  assert.equal(result.record.fetchedAt, '2026-09-05T12:00:00.000Z');
  assert.notEqual(result.record.occurredAt, result.record.fetchedAt);
  assert.equal(result.record.validFor, '2026-09-06T00:00:00.000Z/2026-09-07T00:00:00.000Z');
  assert.equal(result.forecast.units, 'imperial');
  assert.equal(result.forecast.temperatureMin, 62.6);
  assert.equal(result.forecast.temperatureMax, 78.8);
  validateContract('connectorItem', result.record);
});

test('cache hit within TTL skips the fetch but not the resolution that derives the date', async () => {
  const {provider, service, clock} = makeService({defaultLocation: 'Beijing'});
  const first = await service.getForecast({});
  assert.equal(first.cache.state, 'fetched');
  assert.equal(provider.fetchCalls, 1);
  assert.equal(provider.resolveCalls, 1);
  clock.advance(60_000);
  const second = await service.getForecast({});
  assert.equal(second.cache.state, 'fresh');
  assert.equal(second.cache.ageMs, 60_000);
  assert.equal(provider.fetchCalls, 1, 'the forecast itself is served from cache');
  // The key contains the date and the date comes from the place, so resolution has to run first.
  // A real provider answers this second call from its own geocode cache, without a network request.
  assert.equal(provider.resolveCalls, 2);
});

test('cache expiry triggers a refetch', async () => {
  const {provider, service, clock} = makeService({defaultLocation: 'Beijing'});
  await service.getForecast({});
  clock.advance(ttl + 1);
  const result = await service.getForecast({});
  assert.equal(result.cache.state, 'fetched');
  assert.equal(provider.fetchCalls, 2);
});

test('provider failure serves stale cache with explicit marking', async () => {
  const {provider, service, clock} = makeService({defaultLocation: 'Beijing'});
  await service.getForecast({});
  clock.advance(ttl + 1);
  provider.setFailure(new ProtocolError('EXTERNAL_FAILURE', 'provider down', true));
  const result = await service.getForecast({});
  assert.equal(result.cache.state, 'stale');
  assert.equal(result.cache.lastError.code, 'EXTERNAL_FAILURE');
  assert.equal(result.cache.lastError.retryable, true);
  assert.equal(result.forecast.summary, '晴转多云');

  provider.setFailure(new ProtocolError('RATE_LIMITED', 'slow down', true, 30_000));
  const rateLimited = await service.getForecast({});
  assert.equal(rateLimited.cache.lastError.code, 'RATE_LIMITED');
  assert.equal(rateLimited.cache.lastError.retryAfterMs, 30_000);
});

test('a dateless query still falls back to stale data when only the fetch fails', async () => {
  const {service, state, clock} = makeStubService(Date.parse('2026-09-05T12:00:00.000Z'));
  assert.equal((await service.getForecast({location: '北京'})).cache.state, 'fetched');
  clock.advance(ttl + 1);
  state.fetchFailure = new ProtocolError('EXTERNAL_FAILURE', 'provider down', true);
  const result = await service.getForecast({location: '北京'});
  assert.equal(result.cache.state, 'stale');
  assert.equal(result.cache.lastError.code, 'EXTERNAL_FAILURE');
  assert.equal(state.fetchCalls, 2);
});

test('a dateless query cannot fall back to stale data when resolution itself fails', async () => {
  // Limitation, stated rather than papered over: the cache key contains the date and the date
  // comes from the resolved place, so when resolution fails there is nothing to look an entry up
  // by. Passing an explicit date keeps the stale fallback available.
  const {service, state, clock} = makeStubService(Date.parse('2026-09-05T12:00:00.000Z'));
  await service.getForecast({location: '北京'});
  clock.advance(ttl + 1);
  state.resolveFailure = new ProtocolError('RATE_LIMITED', 'slow down', true, 30_000);
  await assert.rejects(service.getForecast({location: '北京'}), {code: 'RATE_LIMITED'});

  state.fetchFailure = new ProtocolError('EXTERNAL_FAILURE', 'provider down', true);
  const dated = await service.getForecast({location: '北京', date: '2026-09-05'});
  assert.equal(dated.cache.state, 'stale', 'an explicit date still reaches the cached entry');
  assert.equal(dated.cache.lastError.code, 'EXTERNAL_FAILURE');
});

test('cancellation never returns stale cache or a successful forecast', async () => {
  const cached = makeService({defaultLocation: 'Beijing'});
  await cached.service.getForecast({});
  cached.clock.advance(ttl + 1);
  cached.provider.setFailure(new ProtocolError('CANCELLED', 'cancelled'));
  await assert.rejects(cached.service.getForecast({}), {code: 'CANCELLED'});

  const controller = new AbortController();
  const ignoringProvider = {
    source: 'ignoring-weather',
    verification: 'mock',
    async resolvePlace(location) {
      return {name: location, latitude: 0, longitude: 0, timezone: 'Asia/Shanghai', ambiguous: false, alternatives: [], confidence: 'high'};
    },
    async fetchForecast() {
      controller.abort();
      return {
        summary: 'must not escape',
        temperatureMin: 1,
        temperatureMax: 2,
        precipitationProbability: 0,
        publishedAt: '2026-09-05T08:30:00.000Z',
        publishedTimeKind: 'provider_published',
      };
    },
  };
  const service = new WeatherService({provider: ignoringProvider, now: () => Date.parse('2026-09-05T12:00:00.000Z')});
  await assert.rejects(service.getForecast({location: 'Beijing', date: '2026-09-05'}, controller.signal), {code: 'CANCELLED'});
});

test('provider failure without cache propagates', async () => {
  const {provider, service} = makeService({defaultLocation: 'Beijing'});
  provider.setFailure(new ProtocolError('EXTERNAL_FAILURE', 'provider down', false));
  await assert.rejects(service.getForecast({}), {code: 'EXTERNAL_FAILURE'});
});

test('rejects invalid dates, units and unknown fixtures', async () => {
  const {service} = makeService({defaultLocation: 'Beijing'});
  await assert.rejects(service.getForecast({date: '2026-9-6'}), {code: 'INVALID_ARGUMENT'});
  await assert.rejects(service.getForecast({date: '2026-02-30'}), {code: 'INVALID_ARGUMENT'});
  await assert.rejects(service.getForecast({units: 'kelvin'}), {code: 'INVALID_ARGUMENT'});
  await assert.rejects(service.getForecast({location: 'Nowhere', date: '2026-09-05'}), {code: 'NOT_FOUND'});
});

test('registration refuses to silently enable the fake provider', () => {
  const host = new FakeToolHost();
  assert.throws(() => register(host), {code: 'INVALID_ARGUMENT'});
  assert.equal(host.verification, 'mock');
});

test('tool registration enforces scope and disposal', async () => {
  const clock = new FakeClock();
  const provider = new FakeWeatherProvider();
  const host = new FakeToolHost(clock.now);
  const dispose = register(host, {provider, now: clock.now, defaultLocation: 'Beijing'});
  const context = {taskId: 't', runId: 'r', authorizationRef: 'fixture', signal: new AbortController().signal, deadline: new Date(clock.now() + 5_000).toISOString(), scopes: []};
  await assert.rejects(host.invoke('weather.forecast', {}, context), {code: 'SCOPE_DENIED'});
  const result = await host.invoke('weather.forecast', {date: '2026-09-06'}, {...context, scopes: ['weather:read']});
  assert.equal(result.forecast.location, 'Beijing');
  assert.equal(result.cache.state, 'fetched');
  await assert.rejects(host.invoke('weather.forecast', {units: 'kelvin'}, {...context, scopes: ['weather:read']}), {code: 'INVALID_ARGUMENT'});
  dispose();
  await assert.rejects(host.invoke('weather.forecast', {}, {...context, scopes: ['weather:read']}), {code: 'UNSUPPORTED_CAPABILITY'});
});

test('connector manifest validates and lifecycle reports health', () => {
  const clock = new FakeClock();
  const service = new WeatherService({provider: new FakeWeatherProvider(), now: clock.now});
  const connector = new WeatherConnector(service);
  validateContract('connector', connector.manifest);
  assert.deepEqual(connector.getCapabilities(), ['forecast']);
  assert.equal(connector.health().state, 'disconnected');
  const session = connector.connect();
  assert.equal(session.interactionRequired, false);
  assert.equal(connector.health().state, 'ready');
  assert.throws(() => connector.fetchChanges({accountRef: 'x', limit: 1}), {code: 'UNSUPPORTED_CAPABILITY'});
  assert.throws(() => connector.search('x', 'q'), {code: 'UNSUPPORTED_CAPABILITY'});
  assert.throws(() => connector.getItem('x', '1'), {code: 'UNSUPPORTED_CAPABILITY'});
  assert.throws(() => connector.performAction({accountRef: 'x', action: 'a', input: {}, idempotencyKey: 'k'}), {code: 'UNSUPPORTED_CAPABILITY'});
  connector.disconnect();
  assert.equal(connector.health().state, 'disconnected');
});
