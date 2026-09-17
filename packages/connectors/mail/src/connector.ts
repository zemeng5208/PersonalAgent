import { ProtocolError } from '@personal-agent/contracts';
import type { ConnectorManifest, ConnectorPort, ProtocolContracts } from '@personal-agent/contracts';
import type { MailService } from './service.js';
import type { MailCursor } from './provider.js';
import { decodeMailCursor } from './provider.js';

export const MAIL_CONNECTOR_VERSION = '0.1.0-alpha.1';

export class MailConnector implements ConnectorPort {
  readonly manifest: ConnectorManifest;
  private connected = false;

  constructor(private readonly service: MailService, version: string = MAIL_CONNECTOR_VERSION) {
    this.manifest = {
      id: 'mail',
      version,
      accountTypes: ['qq'],
      capabilities: ['fetchChanges', 'search', 'getItem', 'performAction'],
      configSchema: {
        type: 'object',
        properties: {
          defaultFolder: {type: 'string', minLength: 1, description: '缺省文件夹路径，默认 INBOX。'},
          defaultLimit: {type: 'integer', minimum: 1, maximum: 100, description: '单页条数上限，默认 20。'},
          sendTimeoutMs: {type: 'integer', minimum: 1000, description: '发送超时毫秒数；超时结果为 unknown（先核对结果），默认 30000。'},
        },
        additionalProperties: false,
      },
      authentication: 'password',
      requiresPresence: false,
      syncStrategy: 'incremental',
      verification: this.service.providerVerification(),
    };
  }

  connect(): {sessionRef: string; interactionRequired: boolean} {
    this.connected = true;
    return {sessionRef: 'mail', interactionRequired: false};
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

  async fetchChanges(input: {accountRef: string; cursor?: string; limit: number}): Promise<{items: ProtocolContracts['connectorItem'][]; nextCursor: string; hasMore: boolean}> {
    this.assertConnected();
    if (!Number.isSafeInteger(input.limit) || input.limit < 1) throw new ProtocolError('INVALID_ARGUMENT', 'limit must be a positive integer');
    const cursor = input.cursor === undefined || input.cursor === '' ? undefined : decodeMailCursor(input.cursor);
    const fetchArgs: {cursor?: MailCursor; limit: number} = {limit: input.limit};
    if (cursor !== undefined) fetchArgs.cursor = cursor;
    const page = await this.service.fetchInbox(input.accountRef, fetchArgs);
    return {items: page.items, nextCursor: page.nextCursor, hasMore: page.hasMore};
  }

  async search(accountRef: string, query: string): Promise<ProtocolContracts['connectorItem'][]> {
    this.assertConnected();
    return (await this.service.search(accountRef, query, {})).items;
  }

  async getItem(accountRef: string, id: string): Promise<ProtocolContracts['connectorItem']> {
    this.assertConnected();
    const match = /^([^:]+):(\d+)$/.exec(id);
    if (match === null) throw new ProtocolError('INVALID_ARGUMENT', 'Mail item id must be folder:uid');
    const folder = match[1] ?? '';
    const uid = Number(match[2]);
    if (folder.length === 0 || !Number.isSafeInteger(uid) || uid < 1) throw new ProtocolError('INVALID_ARGUMENT', 'Mail item id must be folder:uid');
    return this.service.getItem(accountRef, folder, uid);
  }

  async performAction(input: {accountRef: string; action: string; input: unknown; idempotencyKey: string}): Promise<ProtocolContracts['connectorAction']> {
    this.assertConnected();
    const raw = input.input as Record<string, unknown>;
    if (input.action === 'mark_seen') {
      if (typeof raw?.folder !== 'string' || !Number.isSafeInteger(raw?.uid)) {
        throw new ProtocolError('INVALID_ARGUMENT', 'mark_seen requires folder and uid');
      }
      return this.service.markSeen(input.accountRef, {folder: raw.folder as string, uid: raw.uid as number, idempotencyKey: input.idempotencyKey});
    }
    if (input.action === 'send') {
      if (typeof raw?.to !== 'string' || typeof raw?.subject !== 'string' || typeof raw?.text !== 'string') {
        throw new ProtocolError('INVALID_ARGUMENT', 'send requires to, subject and text');
      }
      const sendArgs: {to: string; subject: string; text: string; timeoutMs?: number; idempotencyKey: string} = {
        to: raw.to,
        subject: raw.subject,
        text: raw.text,
        idempotencyKey: input.idempotencyKey,
      };
      if (typeof raw.timeoutMs === 'number') sendArgs.timeoutMs = raw.timeoutMs;
      return this.service.send(input.accountRef, sendArgs);
    }
    throw new ProtocolError('UNSUPPORTED_CAPABILITY', `Mail action ${input.action} is not supported`);
  }

  private assertConnected(): void {
    if (!this.connected) throw new ProtocolError('UNAUTHORIZED', 'Mail connector is not connected');
  }
}

export type {MailCursor};
