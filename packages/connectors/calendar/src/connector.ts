import { ProtocolError } from '@personal-agent/contracts';
import type { ConnectorManifest, ConnectorPort, ProtocolContracts } from '@personal-agent/contracts';
import type { CalendarService } from './service.js';
import type { CalendarWindow } from './provider.js';

export const CALENDAR_CONNECTOR_VERSION = '0.1.0-alpha.1';

interface WindowCursor {
  fromUtc: string;
  toUtc: string;
  offset: number;
}

export interface CalendarConnectorOptions {
  defaultWindowDays?: number;
  now?: () => number;
}

export class CalendarConnector implements ConnectorPort {
  readonly manifest: ConnectorManifest;
  private connected = false;
  private readonly defaultWindowDays: number;
  private readonly now: () => number;

  constructor(
    private readonly service: CalendarService,
    version: string = CALENDAR_CONNECTOR_VERSION,
    options: CalendarConnectorOptions = {},
  ) {
    this.defaultWindowDays = options.defaultWindowDays ?? 7;
    this.now = options.now ?? Date.now;
    this.manifest = {
      id: 'calendar',
      version,
      accountTypes: ['fixture'],
      capabilities: ['fetchChanges', 'search', 'getItem', 'performAction'],
      configSchema: {
        type: 'object',
        properties: {
          defaultWindowDays: {type: 'integer', minimum: 1, maximum: 31, description: '无游标时的默认同步窗口天数（自当前时刻起）。'},
        },
        additionalProperties: false,
      },
      authentication: 'none',
      requiresPresence: false,
      syncStrategy: 'windowed',
      verification: this.service.providerVerification,
    };
  }

  connect(): {sessionRef: string; interactionRequired: boolean} {
    this.connected = true;
    return {sessionRef: 'calendar', interactionRequired: false};
  }

  disconnect(): {disconnected: boolean; cleanupState: string} {
    this.connected = false;
    return {disconnected: true, cleanupState: 'complete'};
  }

  getCapabilities(): string[] {
    return [...this.manifest.capabilities];
  }

  health(): {state: 'disconnected' | 'ready' | 'degraded'} {
    return {state: this.connected ? 'ready' : 'disconnected'};
  }

  fetchChanges(input: {accountRef: string; cursor?: string; limit: number}): {items: ProtocolContracts['connectorItem'][]; nextCursor: string; hasMore: boolean} {
    this.assertConnected();
    if (!Number.isSafeInteger(input.limit) || input.limit < 1) throw new ProtocolError('INVALID_ARGUMENT', 'limit must be a positive integer');
    const window: CalendarWindow = input.cursor === undefined ? this.defaultWindow() : decodeCursor(input.cursor);
    const listArgs: {cursor?: string; limit: number} = {limit: input.limit};
    const offset = offsetOf(input.cursor);
    if (offset !== undefined) listArgs.cursor = offset;
    const page = this.service.listEvents(input.accountRef, window, listArgs);
    const nextCursor = page.hasMore
      ? encodeCursor({fromUtc: window.fromUtc, toUtc: window.toUtc, offset: Number(page.nextCursor)})
      : '';
    return {items: page.items, nextCursor, hasMore: page.hasMore};
  }

  search(accountRef: string, query: string): ProtocolContracts['connectorItem'][] {
    this.assertConnected();
    return this.service.searchEvents(accountRef, query);
  }

  getItem(accountRef: string, id: string): ProtocolContracts['connectorItem'] {
    this.assertConnected();
    return this.service.getEventItem(accountRef, id);
  }

  performAction(input: {accountRef: string; action: string; input: unknown; idempotencyKey: string}): ProtocolContracts['connectorAction'] {
    this.assertConnected();
    if (input.action !== 'respond') {
      throw new ProtocolError('UNSUPPORTED_CAPABILITY', `Calendar action ${input.action} is not supported`);
    }
    const raw = input.input as {externalId?: unknown; response?: unknown};
    if (typeof raw?.externalId !== 'string' || typeof raw?.response !== 'string') {
      throw new ProtocolError('INVALID_ARGUMENT', 'respond requires externalId and response');
    }
    return this.service.respond({
      accountRef: input.accountRef,
      externalId: raw.externalId,
      response: raw.response as 'accepted' | 'declined' | 'tentative',
      idempotencyKey: input.idempotencyKey,
    });
  }

  private defaultWindow(): CalendarWindow {
    const now = new Date(this.now());
    const to = new Date(now.getTime() + this.defaultWindowDays * 24 * 60 * 60 * 1000);
    return {fromUtc: isoMinute(now), toUtc: isoMinute(to)};
  }

  private assertConnected(): void {
    if (!this.connected) throw new ProtocolError('UNAUTHORIZED', 'Calendar connector is not connected');
  }
}

function isoMinute(value: Date): string {
  return `${value.toISOString().slice(0, 19)}.000Z`;
}

function encodeCursor(cursor: WindowCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): WindowCursor {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as WindowCursor;
    if (typeof parsed.fromUtc !== 'string' || typeof parsed.toUtc !== 'string' || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0) {
      throw new Error('malformed');
    }
    return parsed;
  } catch {
    throw new ProtocolError('CURSOR_EXPIRED', 'Calendar cursor is malformed');
  }
}

function offsetOf(cursor: string | undefined): string | undefined {
  if (cursor === undefined) return undefined;
  return String(decodeCursor(cursor).offset);
}
