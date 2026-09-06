import type { RegisteredTool, ToolDescriptor, ToolHost } from '@personal-agent/contracts';
import { WeatherConnector, WEATHER_CONNECTOR_VERSION } from './connector.js';
export { WeatherConnector, WEATHER_CONNECTOR_VERSION } from './connector.js';
export { FakeWeatherProvider, defaultWeatherFixtures } from './provider.js';
export type { FixtureForecast, ForecastFetch, ForecastRequest, WeatherProvider, WeatherUnits } from './provider.js';
export { WeatherService } from './service.js';
export type { CacheState, ForecastPayload, WeatherQuery, WeatherRecord, WeatherResult, WeatherServiceOptions } from './service.js';
import { WeatherService } from './service.js';
import type { WeatherQuery, WeatherServiceOptions } from './service.js';
import { FakeWeatherProvider } from './provider.js';
import type { WeatherProvider } from './provider.js';

const PROTOCOL_ID = 'https://personalagent.local/protocol/1.0.0';

const forecastInputSchema: ToolDescriptor['inputSchema'] = {
  type: 'object',
  properties: {
    location: {type: 'string', minLength: 1},
    date: {type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$'},
    units: {enum: ['metric', 'imperial']},
  },
  additionalProperties: false,
};

const forecastOutputSchema: ToolDescriptor['outputSchema'] = {
  type: 'object',
  required: ['record', 'forecast', 'cache'],
  additionalProperties: false,
  properties: {
    record: {$ref: `${PROTOCOL_ID}#/definitions/ConnectorItem`},
    forecast: {
      type: 'object',
      required: ['location', 'date', 'units', 'summary', 'temperatureMin', 'temperatureMax', 'precipitationProbability'],
      additionalProperties: false,
      properties: {
        location: {type: 'string', minLength: 1},
        date: {type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$'},
        units: {enum: ['metric', 'imperial']},
        summary: {type: 'string', minLength: 1},
        temperatureMin: {type: 'number'},
        temperatureMax: {type: 'number'},
        precipitationProbability: {type: 'integer', minimum: 0, maximum: 100},
      },
    },
    cache: {
      type: 'object',
      required: ['state', 'fetchedAt', 'ageMs', 'ttlMs'],
      additionalProperties: false,
      properties: {
        state: {enum: ['fresh', 'fetched', 'stale']},
        fetchedAt: {type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{3})?Z$'},
        ageMs: {type: 'integer', minimum: 0},
        ttlMs: {type: 'integer', minimum: 1},
        lastError: {
          type: 'object',
          required: ['code', 'message', 'retryable'],
          additionalProperties: false,
          properties: {
            code: {type: 'string', minLength: 1},
            message: {type: 'string', minLength: 1},
            retryable: {type: 'boolean'},
          },
        },
      },
    },
  },
};

export interface WeatherModuleOptions {
  provider?: WeatherProvider;
  now?: () => number;
  defaultLocation?: string;
  cacheTtlMs?: number;
}

export function register(host: ToolHost, options: WeatherModuleOptions = {}): () => void {
  const serviceOptions: WeatherServiceOptions = {
    provider: options.provider ?? new FakeWeatherProvider(),
    now: options.now ?? Date.now,
  };
  if (options.defaultLocation !== undefined) serviceOptions.defaultLocation = options.defaultLocation;
  if (options.cacheTtlMs !== undefined) serviceOptions.cacheTtlMs = options.cacheTtlMs;
  const service = new WeatherService(serviceOptions);
  const connector = new WeatherConnector(service, WEATHER_CONNECTOR_VERSION);

  const tool: RegisteredTool = {
    descriptor: {
      name: 'weather.forecast',
      version: WEATHER_CONNECTOR_VERSION,
      inputSchema: forecastInputSchema,
      outputSchema: forecastOutputSchema,
      sideEffect: 'read',
      requiredScopes: ['weather:read'],
      idempotencySupport: true,
      recoverySupport: true,
      requiresPresence: false,
    },
    execute: async (input: unknown, context) => {
      const raw = input as {location?: string; date?: string; units?: string};
      const query: WeatherQuery = {};
      if (typeof raw.location === 'string') query.location = raw.location;
      if (typeof raw.date === 'string') query.date = raw.date;
      if (raw.units === 'metric' || raw.units === 'imperial') query.units = raw.units;
      return service.getForecast(query, context.signal);
    },
  };

  const unregister = host.register(tool);
  return () => {
    unregister();
    connector.disconnect();
  };
}
