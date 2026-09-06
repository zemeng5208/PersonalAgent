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

test('defaults date to the injected clock day', async () => {
  const {service} = makeService({defaultLocation: 'Beijing'});
  const result = await service.getForecast({});
  assert.equal(result.forecast.date, '2026-09-05');
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

test('cache hit within TTL skips the provider', async () => {
  const {provider, service, clock} = makeService({defaultLocation: 'Beijing'});
  const first = await service.getForecast({});
  assert.equal(first.cache.state, 'fetched');
  assert.equal(provider.fetchCalls, 1);
  clock.advance(60_000);
  const second = await service.getForecast({});
  assert.equal(second.cache.state, 'fresh');
  assert.equal(second.cache.ageMs, 60_000);
  assert.equal(provider.fetchCalls, 1);
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

test('cancellation never returns stale cache or a successful forecast', async () => {
  const cached = makeService({defaultLocation: 'Beijing'});
  await cached.service.getForecast({});
  cached.clock.advance(ttl + 1);
  cached.provider.setFailure(new ProtocolError('CANCELLED', 'cancelled'));
  await assert.rejects(cached.service.getForecast({}), {code: 'CANCELLED'});

  const controller = new AbortController();
  const ignoringProvider = {
    source: 'ignoring-weather',
    async fetchForecast() {
      controller.abort();
      return {
        summary: 'must not escape',
        temperatureMin: 1,
        temperatureMax: 2,
        precipitationProbability: 0,
        publishedAt: '2026-09-05T08:30:00.000Z',
      };
    },
  };
  const service = new WeatherService({provider: ignoringProvider, now: () => Date.parse('2026-09-05T12:00:00.000Z')});
  await assert.rejects(service.getForecast({location: 'Beijing'}, controller.signal), {code: 'CANCELLED'});
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
