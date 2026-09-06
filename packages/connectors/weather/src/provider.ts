import { ProtocolError } from '@personal-agent/contracts';

export type WeatherUnits = 'metric' | 'imperial';

export interface ForecastRequest {
  location: string;
  date: string;
  units: WeatherUnits;
}

export interface ForecastFetch {
  summary: string;
  temperatureMin: number;
  temperatureMax: number;
  precipitationProbability: number;
  publishedAt: string;
}

export interface WeatherProvider {
  readonly source: string;
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
    };
  }
}
