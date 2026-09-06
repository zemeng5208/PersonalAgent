import assert from 'node:assert/strict';
import {test} from 'node:test';
import {OpenMeteoProvider, WeatherService, WeatherConnector, register} from '../dist/index.js';
import {FakeClock, FakeToolHost} from '@personal-agent/testkit';
import {ProtocolError, validateContract} from '@personal-agent/contracts';

const DATE = '2026-09-06';
const signal = () => new AbortController().signal;

const jsonResponse = (body, status = 200) => ({ok: status >= 200 && status < 300, status, json: async () => body});

const stubFetch = routes => {
  const calls = [];
  const impl = async url => {
    calls.push(url);
    for (const [match, handler] of routes) if (url.includes(match)) return handler(url);
    throw new Error(`Unrouted URL: ${url}`);
  };
  impl.calls = calls;
  return impl;
};

const geoRoute = results => ['geocoding-api.open-meteo.com', () => jsonResponse({results})];

const beijingCandidates = [
  {id: 1816670, name: '北京', latitude: 39.9075, longitude: 116.39723, timezone: 'Asia/Shanghai', admin1: '北京市', country: '中国'},
  {id: 8404324, name: '北京', latitude: 30.73, longitude: 108.67, timezone: 'Asia/Shanghai', admin1: '重庆市', country: '中国'},
  {id: 10196578, name: '北京', latitude: 30.97, longitude: 103.94, timezone: 'Asia/Shanghai', admin1: '四川', country: '中国'},
];

const forecastRoute = (daily, status = 200) => ['api.open-meteo.com', url => {
  const date = new URL(url).searchParams.get('start_date');
  return jsonResponse({
    latitude: 39.89, longitude: 116.36, utc_offset_seconds: 28800, timezone: 'Asia/Shanghai',
    daily_units: {time: 'iso8601', temperature_2m_min: '°C', temperature_2m_max: '°C'},
    daily: typeof daily === 'function' ? daily(date, url) : {...daily, time: [date]},
  }, status);
}];

const healthyDaily = {temperature_2m_min: [22.3], temperature_2m_max: [31.4], precipitation_probability_max: [12], weather_code: [3]};

const makeProvider = (routes, options = {}) =>
  new OpenMeteoProvider({fetchImpl: stubFetch(routes), ...options});

const makeService = (routes, options = {}, serviceOptions = {}) => {
  const clock = new FakeClock(Date.parse('2026-09-06T02:00:00.000Z'));
  const provider = makeProvider(routes, options);
  return {clock, provider, service: new WeatherService({provider, now: clock.now, ...serviceOptions})};
};

test('maps a real forecast and labels the time source honestly', async () => {
  const {service} = makeService([geoRoute(beijingCandidates), forecastRoute(healthyDaily)]);
  const result = await service.getForecast({location: '北京', date: DATE});

  assert.equal(result.record.source, 'open-meteo');
  assert.equal(result.forecast.publishedTimeKind, 'coverage_start');
  // Asia/Shanghai local midnight for 2026-09-06 is 2026-09-05T16:00Z, not the UTC day boundary.
  assert.equal(result.record.occurredAt, '2026-09-05T16:00:00.000Z');
  assert.equal(result.record.validFor, '2026-09-05T16:00:00.000Z/2026-09-06T16:00:00.000Z');
  assert.equal(result.record.fetchedAt, '2026-09-06T02:00:00.000Z');
  assert.notEqual(result.record.occurredAt, result.record.fetchedAt);
  validateContract('connectorItem', result.record);

  assert.equal(result.forecast.summary, '阴');
  assert.equal(result.forecast.temperatureMin, 22.3);
  assert.equal(result.forecast.temperatureMax, 31.4);
  assert.equal(result.forecast.precipitationProbability, 12);
});

test('local day boundaries follow DST, not a fixed offset', async () => {
  const newYork = [{id: 5128581, name: 'New York', latitude: 40.71, longitude: -74.01, timezone: 'America/New_York', admin1: 'New York', country: 'United States'}];
  const {service} = makeService([geoRoute(newYork), forecastRoute(healthyDaily)], {language: 'en'});

  const summer = await service.getForecast({location: 'New York', date: '2026-07-15'});
  assert.equal(summer.record.occurredAt, '2026-07-15T04:00:00.000Z', 'EDT is UTC-4');
  const winter = await service.getForecast({location: 'New York', date: '2026-01-15'});
  assert.equal(winter.record.occurredAt, '2026-01-15T05:00:00.000Z', 'EST is UTC-5');
  assert.equal(summer.forecast.summary, 'Overcast', 'summary language follows the language option');
});

test('discloses an ambiguous place instead of silently picking one', async () => {
  const fetchImpl = stubFetch([geoRoute(beijingCandidates), forecastRoute(healthyDaily)]);
  const service = new WeatherService({provider: new OpenMeteoProvider({fetchImpl}), now: () => Date.parse('2026-09-06T02:00:00.000Z')});
  const result = await service.getForecast({location: '北京', date: DATE});

  assert.equal(result.forecast.resolved.ambiguous, true);
  assert.equal(result.forecast.resolved.name, '北京');
  assert.equal(result.forecast.resolved.admin1, '北京市');
  assert.equal(result.forecast.resolved.timezone, 'Asia/Shanghai');
  assert.deepEqual(result.forecast.resolved.alternatives, ['北京, 重庆市, 中国', '北京, 四川, 中国']);
});

test('strict resolution refuses an ambiguous place and lists the candidates', async () => {
  const {service} = makeService([geoRoute(beijingCandidates), forecastRoute(healthyDaily)], {locationResolution: 'strict'});
  await assert.rejects(service.getForecast({location: '北京', date: DATE}), error => {
    assert.equal(error.code, 'INVALID_ARGUMENT');
    assert.match(error.message, /refusing to guess/);
    assert.match(error.message, /重庆市/);
    assert.match(error.message, /四川/);
    return true;
  });
});

test('geocoding is cached per location', async () => {
  const fetchImpl = stubFetch([geoRoute(beijingCandidates), forecastRoute(healthyDaily)]);
  const provider = new OpenMeteoProvider({fetchImpl});
  const service = new WeatherService({provider, now: () => Date.parse('2026-09-06T02:00:00.000Z'), cacheTtlMs: 1});
  await service.getForecast({location: '北京', date: DATE, units: 'metric'});
  await service.getForecast({location: '北京', date: DATE, units: 'imperial'});
  assert.equal(fetchImpl.calls.filter(url => url.includes('geocoding-api')).length, 1);
  assert.equal(fetchImpl.calls.filter(url => url.includes('api.open-meteo.com/v1/forecast')).length, 2);
});

test('requests fahrenheit only for imperial units', async () => {
  const fetchImpl = stubFetch([geoRoute(beijingCandidates), forecastRoute(healthyDaily)]);
  const provider = new OpenMeteoProvider({fetchImpl});
  await provider.fetchForecast({location: '北京', date: DATE, units: 'metric'}, signal());
  await provider.fetchForecast({location: '北京', date: DATE, units: 'imperial'}, signal());
  const forecastCalls = fetchImpl.calls.filter(url => url.includes('/v1/forecast'));
  assert.match(forecastCalls[0], /temperature_unit=celsius/);
  assert.match(forecastCalls[1], /temperature_unit=fahrenheit/);
});

test('does not invent precipitation data the provider omitted', async () => {
  const {service} = makeService([geoRoute(beijingCandidates), forecastRoute({...healthyDaily, precipitation_probability_max: [null]})]);
  const result = await service.getForecast({location: '北京', date: DATE});
  assert.equal(result.forecast.precipitationProbability, null);
});

test('reports unknown weather codes as codes rather than made-up text', async () => {
  const provider = makeProvider([geoRoute(beijingCandidates), forecastRoute({...healthyDaily, weather_code: [42]})]);
  const result = await provider.fetchForecast({location: '北京', date: DATE, units: 'metric'}, signal());
  assert.equal(result.summary, '未知天气代码 42');
  const noCode = makeProvider([geoRoute(beijingCandidates), forecastRoute({...healthyDaily, weather_code: [null]})]);
  assert.equal((await noCode.fetchForecast({location: '北京', date: DATE, units: 'metric'}, signal())).summary, '天气状况未提供');
});

test('maps provider failures onto protocol error codes', async () => {
  const cases = [
    {name: 'no geocoding match', routes: [geoRoute([]), forecastRoute(healthyDaily)], query: {location: 'Zzqqxx', date: DATE}, code: 'NOT_FOUND'},
    {
      name: 'date outside model horizon',
      routes: [geoRoute(beijingCandidates), ['api.open-meteo.com', () => jsonResponse({error: true, reason: "Parameter 'start_date' is out of allowed range from 2026-06-05 to 2026-09-21"}, 400)]],
      query: {location: '北京', date: DATE}, code: 'NOT_FOUND',
    },
    {
      name: 'bad parameter',
      routes: [geoRoute(beijingCandidates), ['api.open-meteo.com', () => jsonResponse({error: true, reason: 'Cannot initialize DailyParameter'}, 400)]],
      query: {location: '北京', date: DATE}, code: 'INVALID_ARGUMENT',
    },
    {name: 'rate limited', routes: [geoRoute(beijingCandidates), ['api.open-meteo.com', () => jsonResponse({}, 429)]], query: {location: '北京', date: DATE}, code: 'RATE_LIMITED', retryable: true},
    {name: 'upstream error', routes: [geoRoute(beijingCandidates), ['api.open-meteo.com', () => jsonResponse({}, 503)]], query: {location: '北京', date: DATE}, code: 'EXTERNAL_FAILURE', retryable: true},
  ];
  for (const testCase of cases) {
    const {service} = makeService(testCase.routes);
    await assert.rejects(service.getForecast(testCase.query), error => {
      assert.equal(error.code, testCase.code, testCase.name);
      assert.ok(error instanceof ProtocolError, testCase.name);
      if (testCase.retryable !== undefined) assert.equal(error.retryable, testCase.retryable, testCase.name);
      return true;
    }, testCase.name);
  }
});

test('a date outside the horizon surfaces the provider allowed range', async () => {
  const {service} = makeService([geoRoute(beijingCandidates),
    ['api.open-meteo.com', () => jsonResponse({error: true, reason: "Parameter 'start_date' is out of allowed range from 2026-06-05 to 2026-09-21"}, 400)]]);
  await assert.rejects(service.getForecast({location: '北京', date: DATE}), {code: 'NOT_FOUND', message: /2026-06-05 to 2026-09-21/});
});

test('network failure is retryable and cancellation is distinct', async () => {
  const offline = makeProvider([geoRoute(beijingCandidates), ['api.open-meteo.com', () => { throw new Error('ENOTFOUND'); }]]);
  await assert.rejects(offline.fetchForecast({location: '北京', date: DATE, units: 'metric'}, signal()), {code: 'EXTERNAL_FAILURE', retryable: true});

  const aborted = new AbortController();
  aborted.abort();
  const provider = makeProvider([geoRoute(beijingCandidates), forecastRoute(healthyDaily)]);
  await assert.rejects(provider.fetchForecast({location: '北京', date: DATE, units: 'metric'}, aborted.signal), {code: 'CANCELLED'});
});

test('a malformed forecast payload is not passed through as data', async () => {
  const missing = makeProvider([geoRoute(beijingCandidates), ['api.open-meteo.com', () => jsonResponse({latitude: 39.9})]]);
  await assert.rejects(missing.fetchForecast({location: '北京', date: DATE, units: 'metric'}, signal()), {code: 'EXTERNAL_FAILURE'});

  const nullTemps = makeProvider([geoRoute(beijingCandidates), forecastRoute({...healthyDaily, temperature_2m_min: [null]})]);
  await assert.rejects(nullTemps.fetchForecast({location: '北京', date: DATE, units: 'metric'}, signal()), {code: 'NOT_FOUND'});
});

test('an empty location is refused rather than resolved to somewhere', async () => {
  const provider = makeProvider([geoRoute(beijingCandidates), forecastRoute(healthyDaily)]);
  await assert.rejects(provider.fetchForecast({location: '   ', date: DATE, units: 'metric'}, signal()), {code: 'INVALID_ARGUMENT'});
});

test('the connector advertises conditional verification for the real provider', () => {
  const provider = makeProvider([geoRoute(beijingCandidates), forecastRoute(healthyDaily)]);
  assert.equal(provider.verification, 'conditional');
  const connector = new WeatherConnector(new WeatherService({provider, now: Date.now}));
  assert.equal(connector.manifest.verification, 'conditional');
  assert.equal(connector.manifest.authentication, 'none');
  validateContract('connector', connector.manifest);
});

test('tool output from the real provider passes the declared output schema', async () => {
  const fetchImpl = stubFetch([geoRoute(beijingCandidates), forecastRoute({...healthyDaily, precipitation_probability_max: [null]})]);
  const clock = new FakeClock(Date.parse('2026-09-06T02:00:00.000Z'));
  const host = new FakeToolHost(clock.now);
  const dispose = register(host, {provider: new OpenMeteoProvider({fetchImpl}), now: clock.now});
  const context = {
    taskId: 't', runId: 'r', authorizationRef: 'fixture',
    signal: new AbortController().signal,
    deadline: new Date(clock.now() + 60_000).toISOString(),
    scopes: ['weather:read'],
  };

  const result = await host.invoke('weather.forecast', {location: '北京', date: DATE}, context);
  assert.equal(result.record.source, 'open-meteo');
  assert.equal(result.forecast.publishedTimeKind, 'coverage_start');
  assert.equal(result.forecast.precipitationProbability, null);
  assert.equal(result.forecast.resolved.ambiguous, true);
  assert.equal(result.forecast.resolved.timezone, 'Asia/Shanghai');

  dispose();
  await assert.rejects(host.invoke('weather.forecast', {location: '北京', date: DATE}, context), {code: 'UNSUPPORTED_CAPABILITY'});
});

const LIVE = process.env.PA_WEATHER_LIVE === '1';

test('live read-back against Open-Meteo', {skip: LIVE ? false : 'set PA_WEATHER_LIVE=1 to run the real provider read-back'}, async () => {
  const date = new Date().toISOString().slice(0, 10);
  const service = new WeatherService({provider: new OpenMeteoProvider(), now: Date.now});
  const result = await service.getForecast({location: '北京', date});

  assert.equal(result.record.source, 'open-meteo');
  validateContract('connectorItem', result.record);

  assert.equal(result.forecast.publishedTimeKind, 'coverage_start');
  assert.equal(result.forecast.resolved.timezone, 'Asia/Shanghai');
  assert.ok(result.forecast.resolved.latitude > 39 && result.forecast.resolved.latitude < 41);
  assert.ok(result.forecast.summary.length > 0);
  assert.ok(Number.isFinite(result.forecast.temperatureMin));
  assert.ok(Number.isFinite(result.forecast.temperatureMax));
  assert.ok(result.forecast.temperatureMin <= result.forecast.temperatureMax);

  const [coverageStart, coverageEnd] = result.record.validFor.split('/');
  assert.equal(result.record.occurredAt, coverageStart, 'occurredAt is the coverage start for this provider');
  assert.equal(Date.parse(coverageEnd) - Date.parse(coverageStart), 86_400_000, 'Asia/Shanghai has no DST');
  assert.notEqual(result.record.occurredAt, result.record.fetchedAt);

  const cached = await service.getForecast({location: '北京', date});
  assert.equal(cached.cache.state, 'fresh', 'a second call within TTL must not hit the network');
  assert.deepEqual(cached.forecast, result.forecast);

  console.log('live read-back:', JSON.stringify({
    occurredAt: result.record.occurredAt, fetchedAt: result.record.fetchedAt, validFor: result.record.validFor,
    summary: result.forecast.summary, min: result.forecast.temperatureMin, max: result.forecast.temperatureMax,
    precip: result.forecast.precipitationProbability, resolved: result.forecast.resolved,
  }));
});
