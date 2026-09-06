import { ProtocolError } from '@personal-agent/contracts';
import type { ForecastFetch, ForecastRequest, ResolvedPlace, WeatherProvider } from './provider.js';

export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type FetchLike = (url: string, init: {signal: AbortSignal; headers: Record<string, string>}) => Promise<FetchResponseLike>;

/** `strict` refuses an ambiguous place name instead of accepting the provider's top ranking. */
export type LocationResolution = 'ranked' | 'strict';

export interface OpenMeteoOptions {
  fetchImpl?: FetchLike;
  language?: string;
  locationResolution?: LocationResolution;
  forecastBaseUrl?: string;
  geocodingBaseUrl?: string;
  geocodeCacheLimit?: number;
}

interface GeoCandidate {
  id?: number;
  name: string;
  latitude: number;
  longitude: number;
  timezone: string;
  admin1?: string;
  country?: string;
  population?: number;
}

/** A place after merging every language pass that returned it. */
interface MergedPlace {
  /** From the preferred language pass when it carried the place, otherwise the fallback. */
  candidate: GeoCandidate;
  /** Normalized name variants across passes, used for exact matching. */
  names: string[];
  population: number;
  /** First-seen position, so ranking stays stable when population is unknown. */
  order: number;
}

const USER_AGENT = 'personal-agent-weather/0.1.0-alpha.1';
const FORECAST_BASE_URL = 'https://api.open-meteo.com';
const GEOCODING_BASE_URL = 'https://geocoding-api.open-meteo.com';
const MS_PER_DAY = 86_400_000;
const MAX_CANDIDATES = 5;
const MAX_ALTERNATIVES = 4;
const DEFAULT_GEOCODE_CACHE_LIMIT = 500;

const WMO_SUMMARY_ZH: Readonly<Record<number, string>> = {
  0: '晴', 1: '大致晴朗', 2: '局部多云', 3: '阴',
  45: '雾', 48: '沉积雾凇',
  51: '小毛毛雨', 53: '中毛毛雨', 55: '大毛毛雨', 56: '小冻毛毛雨', 57: '大冻毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨', 66: '小冻雨', 67: '大冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '小阵雨', 81: '中阵雨', 82: '强阵雨', 85: '小阵雪', 86: '大阵雪',
  95: '雷阵雨', 96: '雷阵雨伴小冰雹', 99: '雷阵雨伴大冰雹',
};

const WMO_SUMMARY_EN: Readonly<Record<number, string>> = {
  0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Depositing rime fog',
  51: 'Light drizzle', 53: 'Moderate drizzle', 55: 'Dense drizzle', 56: 'Light freezing drizzle', 57: 'Dense freezing drizzle',
  61: 'Slight rain', 63: 'Moderate rain', 65: 'Heavy rain', 66: 'Light freezing rain', 67: 'Heavy freezing rain',
  71: 'Slight snowfall', 73: 'Moderate snowfall', 75: 'Heavy snowfall', 77: 'Snow grains',
  80: 'Slight rain showers', 81: 'Moderate rain showers', 82: 'Violent rain showers', 85: 'Slight snow showers', 86: 'Heavy snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm with slight hail', 99: 'Thunderstorm with heavy hail',
};

/** Only Chinese and English summaries are authored; other `language` values localize place names and fall back to English here. */
function summaryFor(code: number | null, language: string): string {
  const zh = language.toLowerCase().startsWith('zh');
  if (code === null) return zh ? '天气状况未提供' : 'Weather condition not provided';
  const table = zh ? WMO_SUMMARY_ZH : WMO_SUMMARY_EN;
  return table[code] ?? (zh ? `未知天气代码 ${code}` : `Unknown weather code ${code}`);
}

const normalize = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, ' ');

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const asFiniteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const asNumberArray = (value: unknown): (number | null)[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const result: (number | null)[] = [];
  for (const entry of value) {
    if (entry === null) { result.push(null); continue; }
    const numeric = asFiniteNumber(entry);
    if (numeric === undefined) return undefined;
    result.push(numeric);
  }
  return result;
};

const label = (candidate: GeoCandidate): string =>
  [candidate.name, candidate.admin1, candidate.country].filter((part): part is string => typeof part === 'string' && part.length > 0).join(', ');

/** Different coordinates under the same admin region often produce identical labels; repeating them discloses nothing. */
const distinctLabels = (labels: string[]): string[] => [...new Set(labels)];

function offsetAt(utcMs: number, timeZone: string): number {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const fields: Record<string, string> = {};
  for (const part of format.formatToParts(new Date(utcMs))) fields[part.type] = part.value;
  const year = fields.year; const month = fields.month; const day = fields.day;
  const hour = fields.hour; const minute = fields.minute; const second = fields.second;
  if (!year || !month || !day || !hour || !minute || !second) throw new ProtocolError('EXTERNAL_FAILURE', `Cannot resolve timezone ${timeZone}`, false);
  return Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`) - utcMs;
}

/**
 * Resolved through Intl rather than the API's `utc_offset_seconds`, which reflects the
 * offset now and would shift local-day boundaries by an hour across a DST transition.
 */
function zonedDayStartUtc(date: string, timeZone: string): number {
  const naive = Date.parse(`${date}T00:00:00.000Z`);
  if (Number.isNaN(naive)) throw new ProtocolError('EXTERNAL_FAILURE', `Cannot map ${date} in ${timeZone}`, false);
  const corrected = naive - offsetAt(naive - offsetAt(naive, timeZone), timeZone);
  const result = new Date(corrected);
  if (Number.isNaN(result.getTime())) throw new ProtocolError('EXTERNAL_FAILURE', `Cannot map ${date} in ${timeZone}`, false);
  return corrected;
}

const nextCalendarDate = (date: string): string => new Date(Date.parse(`${date}T00:00:00.000Z`) + MS_PER_DAY).toISOString().slice(0, 10);

const describeError = (error: unknown): string => error instanceof Error ? error.message : String(error);

export class OpenMeteoProvider implements WeatherProvider {
  readonly source = 'open-meteo';
  /** Real provider, but results require outbound network access to succeed. */
  readonly verification = 'conditional' as const;
  private readonly fetchImpl: FetchLike;
  private readonly language: string;
  private readonly locationResolution: LocationResolution;
  private readonly forecastBaseUrl: string;
  private readonly geocodingBaseUrl: string;
  private readonly geocodeCacheLimit: number;
  private readonly geocodeCache = new Map<string, ResolvedPlace>();

  constructor(options: OpenMeteoOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.language = options.language ?? 'zh';
    this.locationResolution = options.locationResolution ?? 'ranked';
    this.forecastBaseUrl = (options.forecastBaseUrl ?? FORECAST_BASE_URL).replace(/\/+$/, '');
    this.geocodingBaseUrl = (options.geocodingBaseUrl ?? GEOCODING_BASE_URL).replace(/\/+$/, '');
    const limit = options.geocodeCacheLimit ?? DEFAULT_GEOCODE_CACHE_LIMIT;
    if (!Number.isInteger(limit) || limit < 1) throw new Error('geocodeCacheLimit must be a positive integer');
    this.geocodeCacheLimit = limit;
  }

  async fetchForecast(request: ForecastRequest, signal: AbortSignal): Promise<ForecastFetch> {
    const place = await this.geocode(request.location, signal);
    const temperatureUnit = request.units === 'imperial' ? 'fahrenheit' : 'celsius';
    const url = `${this.forecastBaseUrl}/v1/forecast`
      + `?latitude=${place.latitude}&longitude=${place.longitude}`
      + '&daily=temperature_2m_min,temperature_2m_max,precipitation_probability_max,weather_code'
      + `&timezone=${encodeURIComponent(place.timezone)}`
      + `&start_date=${request.date}&end_date=${request.date}`
      + `&temperature_unit=${temperatureUnit}`;
    const payload = await this.getJson(url, signal);
    const body = asRecord(payload);
    const daily = asRecord(body?.daily);
    if (!body || !daily) throw new ProtocolError('EXTERNAL_FAILURE', 'Open-Meteo forecast response is missing the daily block', true);

    const times = daily.time;
    if (!Array.isArray(times) || times.length !== 1 || times[0] !== request.date) {
      throw new ProtocolError('NOT_FOUND', `Open-Meteo returned no daily forecast for ${place.name} on ${request.date}`, false);
    }
    const temperatureMin = asNumberArray(daily.temperature_2m_min)?.[0] ?? null;
    const temperatureMax = asNumberArray(daily.temperature_2m_max)?.[0] ?? null;
    if (temperatureMin === null || temperatureMax === null) {
      throw new ProtocolError('NOT_FOUND', `Open-Meteo has no temperature values for ${place.name} on ${request.date}`, false);
    }

    const precipitationRaw = asNumberArray(daily.precipitation_probability_max)?.[0] ?? null;
    if (precipitationRaw !== null && (precipitationRaw < 0 || precipitationRaw > 100)) {
      throw new ProtocolError('EXTERNAL_FAILURE', `Open-Meteo precipitation probability out of range: ${precipitationRaw}`, true);
    }
    const codes = asNumberArray(daily.weather_code);
    const code = codes?.[0] ?? null;

    const dayStart = zonedDayStartUtc(request.date, place.timezone);
    const coverageStart = new Date(dayStart).toISOString();
    const fetch: ForecastFetch = {
      summary: summaryFor(code, this.language),
      temperatureMin,
      temperatureMax,
      precipitationProbability: precipitationRaw === null ? null : Math.round(precipitationRaw),
      publishedAt: coverageStart,
      publishedTimeKind: 'coverage_start',
      coverage: {start: coverageStart, end: new Date(zonedDayStartUtc(nextCalendarDate(request.date), place.timezone)).toISOString()},
      resolved: place,
    };
    return fetch;
  }

  private async geocode(location: string, signal: AbortSignal): Promise<ResolvedPlace> {
    const trimmed = location.trim();
    if (!trimmed) throw new ProtocolError('INVALID_ARGUMENT', 'Weather location must not be empty; refusing to guess', false);
    const cacheKey = `${this.language}|${normalize(location)}`;
    const cached = this.geocodeCache.get(cacheKey);
    if (cached) return structuredClone(cached);

    const places = await this.searchAllLanguages(trimmed, signal);
    if (places.length === 0) throw new ProtocolError('NOT_FOUND', `Open-Meteo geocoding found no place named "${location}"`, false);

    const distinct = rankPlaces(places, normalize(location));
    const top = distinct[0];
    if (!top) throw new ProtocolError('NOT_FOUND', `Open-Meteo geocoding found no usable place for "${location}"`, false);
    const ambiguous = distinct.length > 1;
    if (ambiguous && this.locationResolution === 'strict') {
      throw new ProtocolError('INVALID_ARGUMENT',
        `Location "${location}" matches ${distinct.length} places; refusing to guess. Specify one of: ${distinct.map(place => label(place.candidate)).join(' / ')}`, false);
    }

    const best = top.candidate;
    const place: ResolvedPlace = {
      name: best.name,
      latitude: best.latitude,
      longitude: best.longitude,
      timezone: best.timezone,
      ambiguous,
      alternatives: distinctLabels(distinct.slice(1).map(entry => label(entry.candidate))).slice(0, MAX_ALTERNATIVES),
    };
    if (best.admin1 !== undefined) place.admin1 = best.admin1;
    if (best.country !== undefined) place.country = best.country;

    if (this.geocodeCache.size >= this.geocodeCacheLimit) {
      const oldest = this.geocodeCache.keys().next().value;
      if (oldest !== undefined) this.geocodeCache.delete(oldest);
    }
    this.geocodeCache.set(cacheKey, place);
    return structuredClone(place);
  }

  /**
   * Open-Meteo indexes place names per language and never matches across scripts: a
   * Chinese query returns nothing from the `en` index, and the `zh` index is traditional
   * and incomplete, so it omits New York City entirely while still carrying a village in
   * England literally named "New York". Querying both passes and merging by GeoNames id
   * makes resolution language-independent while still localizing the displayed name.
   */
  private async searchAllLanguages(location: string, signal: AbortSignal): Promise<MergedPlace[]> {
    if (this.language.toLowerCase().startsWith('en')) {
      return mergePlaces(await this.searchPlaces(location, this.language, signal), []);
    }
    const [preferred, fallback] = await Promise.all([
      this.searchPlaces(location, this.language, signal),
      this.searchPlaces(location, 'en', signal),
    ]);
    return mergePlaces(preferred, fallback);
  }

  private async searchPlaces(location: string, language: string, signal: AbortSignal): Promise<GeoCandidate[]> {
    const url = `${this.geocodingBaseUrl}/v1/search`
      + `?name=${encodeURIComponent(location)}&count=${MAX_CANDIDATES}`
      + `&language=${encodeURIComponent(language)}&format=json`;
    const body = asRecord(await this.getJson(url, signal));
    return readCandidates(body?.results);
  }

  private async getJson(url: string, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) throw new ProtocolError('CANCELLED', 'Weather request cancelled', false);
    let response: FetchResponseLike;
    try {
      response = await this.fetchImpl(url, {signal, headers: {'user-agent': USER_AGENT, accept: 'application/json'}});
    } catch (error) {
      if (signal.aborted) throw new ProtocolError('CANCELLED', 'Weather request cancelled', false);
      throw new ProtocolError('EXTERNAL_FAILURE', `Open-Meteo request failed: ${describeError(error)}`, true);
    }
    if (response.status === 429) throw new ProtocolError('RATE_LIMITED', 'Open-Meteo rate limit reached', true, 60_000);
    if (response.status === 404) throw new ProtocolError('NOT_FOUND', 'Open-Meteo has no data for this request', false);

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (!response.ok) throw new ProtocolError('EXTERNAL_FAILURE', `Open-Meteo returned HTTP ${response.status}`, response.status >= 500);
      throw new ProtocolError('EXTERNAL_FAILURE', `Open-Meteo returned malformed JSON: ${describeError(error)}`, true);
    }
    const body = asRecord(payload);
    const reason = typeof body?.reason === 'string' ? body.reason : undefined;
    if (!response.ok || body?.error === true) throw providerFailure(response.status, reason);
    return payload;
  }
}

/**
 * A 400 carrying "out of allowed range" means the date sits outside the model horizon,
 * i.e. no forecast exists for it — not that the caller sent a malformed date.
 */
function providerFailure(status: number, reason: string | undefined): ProtocolError {
  if (reason && /out of allowed range/i.test(reason)) {
    return new ProtocolError('NOT_FOUND', `Open-Meteo has no forecast for the requested date (${reason})`, false);
  }
  if (status === 400) return new ProtocolError('INVALID_ARGUMENT', `Open-Meteo rejected the request: ${reason ?? 'unspecified reason'}`, false);
  return new ProtocolError('EXTERNAL_FAILURE', `Open-Meteo returned HTTP ${status}${reason ? `: ${reason}` : ''}`, status >= 500);
}

function readCandidates(value: unknown): GeoCandidate[] {
  if (!Array.isArray(value)) return [];
  const candidates: GeoCandidate[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) continue;
    const name = record.name; const timezone = record.timezone;
    const latitude = asFiniteNumber(record.latitude); const longitude = asFiniteNumber(record.longitude);
    if (typeof name !== 'string' || name.length === 0) continue;
    if (typeof timezone !== 'string' || timezone.length === 0) continue;
    if (latitude === undefined || longitude === undefined) continue;
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) continue;
    const candidate: GeoCandidate = {name, latitude, longitude, timezone};
    const id = asFiniteNumber(record.id);
    if (id !== undefined) candidate.id = Math.trunc(id);
    if (typeof record.admin1 === 'string' && record.admin1.length > 0) candidate.admin1 = record.admin1;
    if (typeof record.country === 'string' && record.country.length > 0) candidate.country = record.country;
    const population = asFiniteNumber(record.population);
    if (population !== undefined && population >= 0) candidate.population = population;
    candidates.push(candidate);
  }
  return candidates;
}

/**
 * Keyed by GeoNames id, falling back to rounded coordinates for entries without one, so
 * the same place returned by both language passes collapses into a single candidate.
 * The preferred pass is consumed first and therefore supplies the displayed name.
 */
function mergePlaces(preferred: GeoCandidate[], fallback: GeoCandidate[]): MergedPlace[] {
  const byKey = new Map<string, MergedPlace>();
  let order = 0;
  for (const pass of [preferred, fallback]) {
    for (const candidate of pass) {
      const key = candidate.id !== undefined
        ? `id:${candidate.id}`
        : `co:${candidate.latitude.toFixed(2)},${candidate.longitude.toFixed(2)}`;
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, {candidate, names: [normalize(candidate.name)], population: candidate.population ?? 0, order: order++});
        continue;
      }
      const variant = normalize(candidate.name);
      if (!existing.names.includes(variant)) existing.names.push(variant);
      if (existing.population === 0 && candidate.population !== undefined) existing.population = candidate.population;
    }
  }
  return [...byKey.values()];
}

/**
 * Exact matches outrank the provider's fuzzy ones, and population breaks ties because the
 * provider's own ranking is unreliable across languages: for "New York" the `zh` pass puts
 * York, Nebraska first and omits New York City, which only the `en` pass returns.
 */
function rankPlaces(places: MergedPlace[], query: string): MergedPlace[] {
  const fieldMatches = (value: string | undefined): boolean => value !== undefined && normalize(value) === query;
  const exact = places.filter(place =>
    place.names.includes(query) || fieldMatches(place.candidate.admin1) || fieldMatches(place.candidate.country));
  const pool = exact.length > 0 ? exact : places;
  return [...pool].sort((a, b) => b.population - a.population || a.order - b.order);
}
