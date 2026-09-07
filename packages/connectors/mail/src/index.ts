import { ProtocolError } from '@personal-agent/contracts';
import type { RegisteredTool, ToolDescriptor, ToolHost } from '@personal-agent/contracts';
import { MailConnector, MAIL_CONNECTOR_VERSION } from './connector.js';
import { MailService } from './service.js';
import type { MailProvider } from './provider.js';
import { decodeMailCursor } from './provider.js';

export { MailConnector, MAIL_CONNECTOR_VERSION } from './connector.js';
export { MailService, messageToItem } from './service.js';
export { FakeMailProvider, defaultMailFixtures } from './fake-provider.js';
export { QQMailProvider, messageFromImap } from './qq.js';
export type { QQMailOptions } from './qq.js';
export { decodeMailCursor, encodeMailCursor } from './provider.js';
export type {
  MailCursor, MailFetchInput, MailFolder, MailMarkSeenInput, MailMessage, MailPage,
  MailProvider, MailSendInput, MailSendResult,
} from './provider.js';

const PROTOCOL_ID = 'https://personalagent.local/protocol/1.0.0';
const UTC_PATTERN_STRING = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{3})?Z$';

const inboxInputSchema: ToolDescriptor['inputSchema'] = {
  type: 'object',
  description: '增量读取邮件（缺省收件箱）。游标取上一页返回的 nextCursor（`uidValidity:lastUid`）；uidValidity 变化返回 CURSOR_EXPIRED，需从头同步。邮件内容敏感（sensitivity: private），条目只含发件人/主题/已读状态。',
  properties: {
    cursor: {type: 'string', minLength: 1, description: '上一页的 nextCursor；空串或省略表示从头开始。'},
    limit: {type: 'integer', minimum: 1, maximum: 100, description: '单页条数上限，默认 20。'},
    folder: {type: 'string', minLength: 1, description: 'IMAP 文件夹路径，默认 INBOX。'},
  },
  additionalProperties: false,
};

const inboxOutputSchema: ToolDescriptor['outputSchema'] = {
  type: 'object',
  required: ['items', 'nextCursor', 'hasMore', 'folder'],
  additionalProperties: false,
  properties: {
    items: {type: 'array', items: {$ref: `${PROTOCOL_ID}#/definitions/ConnectorItem`}},
    nextCursor: {type: 'string'},
    hasMore: {type: 'boolean'},
    folder: {type: 'string', minLength: 1},
  },
};

void UTC_PATTERN_STRING;

export interface MailModuleOptions {
  provider: MailProvider;
  accountRef?: string;
  now?: () => number;
}

export function register(host: ToolHost, options: MailModuleOptions): () => void {
  if (!options?.provider) throw new ProtocolError('INVALID_ARGUMENT', 'Mail provider must be explicitly configured; fake providers are test-only');
  const accountRef = options.accountRef ?? 'local';
  const service = new MailService(options.provider, {now: options.now ?? Date.now});
  const connector = new MailConnector(service, MAIL_CONNECTOR_VERSION);
  connector.connect();

  const tool: RegisteredTool = {
    descriptor: {
      name: 'mail.inbox',
      version: MAIL_CONNECTOR_VERSION,
      inputSchema: inboxInputSchema,
      outputSchema: inboxOutputSchema,
      sideEffect: 'read',
      requiredScopes: ['mail:read'],
      idempotencySupport: true,
      recoverySupport: true,
      requiresPresence: false,
    },
    execute: async (input: unknown) => {
      const raw = input as {cursor?: string; limit?: number; folder?: string};
      const cursor = typeof raw.cursor === 'string' && raw.cursor.length > 0
        ? decodeMailCursor(raw.cursor)
        : undefined;
      const fetchArgs: {cursor?: ReturnType<typeof decodeMailCursor>; limit?: number; folder?: string} = {};
      if (cursor !== undefined) fetchArgs.cursor = cursor;
      if (raw.limit !== undefined) fetchArgs.limit = raw.limit;
      if (typeof raw.folder === 'string') fetchArgs.folder = raw.folder;
      return service.fetchInbox(accountRef, fetchArgs);
    },
  };

  const unregister = host.register(tool);
  return () => {
    unregister();
    connector.disconnect();
  };
}
