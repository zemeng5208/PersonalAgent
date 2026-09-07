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
          minCorroboratedPopulation: {
            type: 'integer',
            minimum: 0,
            description: '人口下限：非行政中心的地点低于此值时 resolved.confidence 记为 low。默认 500000，取自 2026-09-06 实测空档（最差误解析伦敦/安大略 422324 ↔ 正确的非行政中心大城市纽约 8804190）。',
          },
          geonamesUsername: {
            type: 'string',
            minLength: 1,
            description: 'GeoNames 官方 API 账号（geonames.org 免费注册，日 3 万次额度）。配置后汉字地名增加 name_equals 精确名检索层，简体外国城市名（纽约/首尔/开罗/胡志明市等）不再依赖残缺的繁体 zh 索引。该层任何失败都降级为仅 Open-Meteo。建议由装配层从环境变量（如 PA_GEONAMES_USERNAME）注入，不要写入仓库或前端快照。',
          },
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
