import { ProtocolError } from '@personal-agent/contracts';
import type { RegisteredTool, ToolDescriptor, ToolHost } from '@personal-agent/contracts';
import { CalendarConnector, CALENDAR_CONNECTOR_VERSION } from './connector.js';
import { CalendarService } from './service.js';
import type { CalendarWindow } from './provider.js';
import type { CalendarProvider } from './provider.js';

export { CalendarConnector, CALENDAR_CONNECTOR_VERSION } from './connector.js';
export { CalendarService, eventToItem } from './service.js';
export { FakeCalendarProvider, defaultCalendarFixtures } from './fake-provider.js';
export type { CalendarEventRecord, CalendarFetchPage, CalendarProvider, CalendarRespondInput, CalendarRespondResult, CalendarSummary, CalendarWindow } from './provider.js';
export type { CalendarServiceOptions, EventPage } from './service.js';

const PROTOCOL_ID = 'https://personalagent.local/protocol/1.0.0';
const UTC_PATTERN_STRING = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{3})?Z$';

const eventsInputSchema: ToolDescriptor['inputSchema'] = {
  type: 'object',
  description: '按时间窗读取日历事件。缺省窗口为当前时刻起的 defaultWindowDays 天（默认 7）。窗口以 UTC 瞬间给出；返回条目的 validFor 承载 [start, end) UTC 区间，contentRef 含目标时区的本地墙上时间。',
  properties: {
    fromUtc: {type: 'string', pattern: UTC_PATTERN_STRING, description: '窗口起点（含）。缺省为当前时刻。'},
    toUtc: {type: 'string', pattern: UTC_PATTERN_STRING, description: '窗口终点（不含）。缺省为起点 + defaultWindowDays 天。'},
    limit: {type: 'integer', minimum: 1, maximum: 100, description: '单页条数上限，默认 20。'},
    cursor: {type: 'string', minLength: 1, description: '上一页返回的 nextCursor；空字符串表示没有更多页。'},
  },
  additionalProperties: false,
};

const eventsOutputSchema: ToolDescriptor['outputSchema'] = {
  type: 'object',
  required: ['items', 'window', 'hasMore', 'nextCursor'],
  additionalProperties: false,
  properties: {
    items: {type: 'array', items: {$ref: `${PROTOCOL_ID}#/definitions/ConnectorItem`}},
    window: {
      type: 'object',
      required: ['fromUtc', 'toUtc'],
      additionalProperties: false,
      properties: {
        fromUtc: {type: 'string', pattern: UTC_PATTERN_STRING},
        toUtc: {type: 'string', pattern: UTC_PATTERN_STRING},
      },
    },
    hasMore: {type: 'boolean'},
    nextCursor: {type: 'string'},
  },
};

export interface CalendarModuleOptions {
  provider: CalendarProvider;
  accountRef?: string;
  now?: () => number;
  defaultWindowDays?: number;
}

export function register(host: ToolHost, options: CalendarModuleOptions): () => void {
  if (!options?.provider) throw new ProtocolError('INVALID_ARGUMENT', 'Calendar provider must be explicitly configured; fake providers are test-only');
  const accountRef = options.accountRef ?? 'local';
  const service = new CalendarService(options.provider, {now: options.now ?? Date.now});
  const connectorOptions: {defaultWindowDays?: number} = {};
  if (options.defaultWindowDays !== undefined) connectorOptions.defaultWindowDays = options.defaultWindowDays;
  const connector = new CalendarConnector(service, CALENDAR_CONNECTOR_VERSION, connectorOptions);
  connector.connect();

  const tool: RegisteredTool = {
    descriptor: {
      name: 'calendar.events',
      version: CALENDAR_CONNECTOR_VERSION,
      inputSchema: eventsInputSchema,
      outputSchema: eventsOutputSchema,
      sideEffect: 'read',
      requiredScopes: ['calendar:read'],
      idempotencySupport: true,
      recoverySupport: true,
      requiresPresence: false,
    },
    execute: async (input: unknown) => {
      const raw = input as {fromUtc?: string; toUtc?: string; limit?: number; cursor?: string};
      const window = resolveWindow(raw, options.defaultWindowDays ?? 7, options.now ?? Date.now);
      const listArgs: {cursor?: string; limit?: number} = {};
      if (typeof raw.cursor === 'string' && raw.cursor.length > 0) listArgs.cursor = cursorToOffset(raw.cursor);
      if (raw.limit !== undefined) listArgs.limit = raw.limit;
      const page = service.listEvents(accountRef, window, listArgs);
      return {
        items: page.items,
        window: page.window,
        hasMore: page.hasMore,
        nextCursor: page.hasMore ? encodePageCursor(page.window.fromUtc, page.window.toUtc, Number(page.nextCursor)) : '',
      };
    },
  };

  const unregister = host.register(tool);
  return () => {
    unregister();
    connector.disconnect();
  };
}

function resolveWindow(raw: {fromUtc?: string; toUtc?: string}, defaultWindowDays: number, now: () => number): CalendarWindow {
  const fromMs = raw.fromUtc === undefined ? now() : Date.parse(raw.fromUtc);
  const toMs = raw.toUtc === undefined ? fromMs + defaultWindowDays * 24 * 60 * 60 * 1000 : Date.parse(raw.toUtc);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    throw new ProtocolError('INVALID_ARGUMENT', 'Window must be a valid ascending UTC interval');
  }
  return {fromUtc: `${new Date(fromMs).toISOString().slice(0, 19)}.000Z`, toUtc: `${new Date(toMs).toISOString().slice(0, 19)}.000Z`};
}

interface PageCursor {
  fromUtc: string;
  toUtc: string;
  offset: number;
}

function encodePageCursor(fromUtc: string, toUtc: string, offset: number): string {
  return Buffer.from(JSON.stringify({fromUtc, toUtc, offset} satisfies PageCursor), 'utf8').toString('base64url');
}

function cursorToOffset(cursor: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new ProtocolError('INVALID_ARGUMENT', 'cursor is malformed');
  }
  const record = parsed as {offset?: unknown};
  if (parsed === null || typeof parsed !== 'object' || !Number.isSafeInteger(record.offset) || (record.offset as number) < 0) {
    throw new ProtocolError('INVALID_ARGUMENT', 'cursor is malformed');
  }
  return String(record.offset);
}

export type {ToolDescriptor};
