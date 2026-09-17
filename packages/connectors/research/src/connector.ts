import { ProtocolError } from '@personal-agent/contracts';
import type { ConnectorManifest, ConnectorPort, ProtocolContracts } from '@personal-agent/contracts';
import type { ResearchService } from './service.js';

export const RESEARCH_CONNECTOR_VERSION = '0.1.0-alpha.1';

export class ResearchConnector implements ConnectorPort {
  readonly manifest: ConnectorManifest;
  private connected = false;

  constructor(private readonly service: ResearchService, version: string = RESEARCH_CONNECTOR_VERSION) {
    this.manifest = {
      id: 'research',
      version,
      accountTypes: ['openalex'],
      capabilities: ['search'],
      configSchema: {
        type: 'object',
        properties: {
          maxAgeMs: {
            type: 'integer',
            minimum: 3_600_000,
            description: '材料时效窗口（毫秒）：发布时间早于 now-maxAgeMs 记 freshness stale（仍返回，由消费方取舍）。默认 365 天。',
          },
          cacheTtlMs: {
            type: 'integer',
            minimum: 1,
            description: '提供商结果缓存 TTL（毫秒）。缓存过期或提供商失败时回退 stale 并披露 lastError，不用旧结果冒充新结果。默认 10 分钟。',
          },
        },
        additionalProperties: false,
      },
      authentication: 'none',
      requiresPresence: false,
      syncStrategy: 'on-demand',
      verification: this.service.providerVerification(),
    };
  }

  connect(): {sessionRef: string; interactionRequired: boolean} {
    this.connected = true;
    return {sessionRef: 'research', interactionRequired: false};
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
    throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'Research is fetched on demand, not incrementally synced');
  }

  async search(accountRef: string, query: string): Promise<ProtocolContracts['connectorItem'][]> {
    this.assertConnected();
    const result = await this.service.search(accountRef, query, {});
    return result.results.map(entry => entry.record);
  }

  async getItem(): Promise<ProtocolContracts['connectorItem']> {
    this.assertConnected();
    throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'Research materials are addressed by re-running the search, not by stable item id');
  }

  async performAction(): Promise<ProtocolContracts['connectorAction']> {
    this.assertConnected();
    throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'Research is read-only');
  }

  private assertConnected(): void {
    if (!this.connected) throw new ProtocolError('UNAUTHORIZED', 'Research connector is not connected');
  }
}
