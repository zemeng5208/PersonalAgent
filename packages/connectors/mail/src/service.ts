import { ProtocolError } from '@personal-agent/contracts';
import type { ProtocolContracts } from '@personal-agent/contracts';
import type { MailCursor, MailMessage, MailProvider, MailSendResult } from './provider.js';

type ConnectorItem = ProtocolContracts['connectorItem'];
type ConnectorAction = ProtocolContracts['connectorAction'];

export interface MailServiceOptions {
  now: () => number;
}

export interface InboxPage {
  items: ConnectorItem[];
  nextCursor: string;
  hasMore: boolean;
  folder: string;
}

/** 邮件 → ConnectorItem：occurredAt 取 Date 头（缺失回退 fetchedAt 并在 contentRef 标注），sensitivity 固定 private。 */
export function messageToItem(message: MailMessage, accountRef: string, fetchedAt: string): ConnectorItem {
  const when = message.sentAt ?? fetchedAt;
  const noDate = message.sentAt === null ? '（无 Date 头，取抓取时刻）' : '';
  return {
    source: 'mail',
    accountRef,
    externalId: `${message.folder}:${message.uid}`,
    occurredAt: when,
    fetchedAt,
    contentRef: `${message.fromName ?? message.from} → ${message.to}｜${message.seen ? '已读' : '未读'}｜${message.subject}${noDate}`,
    sensitivity: 'private',
    dedupeKey: `${message.folder}:${message.uid}:${message.messageId ?? ''}`,
  };
}

export class MailService {
  constructor(
    private readonly provider: MailProvider,
    private readonly options: MailServiceOptions,
  ) {}

  async fetchInbox(accountRef: string, options: {folder?: string; cursor?: MailCursor; limit?: number}): Promise<InboxPage> {
    const limit = options.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ProtocolError('INVALID_ARGUMENT', 'limit must be 1..100');
    // 聚合提供商分页直到满足 limit 或取尽；提供商页大小可能小于请求的 limit。
    const collected: MailMessage[] = [];
    let cursor = options.cursor;
    let uidValidity = options.cursor?.uidValidity ?? 0;
    let hasMore = true;
    for (let round = 0; round < 10 && hasMore && collected.length < limit; round += 1) {
      const args: {folder?: string; cursor?: MailCursor; limit: number} = {limit};
      if (options.folder !== undefined) args.folder = options.folder;
      if (cursor !== undefined) args.cursor = cursor;
      const page = await this.provider.fetchPage(accountRef, args);
      collected.push(...page.messages);
      uidValidity = page.uidValidity;
      cursor = page.nextCursor;
      hasMore = page.hasMore;
    }
    const page = {messages: collected.slice(0, limit), uidValidity, nextCursor: cursor as MailCursor, hasMore: hasMore || collected.length > limit};
    const fetchedAt = this.isoNow();
    return {
      items: page.messages.map(message => messageToItem(message, accountRef, fetchedAt)),
      nextCursor: `${page.nextCursor.uidValidity}:${page.nextCursor.lastUid}`,
      hasMore: page.hasMore,
      folder: options.folder ?? 'INBOX',
    };
  }

  async search(accountRef: string, query: string, options: {folder?: string; limit?: number}): Promise<InboxPage> {
    if (typeof query !== 'string' || query.length === 0) throw new ProtocolError('INVALID_ARGUMENT', 'Query must be a non-empty string');
    let cursor: MailCursor | undefined;
    const collected: MailMessage[] = [];
    const limit = options.limit ?? 20;
    for (let round = 0; round < 10; round += 1) {
      const searchArgs: {folder?: string; cursor?: MailCursor; limit: number} = {limit: 100};
      if (options.folder !== undefined) searchArgs.folder = options.folder;
      if (cursor !== undefined) searchArgs.cursor = cursor;
      const page = await this.provider.fetchPage(accountRef, searchArgs);
      collected.push(...page.messages.filter(message => message.subject.includes(query) || message.from.includes(query)));
      cursor = page.nextCursor;
      if (!page.hasMore) break;
    }
    const fetchedAt = this.isoNow();
    const folder = options.folder ?? 'INBOX';
    return {
      items: collected.slice(0, limit).map(message => messageToItem(message, accountRef, fetchedAt)),
      nextCursor: `${cursor?.uidValidity ?? 0}:${cursor?.lastUid ?? 0}`,
      hasMore: collected.length > limit,
      folder,
    };
  }

  async getItem(accountRef: string, folder: string, uid: number): Promise<ConnectorItem> {
    const message = await this.provider.getMessage(accountRef, folder, uid);
    if (message === undefined) throw new ProtocolError('NOT_FOUND', `No mail uid=${uid} in ${folder}`);
    return messageToItem(message, accountRef, this.isoNow());
  }

  async markSeen(accountRef: string, input: {folder: string; uid: number; idempotencyKey: string}): Promise<ConnectorAction> {
    if (typeof input.folder !== 'string' || input.folder.length === 0) throw new ProtocolError('INVALID_ARGUMENT', 'folder is required');
    if (!Number.isSafeInteger(input.uid) || input.uid < 1) throw new ProtocolError('INVALID_ARGUMENT', 'uid must be a positive integer');
    if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) throw new ProtocolError('INVALID_ARGUMENT', 'idempotencyKey is required');
    const result = await this.provider.markSeen(accountRef, input);
    return {
      actionId: `mail-mark-seen:${input.idempotencyKey}`,
      state: 'confirmed',
      externalId: `${input.folder}:${input.uid}`,
      evidenceRefs: [`mail:${input.folder}:${input.uid}:seen`],
    };
  }

  /** 发送是外部写：结果只可能是 confirmed 或 unknown——unknown 时必须先核对，重试须带同一幂等键。 */
  async send(accountRef: string, input: {to: string; subject: string; text: string; timeoutMs?: number; idempotencyKey: string}): Promise<ConnectorAction> {
    if (typeof input.to !== 'string' || !input.to.includes('@')) throw new ProtocolError('INVALID_ARGUMENT', 'to must be an email address');
    if (typeof input.subject !== 'string' || input.subject.length === 0 || input.subject.length > 500) {
      throw new ProtocolError('INVALID_ARGUMENT', 'subject must be 1..500 characters');
    }
    if (typeof input.text !== 'string') throw new ProtocolError('INVALID_ARGUMENT', 'text must be a string');
    if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) throw new ProtocolError('INVALID_ARGUMENT', 'idempotencyKey is required');
    const timeoutMs = input.timeoutMs ?? 30_000;
    const result: MailSendResult = await this.provider.send(accountRef, {to: input.to, subject: input.subject, text: input.text, timeoutMs, idempotencyKey: input.idempotencyKey});
    const action: ConnectorAction = {
      actionId: `mail-send:${input.idempotencyKey}`,
      state: result.state,
      evidenceRefs: result.state === 'confirmed'
        ? [`mail:send:${result.messageId ?? 'confirmed'}`]
        : [`mail:send:${input.idempotencyKey}:unconfirmed`, `smtp:${input.to}`],
    };
    if (result.state === 'confirmed' && result.messageId !== undefined) action.externalId = result.messageId;
    return action;
  }

  providerVerification(): 'mock' | 'conditional' {
    const declared = (this.provider as {verification?: 'mock' | 'conditional'}).verification;
    return declared ?? (this.provider.providerKind === 'fixture' ? 'mock' : 'conditional');
  }

  private isoNow(): string {
    return `${new Date(this.options.now()).toISOString().slice(0, 19)}.000Z`;
  }
}
