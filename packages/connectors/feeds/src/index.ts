import { ProtocolError } from '@personal-agent/contracts';
import type { RegisteredTool, ToolDescriptor, ToolHost } from '@personal-agent/contracts';
import { FeedsConnector, FEEDS_CONNECTOR_VERSION } from './connector.js';
export { FeedsConnector, FEEDS_CONNECTOR_VERSION } from './connector.js';
export { FakeFeedProvider, defaultFeedFixtures } from './provider.js';
export type { FeedFetch, FeedFetchRequest, FeedProvider, FeedVerification, FixtureFeed } from './provider.js';
export { HttpFeedProvider, MAX_BODY_BYTES, MAX_REDIRECTS } from './http-feed.js';
export type { FeedFetchLike, FeedBodyReader, FeedResponseLike, HttpFeedOptions } from './http-feed.js';
export { parseFeedDocument, decodeXmlEntities, toPlainText, MAX_BODY_CHARS, SUMMARY_LIMIT } from './parser.js';
export type { FeedDocument, FeedEntryText } from './parser.js';
export { parseFeedDate } from './dates.js';
export { makeContentRedactor, makeErrorRedactor, secretNeedles } from './redact.js';
export { decodeCursor, encodeCursor, appendSeen, emptyCursor, CURSOR_VERSION, SEEN_LIMIT, MAX_CURSOR_CHARS } from './cursor.js';
export type { CursorState } from './cursor.js';
export { FeedService, DEFAULT_LIMIT, MAX_LIMIT } from './service.js';
export type { CollectedItem, CollectQuery, CollectResult, CollectionState, DedupeKeyKind, FeedRecord, FeedServiceOptions, FeedSubscription, OccurredAtKind, SkipReason } from './service.js';
import { FeedService, MAX_LIMIT } from './service.js';
import type { CollectQuery, FeedServiceOptions, FeedSubscription } from './service.js';
import type { FeedProvider } from './provider.js';

const PROTOCOL_ID = 'https://personalagent.local/protocol/1.0.0';
const TIMESTAMP = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{3})?Z$';

const collectInputSchema: ToolDescriptor['inputSchema'] = {
  type: 'object',
  required: ['subscriptionId'],
  properties: {
    subscriptionId: {type: 'string', minLength: 1},
    cursor: {type: 'string', minLength: 1, maxLength: 64_000},
    limit: {type: 'integer', minimum: 1, maximum: MAX_LIMIT},
  },
  additionalProperties: false,
};

const collectionSchema: ToolDescriptor['outputSchema'] = {
  type: 'object',
  required: ['state', 'subscriptionId', 'fetchedAt', 'feedTitle', 'feedKind', 'parsedItemCount', 'deliveredCount', 'alreadySeenCount', 'conditional', 'validators', 'skipped'],
  additionalProperties: false,
  properties: {
    state: {enum: ['fetched', 'unchanged']},
    subscriptionId: {type: 'string', minLength: 1},
    fetchedAt: {type: 'string', pattern: TIMESTAMP},
    feedTitle: {type: ['string', 'null']},
    feedKind: {enum: ['rss', 'atom', null]},
    parsedItemCount: {type: 'integer', minimum: 0},
    deliveredCount: {type: 'integer', minimum: 0},
    alreadySeenCount: {type: 'integer', minimum: 0},
    conditional: {type: 'boolean'},
    validators: {
      type: 'object',
      required: ['etag', 'lastModified'],
      additionalProperties: false,
      properties: {etag: {type: ['string', 'null']}, lastModified: {type: ['string', 'null']}},
    },
    skipped: {
      type: 'array',
      items: {
        type: 'object',
        required: ['index', 'reason'],
        additionalProperties: false,
        properties: {
          index: {type: 'integer', minimum: 0},
          reason: {enum: ['no_identifier', 'no_occurred_at', 'no_identifier_and_no_occurred_at']},
        },
      },
    },
  },
};

const collectOutputSchema: ToolDescriptor['outputSchema'] = {
  type: 'object',
  required: ['items', 'collection', 'nextCursor', 'hasMore'],
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      maxItems: MAX_LIMIT,
      items: {
        type: 'object',
        required: ['record', 'title', 'dedupeKeyKind', 'occurredAtKind', 'summary'],
        additionalProperties: false,
        properties: {
          // Provenance is reported next to the record rather than inside it: `ConnectorItem` has
          // `additionalProperties: false` and is owned by the contracts module.
          record: {$ref: `${PROTOCOL_ID}#/definitions/ConnectorItem`},
          title: {type: 'string'},
          dedupeKeyKind: {enum: ['item_guid', 'item_link', 'content_hash']},
          occurredAtKind: {enum: ['item_published', 'item_updated', 'feed_build']},
          summary: {type: 'string'},
        },
      },
    },
    collection: collectionSchema,
    nextCursor: {type: 'string'},
    hasMore: {type: 'boolean'},
  },
};

const subscriptionsOutputSchema: ToolDescriptor['outputSchema'] = {
  type: 'object',
  required: ['subscriptions'],
  additionalProperties: false,
  properties: {
    subscriptions: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['id', 'title', 'sensitivity'],
        additionalProperties: false,
        properties: {
          id: {type: 'string', minLength: 1},
          title: {type: 'string', minLength: 1},
          sensitivity: {type: 'string', minLength: 1},
        },
      },
    },
  },
};

export interface FeedsModuleOptions {
  provider: FeedProvider;
  subscriptions: FeedSubscription[];
  now?: () => number;
  defaultLimit?: number;
}

/**
 * Registers the read-only feed tools.
 *
 * Subscriptions are configuration, never tool arguments. A model-selectable feed URL would be an
 * SSRF entry point, and a configured URL may carry a token, which must not end up in records, tool
 * output, error messages or logs. `feeds.subscriptions` therefore returns ids and titles only.
 */
export function register(host: ToolHost, options: FeedsModuleOptions): () => void {
  if (!options?.provider) {
    throw new ProtocolError('INVALID_ARGUMENT', 'Feed provider must be explicitly configured; nothing that issues outbound requests is constructed by default', false);
  }
  if (!Array.isArray(options.subscriptions)) {
    throw new ProtocolError('INVALID_ARGUMENT', 'Feed subscriptions must be an explicitly configured list; a feed URL is never taken from a tool argument', false);
  }
  const serviceOptions: FeedServiceOptions = {
    provider: options.provider,
    subscriptions: options.subscriptions,
    now: options.now ?? Date.now,
  };
  if (options.defaultLimit !== undefined) serviceOptions.defaultLimit = options.defaultLimit;
  const service = new FeedService(serviceOptions);
  const connector = new FeedsConnector(service, FEEDS_CONNECTOR_VERSION);

  const collectTool: RegisteredTool = {
    descriptor: {
      name: 'feeds.collect',
      version: FEEDS_CONNECTOR_VERSION,
      inputSchema: collectInputSchema,
      outputSchema: collectOutputSchema,
      sideEffect: 'read',
      requiredScopes: ['feeds:read'],
      idempotencySupport: true,
      recoverySupport: true,
      requiresPresence: false,
    },
    execute: async (input: unknown, context) => {
      const raw = input as {subscriptionId?: unknown; cursor?: unknown; limit?: unknown};
      if (typeof raw.subscriptionId !== 'string' || raw.subscriptionId === '') {
        throw new ProtocolError('INVALID_ARGUMENT', 'subscriptionId must name a configured feed subscription', false);
      }
      const query: CollectQuery = {subscriptionId: raw.subscriptionId};
      if (typeof raw.cursor === 'string') query.cursor = raw.cursor;
      if (typeof raw.limit === 'number') query.limit = raw.limit;
      return service.collect(query, context.signal);
    },
  };

  const subscriptionsTool: RegisteredTool = {
    descriptor: {
      name: 'feeds.subscriptions',
      version: FEEDS_CONNECTOR_VERSION,
      inputSchema: {type: 'object', properties: {}, additionalProperties: false},
      outputSchema: subscriptionsOutputSchema,
      sideEffect: 'read',
      requiredScopes: ['feeds:read'],
      idempotencySupport: true,
      recoverySupport: true,
      requiresPresence: false,
    },
    execute: async () => ({subscriptions: service.listSubscriptions()}),
  };

  const unregisterCollect = host.register(collectTool);
  const unregisterSubscriptions = host.register(subscriptionsTool);
  return () => {
    unregisterCollect();
    unregisterSubscriptions();
    connector.disconnect();
  };
}
