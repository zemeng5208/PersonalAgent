import { ProtocolError } from '@personal-agent/contracts';
import type { ForecastFetch, ForecastRequest, PlaceConfidence, ResolvedPlace, WeatherProvider } from './provider.js';

export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type FetchLike = (url: string, init: {signal: AbortSignal; headers: Record<string, string>}) => Promise<FetchResponseLike>;

/** `strict` refuses a low-confidence match instead of accepting the provider's top ranking. */
export type LocationResolution = 'ranked' | 'strict';

export interface OpenMeteoOptions {
  fetchImpl?: FetchLike;
  language?: string;
  locationResolution?: LocationResolution;
  forecastBaseUrl?: string;
  geocodingBaseUrl?: string;
  geocodeCacheLimit?: number;
  /** Population floor for trusting a match that is not an administrative seat. See `assessConfidence`. */
  minCorroboratedPopulation?: number;
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
  featureCode?: string;
}

/** A place after merging every language pass that returned it. */
interface MergedPlace {
  /** From the preferred language pass when it carried the place, otherwise the fallback. */
  candidate: GeoCandidate;
  /** Normalized name variants across passes, used for exact matching. */
  names: string[];
  population: number;
  featureCode: string | undefined;
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

/**
 * Calibrated on a gap measured against the production endpoint on 2026-09-06, not on a round
 * number: the worst misresolution (伦敦 → London, Ontario) carried 422324 people, while the
 * correct non-admin-seat city (New York) carried 8804190. Anything between those two figures
 * is unmeasured territory. Known false positives (阳朔, 同里 — correct places GeoNames gives no
 * population) and false negatives (`Pingyao` → Zhejiang, 凤凰 → Chongqing — wrong places that
 * are admin seats) are listed in the README. The rule detects a bad match; it does not repair it.
 */
const DEFAULT_MIN_CORROBORATED_POPULATION = 500_000;

/** GeoNames marks every inhabited place `PPL*`; `PCLI`, `PCL*`, `ADM*` and `MT` are not places a forecast can answer for. */
const POPULATED_PLACE_PREFIX = 'PPL';

/** A seat of government is corroborated by its own record, however small its population. */
const ADMIN_SEAT_CODES: ReadonlySet<string> = new Set(['PPLC', 'PPLA', 'PPLA2', 'PPLA3', 'PPLA4', 'PPLA5']);

/**
 * Han ideographs including the compatibility block. Japanese kanji match, which is intended:
 * GeoNames' `zh` index carries 東京. Kana and Hangul do not match, and their coverage is unmeasured.
 */
const HAN_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

function assessConfidence(featureCode: string | undefined, population: number, minCorroboratedPopulation: number): PlaceConfidence {
  if (featureCode === undefined || !featureCode.startsWith(POPULATED_PLACE_PREFIX)) return 'low';
  if (ADMIN_SEAT_CODES.has(featureCode)) return 'high';
  return population >= minCorroboratedPopulation ? 'high' : 'low';
}

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
  private readonly minCorroboratedPopulation: number;
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
    const floor = options.minCorroboratedPopulation ?? DEFAULT_MIN_CORROBORATED_POPULATION;
    if (!Number.isFinite(floor) || floor < 0) throw new Error('minCorroboratedPopulation must be a non-negative number');
    this.minCorroboratedPopulation = floor;
  }

  async fetchForecast(request: ForecastRequest, signal: AbortSignal): Promise<ForecastFetch> {
    const place = await this.resolvePlace(request.location, request.locationQuery, signal);
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

  /**
   * Resolves a place name, disclosing how much the match can be trusted.
   *
   * The hint is a fallback tier and never an equal one: measured on 2026-09-06, `婺源`
   * resolves correctly from Chinese while its Latin hint `Wuyuan` ranks a different county
   * in Zhejiang first. Merging both pools would let a wrong hint outrank a right input, so
   * the hint is only consulted when the original matched nothing or matched weakly.
   */
  async resolvePlace(location: string, locationQuery: string | undefined, signal: AbortSignal): Promise<ResolvedPlace> {
    const trimmed = location.trim();
    if (!trimmed) throw new ProtocolError('INVALID_ARGUMENT', 'Weather location must not be empty; refusing to guess', false);
    const hint = locationQuery?.trim() || undefined;
    // The hint changes which place a string resolves to, so it has to be part of the key.
    const cacheKey = `${this.language}|${normalize(location)}|${normalize(hint ?? '')}`;
    const cached = this.geocodeCache.get(cacheKey);
    if (cached) return structuredClone(cached);

    let ranked = rankPlaces(await this.searchPasses(trimmed, signal), normalize(trimmed));
    if (hint !== undefined && (ranked[0] === undefined || this.confidenceOf(ranked[0]) === 'low')) {
      const hinted = rankPlaces(await this.searchPasses(hint, signal), normalize(hint));
      if (hinted[0] !== undefined && this.confidenceOf(hinted[0]) === 'high') ranked = hinted;
    }

    const top = ranked[0];
    if (!top) throw new ProtocolError('NOT_FOUND', `Open-Meteo geocoding found no place named "${location}"`, false);

    const confidence = this.confidenceOf(top);
    if (confidence === 'low' && this.locationResolution === 'strict') {
      throw new ProtocolError('INVALID_ARGUMENT', strictRefusal(location, top, ranked), false);
    }

    const best = top.candidate;
    const place: ResolvedPlace = {
      name: best.name,
      latitude: best.latitude,
      longitude: best.longitude,
      timezone: best.timezone,
      ambiguous: ranked.length > 1,
      alternatives: distinctLabels(ranked.slice(1).map(entry => label(entry.candidate))).slice(0, MAX_ALTERNATIVES),
      confidence,
    };
    if (best.admin1 !== undefined) place.admin1 = best.admin1;
    if (best.country !== undefined) place.country = best.country;
    // From the merged entry, not the display candidate: this is the value `confidence` was
    // computed from, and disclosing a different one would make the verdict unauditable.
    if (top.featureCode !== undefined) place.featureCode = top.featureCode;

    if (this.geocodeCache.size >= this.geocodeCacheLimit) {
      const oldest = this.geocodeCache.keys().next().value;
      if (oldest !== undefined) this.geocodeCache.delete(oldest);
    }
    this.geocodeCache.set(cacheKey, place);
    return structuredClone(place);
  }

  private confidenceOf(place: MergedPlace): PlaceConfidence {
    return assessConfidence(place.featureCode, place.population, this.minCorroboratedPopulation);
  }

  /**
   * Open-Meteo indexes place names per language and never matches across scripts. Measured on
   * 2026-09-06: a Chinese string returns zero results under `language=en` — including the
   * traditional spellings 東京 and 倫敦 — and `zh-TW`/`zh-Hant` are empty as well. So the pass set
   * has to follow the input's script, not the configured language; the previous single pass under
   * an English configuration made every Chinese input fail outright.
   *
   * Merge order is the display-name preference: configured language first, then `zh` for Han
   * input, then `en`. This still does not make resolution script-independent — the `zh` index is
   * incomplete in both directions, which is what the hint tier exists for.
   */
  private async searchPasses(query: string, signal: AbortSignal): Promise<MergedPlace[]> {
    const languages: string[] = [];
    for (const language of [this.language, ...(HAN_PATTERN.test(query) ? ['zh'] : []), 'en']) {
      if (!languages.some(known => known.toLowerCase() === language.toLowerCase())) languages.push(language);
    }
    return mergePlaces(await Promise.all(languages.map(language => this.searchPlaces(query, language, signal))));
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
    if (typeof record.feature_code === 'string' && record.feature_code.length > 0) candidate.featureCode = record.feature_code;
    candidates.push(candidate);
  }
  return candidates;
}

/**
 * Keyed by GeoNames id, falling back to rounded coordinates for entries without one, so the
 * same place returned by several language passes collapses into a single candidate. Passes are
 * consumed in display-preference order, so the first one carrying a place supplies its name.
 */
function mergePlaces(passes: GeoCandidate[][]): MergedPlace[] {
  const byKey = new Map<string, MergedPlace>();
  let order = 0;
  for (const pass of passes) {
    for (const candidate of pass) {
      const key = candidate.id !== undefined
        ? `id:${candidate.id}`
        : `co:${candidate.latitude.toFixed(2)},${candidate.longitude.toFixed(2)}`;
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, {
          candidate,
          names: [normalize(candidate.name)],
          population: candidate.population ?? 0,
          featureCode: candidate.featureCode,
          order: order++,
        });
        continue;
      }
      const variant = normalize(candidate.name);
      if (!existing.names.includes(variant)) existing.names.push(variant);
      if (existing.population === 0 && candidate.population !== undefined) existing.population = candidate.population;
      if (existing.featureCode === undefined && candidate.featureCode !== undefined) existing.featureCode = candidate.featureCode;
    }
  }
  return [...byKey.values()];
}

/**
 * Exact name matches outrank the provider's fuzzy ones, and population breaks ties because the
 * provider's own ranking is unreliable across languages: for "New York" the `zh` pass puts
 * York, Nebraska first and omits New York City, which only the `en` pass returns.
 *
 * Region names are deliberately not matched against `admin1` or `country`. Doing so let
 * `Texas` or `France` masquerade as an exact place match; those lookups are surfaced as
 * low confidence by `assessConfidence` instead of being quietly promoted here.
 */
function rankPlaces(places: MergedPlace[], query: string): MergedPlace[] {
  const exact = places.filter(place => place.names.includes(query));
  const pool = exact.length > 0 ? exact : places;
  return [...pool].sort((a, b) => b.population - a.population || a.order - b.order);
}

/**
 * Names the evidence behind the refusal so the caller can act on it. Listing candidates
 * without saying why none of them was trusted reads as an arbitrary rejection.
 */
function strictRefusal(location: string, top: MergedPlace, ranked: MergedPlace[]): string {
  const reason = top.featureCode === undefined
    ? 'the best match carries no feature classification'
    : top.featureCode.startsWith(POPULATED_PLACE_PREFIX)
      ? `the best match is a ${top.featureCode} with population ${top.population}`
      : `the best match is a ${top.featureCode} record, not an inhabited place`;
  const options = ranked.slice(0, MAX_ALTERNATIVES + 1).map(place => label(place.candidate)).join(' / ');
  return `Refusing to guess a location for "${location}": ${reason} (${label(top.candidate)}). `
    + `Pass locationQuery with the English or local spelling to search again, or name one of: ${options}`;
}
