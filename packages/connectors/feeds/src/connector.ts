import { ProtocolError } from '@personal-agent/contracts';
import type { ConnectorManifest, ConnectorPort, ProtocolContracts } from '@personal-agent/contracts';
import type { CollectQuery, FeedService } from './service.js';
import { MAX_LIMIT } from './service.js';

export const FEEDS_CONNECTOR_VERSION = '0.1.0-alpha.1';

export class FeedsConnector implements ConnectorPort {
  readonly manifest: ConnectorManifest;
  private connected = false;

  constructor(private readonly service: FeedService, version: string = FEEDS_CONNECTOR_VERSION) {
    this.manifest = {
      id: 'feeds',
      version,
      accountTypes: [],
      capabilities: ['collect'],
      configSchema: {
        type: 'object',
        required: ['subscriptions'],
        properties: {
          subscriptions: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: ['id', 'url'],
              additionalProperties: false,
              properties: {
                id: {type: 'string', minLength: 1},
                url: {type: 'string', minLength: 1},
                title: {type: 'string', minLength: 1},
                sensitivity: {type: 'string', minLength: 1},
              },
            },
          },
          defaultLimit: {type: 'integer', minimum: 1, maximum: MAX_LIMIT},
        },
        additionalProperties: false,
      },
      authentication: 'none',
      requiresPresence: false,
      syncStrategy: 'poll',
      verification: service.providerVerification,
    };
  }

  connect(): {sessionRef: string; interactionRequired: boolean} {
    this.connected = true;
    return {sessionRef: 'feeds', interactionRequired: false};
  }

  disconnect(): {disconnected: boolean; cleanupState: string} {
    this.connected = false;
    return {disconnected: true, cleanupState: 'complete'};
  }

  getCapabilities(): string[] {
    return [...this.manifest.capabilities];
  }

  /**
   * Returns `{state}` only. `DEVELOPMENT_PROTOCOL.md` asks health to carry the last success time
   * and a redacted reason, but `ConnectorPort.health` types the return as `{state}`, so adding
   * either field means changing a contract this module does not own. The gap is recorded in the
   * README and in the PR rather than papered over with an untyped extra property.
   */
  health(): {state: 'disconnected' | 'ready'} {
    return {state: this.connected ? 'ready' : 'disconnected'};
  }

  /**
   * `accountRef` is the configured subscription id. The envelope the `feeds.collect` tool returns
   * carries `dedupeKeyKind`, `occurredAtKind` and `summary` per item; `ConnectorItem` has
   * `additionalProperties: false`, so this port necessarily yields the record alone and a consumer
   * that wants body text follows `contentRef`.
   *
   * `ConnectorPort.fetchChanges` takes no `AbortSignal`, so a host cannot cancel an in-flight
   * collection through this path. Use the tool when cancellation matters.
   */
  fetchChanges(input: {accountRef: string; cursor?: string; limit: number}): Promise<{items: ProtocolContracts['connectorItem'][]; nextCursor: string; hasMore: boolean}> {
    const query: CollectQuery = {subscriptionId: input.accountRef, limit: input.limit};
    if (input.cursor !== undefined) query.cursor = input.cursor;
    return this.service.collect(query).then(result => ({
      items: result.items.map(item => item.record),
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    }));
  }

  getItem(accountRef: string, id: string): Promise<ProtocolContracts['connectorItem']> {
    return this.service.findItem(accountRef, id).then(item => item.record);
  }

  search(): never {
    throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'Feed collection is incremental by subscription id and cursor; there is no full-text search over a source', false);
  }

  performAction(): never {
    throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'The feeds connector is read only', false);
  }
}
