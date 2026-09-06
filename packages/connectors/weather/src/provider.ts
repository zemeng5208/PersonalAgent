import { ProtocolError } from '@personal-agent/contracts';

export type WeatherUnits = 'metric' | 'imperial';

/**
 * `coverage_start` means the provider exposed no issuance timestamp, so `publishedAt`
 * is the start of the covered local day rather than a real publish instant.
 */
export type PublishedTimeKind = 'provider_published' | 'coverage_start';

/**
 * `low` means the best match is a small same-name place or a non-city record, so the
 * intended location was probably not found. It is a verdict on the match, not on the
 * weather data, and it is deliberately not corrected in place.
 */
export type PlaceConfidence = 'high' | 'low';

export interface ResolvedPlace {
  name: string;
  admin1?: string;
  country?: string;
  latitude: number;
  longitude: number;
  timezone: string;
  ambiguous: boolean;
  alternatives: string[];
  confidence: PlaceConfidence;
  /** GeoNames feature class behind `confidence`, disclosed so the verdict is auditable. */
  featureCode?: string;
}

export interface ForecastRequest {
  location: string;
  date: string;
  units: WeatherUnits;
  /**
   * Latin or local-script spelling used only to search when `location` matched nothing
   * usable. The geocoding index never matches across scripts, so a Chinese `location`
   * needs this to reach the intended foreign city.
   */
  locationQuery?: string;
}

export interface ForecastFetch {
  summary: string;
  temperatureMin: number;
  temperatureMax: number;
  precipitationProbability: number | null;
  publishedAt: string;
  publishedTimeKind: PublishedTimeKind;
  coverage?: {start: string; end: string};
  resolved?: ResolvedPlace;
}

export interface WeatherProvider {
  readonly source: string;
  readonly verification: 'mock' | 'verified' | 'conditional';
  fetchForecast(request: ForecastRequest, signal: AbortSignal): Promise<ForecastFetch>;
}

export interface FixtureForecast {
  location: string;
  date: string;
  summary: string;
  temperatureMinC: number;
  temperatureMaxC: number;
  precipitationProbability: number;
  publishedAt: string;
}

export const defaultWeatherFixtures: FixtureForecast[] = [
  {location: 'Beijing', date: '2026-09-05', summary: '晴转多云', temperatureMinC: 18, temperatureMaxC: 28, precipitationProbability: 10, publishedAt: '2026-09-05T08:30:00.000Z'},
  {location: 'Beijing', date: '2026-09-06', summary: '多云，午后局部阵雨', temperatureMinC: 17, temperatureMaxC: 26, precipitationProbability: 40, publishedAt: '2026-09-05T08:30:00.000Z'},
  {location: 'Shanghai', date: '2026-09-05', summary: '多云', temperatureMinC: 23, temperatureMaxC: 30, precipitationProbability: 20, publishedAt: '2026-09-05T08:30:00.000Z'},
  {location: 'Hangzhou', date: '2026-09-05', summary: '小雨', temperatureMinC: 22, temperatureMaxC: 27, precipitationProbability: 70, publishedAt: '2026-09-05T08:30:00.000Z'},
];

const toFahrenheit = (celsius: number): number => Math.round((celsius * 9 / 5 + 32) * 10) / 10;

export class FakeWeatherProvider implements WeatherProvider {
  readonly source = 'fixture-weather';
  readonly verification = 'mock' as const;
  private calls = 0;
  private failure: ProtocolError | null = null;
  constructor(private readonly fixtures: FixtureForecast[] = defaultWeatherFixtures) {}
  get fetchCalls(): number { return this.calls; }
  setFailure(error: ProtocolError | null): void { this.failure = error; }
  async fetchForecast(request: ForecastRequest): Promise<ForecastFetch> {
    this.calls++;
    if (this.failure) throw this.failure;
    const fixture = this.fixtures.find(item => item.location === request.location && item.date === request.date);
    if (!fixture) throw new ProtocolError('NOT_FOUND', `Fixture has no forecast for ${request.location} on ${request.date}`);
    return {
      summary: fixture.summary,
      temperatureMin: request.units === 'imperial' ? toFahrenheit(fixture.temperatureMinC) : fixture.temperatureMinC,
      temperatureMax: request.units === 'imperial' ? toFahrenheit(fixture.temperatureMaxC) : fixture.temperatureMaxC,
      precipitationProbability: fixture.precipitationProbability,
      publishedAt: fixture.publishedAt,
      publishedTimeKind: 'provider_published',
    };
  }
}
