import { ProtocolError } from '@personal-agent/contracts';
import type { ConnectorManifest, ConnectorPort } from '@personal-agent/contracts';
import type { WeatherService } from './service.js';

export const WEATHER_CONNECTOR_VERSION = '0.1.0-alpha.1';

export class WeatherConnector implements ConnectorPort {
  readonly manifest: ConnectorManifest;
  private connected = false;

  constructor(private readonly service: WeatherService, version: string = WEATHER_CONNECTOR_VERSION) {
    this.manifest = {
      id: 'weather',
      version,
      accountTypes: [],
      capabilities: ['forecast'],
      configSchema: {
        type: 'object',
        properties: {
          defaultLocation: {type: 'string', minLength: 1},
          cacheTtlMs: {type: 'integer', minimum: 1},
          language: {type: 'string', minLength: 2},
          locationResolution: {enum: ['ranked', 'strict']},
        },
        additionalProperties: false,
      },
      authentication: 'none',
      requiresPresence: false,
      syncStrategy: 'on-demand',
      verification: service.providerVerification,
    };
  }

  connect(): {sessionRef: string; interactionRequired: boolean} {
    this.connected = true;
    return {sessionRef: 'weather', interactionRequired: false};
  }

  disconnect(): {disconnected: boolean; cleanupState: string} {
    this.connected = false;
    return {disconnected: true, cleanupState: 'complete'};
  }

  getCapabilities(): string[] {
    return [...this.manifest.capabilities];
  }

  health(): {state: 'disconnected' | 'ready'} {
    return {state: this.connected ? 'ready' : 'disconnected'};
  }

  fetchChanges(): never {
    throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'Weather is fetched on demand, not incrementally synced');
  }

  search(): never {
    throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'Weather queries need location/date/units; use the weather.forecast tool or WeatherService.getForecast');
  }

  getItem(): never {
    throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'Weather has no stable item storage');
  }

  performAction(): never {
    throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'Weather connector is read only');
  }
}
