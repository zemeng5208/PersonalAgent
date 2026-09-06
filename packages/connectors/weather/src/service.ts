import { ProtocolError, validateContract } from '@personal-agent/contracts';
import type { ProtocolContracts } from '@personal-agent/contracts';
import type { ForecastFetch, WeatherProvider, WeatherUnits } from './provider.js';

export type WeatherRecord = ProtocolContracts['connectorItem'];

export interface WeatherQuery {
  location?: string;
  date?: string;
  units?: WeatherUnits;
}

export interface ForecastPayload {
  location: string;
  date: string;
  units: WeatherUnits;
  summary: string;
  temperatureMin: number;
  temperatureMax: number;
  precipitationProbability: number;
}

export interface CacheState {
  state: 'fresh' | 'fetched' | 'stale';
  fetchedAt: string;
  ageMs: number;
  ttlMs: number;
  lastError?: { code: string; message: string; retryable: boolean; retryAfterMs?: number };
}

export interface WeatherResult {
  record: WeatherRecord;
  forecast: ForecastPayload;
  cache: CacheState;
}

export interface WeatherServiceOptions {
  provider: WeatherProvider;
  now: () => number;
  defaultLocation?: string;
  cacheTtlMs?: number;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_TTL_MS = 600_000;
const UNITS: readonly WeatherUnits[] = ['metric', 'imperial'];
const STALE_FALLBACK_ERRORS = new Set(['RATE_LIMITED', 'TIMEOUT', 'EXTERNAL_FAILURE']);

const isValidDate = (date: string): boolean => {
  if (!DATE_PATTERN.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
};

const nextUtcDate = (date: string): string => new Date(Date.parse(`${date}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);

interface CacheEntry {
  record: WeatherRecord;
  forecast: ForecastPayload;
  fetchedAtMs: number;
}

export class WeatherService {
  private readonly ttlMs: number;
  private readonly defaultLocation: string | undefined;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly options: WeatherServiceOptions) {
    this.ttlMs = options.cacheTtlMs ?? DEFAULT_TTL_MS;
    if (!Number.isFinite(this.ttlMs) || this.ttlMs < 1) throw new Error('Invalid cache TTL');
    this.defaultLocation = options.defaultLocation?.trim() || undefined;
  }

  async getForecast(query: WeatherQuery, signal?: AbortSignal): Promise<WeatherResult> {
    const location = (query.location ?? this.defaultLocation ?? '').trim();
    if (!location) throw new ProtocolError('INVALID_ARGUMENT', 'Weather location must come from the request or a configured default; refusing to guess');
    if (query.units !== undefined && !UNITS.includes(query.units)) throw new ProtocolError('INVALID_ARGUMENT', 'units must be metric or imperial');
    const now = this.options.now();
    const date = query.date ?? new Date(now).toISOString().slice(0, 10);
    if (!isValidDate(date)) throw new ProtocolError('INVALID_ARGUMENT', 'date must be a valid YYYY-MM-DD calendar date');
    if (signal?.aborted) throw new ProtocolError('CANCELLED', 'Weather query cancelled');
    const units: WeatherUnits = query.units ?? 'metric';

    const key = `${location}|${date}|${units}`;
    const entry = this.cache.get(key);
    if (entry && now - entry.fetchedAtMs < this.ttlMs) {
      return {record: structuredClone(entry.record), forecast: structuredClone(entry.forecast), cache: cacheState('fresh', entry, now, this.ttlMs)};
    }

    let fetch: ForecastFetch;
    try {
      fetch = await this.options.provider.fetchForecast({location, date, units}, signal ?? new AbortController().signal);
    } catch (error) {
      if (signal?.aborted) throw new ProtocolError('CANCELLED', 'Weather query cancelled');
      if (entry && error instanceof ProtocolError && STALE_FALLBACK_ERRORS.has(error.code)) {
        const stale = cacheState('stale', entry, now, this.ttlMs);
        stale.lastError = {code: error.code, message: error.message, retryable: error.retryable};
        if (error.retryAfterMs !== undefined) stale.lastError.retryAfterMs = error.retryAfterMs;
        return {record: structuredClone(entry.record), forecast: structuredClone(entry.forecast), cache: stale};
      }
      throw error;
    }

    if (signal?.aborted) throw new ProtocolError('CANCELLED', 'Weather query cancelled');
    const fetchedAtMs = this.options.now();
    const record: WeatherRecord = {
      source: this.options.provider.source,
      accountRef: 'weather',
      externalId: `${location}|${date}|${units}`,
      occurredAt: fetch.publishedAt,
      fetchedAt: new Date(fetchedAtMs).toISOString(),
      contentRef: `weather://forecast/${encodeURIComponent(location)}/${date}?units=${units}`,
      sensitivity: 'public',
      dedupeKey: `${this.options.provider.source}:${location}:${date}:${units}`,
      validFor: `${date}T00:00:00.000Z/${nextUtcDate(date)}T00:00:00.000Z`,
    };
    validateContract('connectorItem', record);
    const forecast: ForecastPayload = {location, date, units, summary: fetch.summary, temperatureMin: fetch.temperatureMin, temperatureMax: fetch.temperatureMax, precipitationProbability: fetch.precipitationProbability};
    const fresh: CacheEntry = {record, forecast, fetchedAtMs};
    this.cache.set(key, fresh);
    return {record: structuredClone(fresh.record), forecast: structuredClone(fresh.forecast), cache: cacheState('fetched', fresh, fetchedAtMs, this.ttlMs)};
  }
}

function cacheState(state: CacheState['state'], entry: CacheEntry, now: number, ttlMs: number): CacheState {
  return {state, fetchedAt: new Date(entry.fetchedAtMs).toISOString(), ageMs: Math.max(0, now - entry.fetchedAtMs), ttlMs};
}
