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
    dedupeKey: `${accountRef}:${message.uidValidity ?? 0}:${message.folder}:${message.uid}:${message.messageId ?? ''}`,
  };
}

export class MailService {
  private readonly sendIdempotency = new Map<string, {fingerprint: string; inflight: MailSendResult | Promise<MailSendResult>}>();

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
    let providerHasMore = true;
    for (let round = 0; round < 10 && providerHasMore && collected.length < limit; round += 1) {
      const args: {folder?: string; cursor?: MailCursor; limit: number} = {limit};
      if (options.folder !== undefined) args.folder = options.folder;
      if (cursor !== undefined) args.cursor = cursor;
      const page = await this.provider.fetchPage(accountRef, args);
      collected.push(...page.messages);
      uidValidity = page.uidValidity;
      cursor = page.nextCursor;
      providerHasMore = page.hasMore;
    }
    // 游标只推进到实际返回的最后一条：聚合可能超额取回（页边界越过 limit），
    // 那些多取但未返回的条目必须留在游标之后，否则会漏邮件。
    // epoch（uidValidity）轮换后旧 lastUid 不再是本 epoch 的水位——只有 epoch 未变才沿用，
    // 重置时从新 epoch 实际返回的条目重算（goo122 2026-09-09 复审 P1）。
    const returned = collected.slice(0, limit);
    const seed = options.cursor !== undefined && options.cursor.uidValidity === uidValidity ? options.cursor.lastUid : 0;
    const lastReturnedUid = returned.reduce((max, message) => Math.max(max, message.uid), seed);
    const nextCursor: MailCursor = {uidValidity, lastUid: lastReturnedUid};
    const fetchedAt = this.isoNow();
    return {
      items: returned.map(message => messageToItem(message, accountRef, fetchedAt)),
      nextCursor: `${nextCursor.uidValidity}:${nextCursor.lastUid}`,
      hasMore: providerHasMore || collected.length > returned.length,
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

  /**
   * 发送是外部写：结果只可能是 confirmed 或 unknown——unknown 时必须先核对，重试须带同一幂等键。
   * 幂等键绑定账号＋收件人＋主题＋正文：并发同键请求复用在途 Promise 只调一次提供商；
   * 同键不同输入复用一律拒绝（参数冲突）。跨重启的持久化归宿主（Runtime 按 actionId
   * 存证据；unknown 进入人工核实流程，不自动重发——见 README「重启与恢复」）。
   */
  async send(accountRef: string, input: {to: string; subject: string; text: string; timeoutMs?: number; idempotencyKey: string}): Promise<ConnectorAction> {
    if (typeof input.to !== 'string' || !input.to.includes('@')) throw new ProtocolError('INVALID_ARGUMENT', 'to must be an email address');
    if (typeof input.subject !== 'string' || input.subject.length === 0 || input.subject.length > 500) {
      throw new ProtocolError('INVALID_ARGUMENT', 'subject must be 1..500 characters');
    }
    if (typeof input.text !== 'string') throw new ProtocolError('INVALID_ARGUMENT', 'text must be a string');
    if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) throw new ProtocolError('INVALID_ARGUMENT', 'idempotencyKey is required');
    // 无歧义规范编码（goo122 2026-09-13 复审 P1）：换行拼接会让 subject=A\nB,text=C 与
    // subject=A,text=B\nC 撞指纹；JSON 数组转义换行与引号，编码唯一。
    // 复合键同样结构化编码（goo122 2026-09-14 复审）：`${accountRef}:${key}` 在 accountRef
    // 含冒号时碰撞（^G:b + c ≡ ^G + :c）；JSON 数组编码无歧义。
    const fingerprint = JSON.stringify([input.to, input.subject, input.text]);
    const mapKey = JSON.stringify([accountRef, input.idempotencyKey]);
    const prior = this.sendIdempotency.get(mapKey);
    if (prior !== undefined) {
      if (prior.fingerprint !== fingerprint) {
        throw new ProtocolError('INVALID_ARGUMENT', `idempotencyKey "${input.idempotencyKey}" was used with a different recipient/subject/body; refusing to reuse it`);
      }
      return this.actionFromResult(input.idempotencyKey, input.to, await prior.inflight);
    }
    const inflight = this.provider.send(accountRef, {
      to: input.to,
      subject: input.subject,
      text: input.text,
      timeoutMs: input.timeoutMs ?? 30_000,
      idempotencyKey: input.idempotencyKey,
    });
    this.sendIdempotency.set(mapKey, {fingerprint, inflight});
    const result = await inflight;
    return this.actionFromResult(input.idempotencyKey, input.to, result);
  }

  private actionFromResult(idempotencyKey: string, to: string, result: MailSendResult): ConnectorAction {
    const action: ConnectorAction = {
      actionId: `mail-send:${idempotencyKey}`,
      state: result.state,
      evidenceRefs: result.state === 'confirmed'
        ? [`mail:send:${result.messageId ?? 'confirmed'}`]
        : [`mail:send:${idempotencyKey}:unconfirmed`, `smtp:${to}`],
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
