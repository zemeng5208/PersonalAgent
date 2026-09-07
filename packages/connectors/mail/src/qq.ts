import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import type { SentMessageInfo, Transporter } from 'nodemailer';
import { ProtocolError } from '@personal-agent/contracts';
import type {
  MailFetchInput,
  MailFolder,
  MailMarkSeenInput,
  MailMessage,
  MailPage,
  MailProvider,
  MailSendInput,
  MailSendResult,
} from './provider.js';

export interface QQMailOptions {
  /** 完整 QQ 邮箱地址，如 3468788554@qq.com。装配层从环境注入，不进仓库。 */
  user: string;
  /** QQ 邮箱「授权码」（设置 → 账号 → IMAP/SMTP 服务生成），不是登录密码。 */
  authCode: string;
  imapHost?: string;
  imapPort?: number;
  smtpHost?: string;
  smtpPort?: number;
}

const DEFAULT_IMAP = {host: 'imap.qq.com', port: 993};
const DEFAULT_SMTP = {host: 'smtp.qq.com', port: 465};

/** imapflow envelope 的最小形状（避免把第三方类型漏到公共接口）。 */
export interface ImapEnvelopeLike {
  from?: {address?: string; name?: string}[] | null;
  to?: {address?: string}[] | null;
  subject?: string | null;
  date?: Date | string | null;
  messageId?: string | null;
}

/** 纯函数：imapflow 的 envelope+flags → 本包 MailMessage。Date 头缺失保留 null 由服务层兜底。 */
export function messageFromImap(uid: number, folder: string, envelope: ImapEnvelopeLike, seen: boolean): MailMessage {
  const from = envelope.from?.[0]?.address ?? 'unknown@unknown';
  const message: MailMessage = {
    uid,
    folder,
    from,
    to: envelope.to?.[0]?.address ?? 'unknown@unknown',
    subject: envelope.subject ?? '(无主题)',
    sentAt: envelope.date === null || envelope.date === undefined ? null : new Date(envelope.date).toISOString(),
    seen,
  };
  const name = envelope.from?.[0]?.name;
  if (name !== undefined && name.length > 0) message.fromName = name;
  if (typeof envelope.messageId === 'string' && envelope.messageId.length > 0) message.messageId = envelope.messageId;
  return message;
}

/** QQ 邮箱真实提供商：IMAP（imapflow）读侧 + SMTP（nodemailer）写侧。 */
export class QQMailProvider implements MailProvider {
  readonly providerKind = 'qq';
  readonly verification = 'conditional' as const;
  private readonly options: Required<Pick<QQMailOptions, 'imapHost' | 'imapPort' | 'smtpHost' | 'smtpPort'>> & QQMailOptions;
  private client: ImapFlow | null = null;
  private transporter: Transporter | null = null;
  private readonly sendActions = new Map<string, MailSendResult>();

  constructor(options: QQMailOptions) {
    if (typeof options.user !== 'string' || !options.user.includes('@')) {
      throw new ProtocolError('INVALID_ARGUMENT', 'QQ mail user must be a full address');
    }
    if (typeof options.authCode !== 'string' || options.authCode.length === 0) {
      throw new ProtocolError('INVALID_ARGUMENT', 'QQ mail authCode is required (设置→账号→IMAP/SMTP 服务生成的授权码)');
    }
    this.options = {
      ...options,
      imapHost: options.imapHost ?? DEFAULT_IMAP.host,
      imapPort: options.imapPort ?? DEFAULT_IMAP.port,
      smtpHost: options.smtpHost ?? DEFAULT_SMTP.host,
      smtpPort: options.smtpPort ?? DEFAULT_SMTP.port,
    };
  }

  private async connect(): Promise<ImapFlow> {
    if (this.client !== null && this.client.usable) return this.client;
    const client = new ImapFlow({
      host: this.options.imapHost,
      port: this.options.imapPort,
      secure: true,
      auth: {user: this.options.user, pass: this.options.authCode},
      logger: false,
    });
    try {
      await client.connect();
    } catch (error) {
      client.close();
      throw mapImapError(error);
    }
    this.client = client;
    return client;
  }

  async listFolders(): Promise<MailFolder[]> {
    const client = await this.connect();
    try {
      const boxes = await client.list();
      return boxes
        .map(box => ({path: box.path, role: roleOf(box.specialUse), uidValidity: 0}))
        .filter(folder => folder.role !== 'other' || !folder.path.includes('.'));
    } catch (error) {
      throw mapImapError(error);
    }
  }

  async fetchPage(accountRef: string, input: MailFetchInput): Promise<MailPage> {
    void accountRef;
    const folder = input.folder ?? 'INBOX';
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new ProtocolError('INVALID_ARGUMENT', 'limit must be 1..100');
    }
    const client = await this.connect();
    const lock = await client.getMailboxLock(folder);
    try {
      const mailbox = client.mailbox;
      const uidValidity = typeof mailbox === 'object' && mailbox !== null && mailbox.uidValidity ? Number(mailbox.uidValidity) : 0;
      if (input.cursor !== undefined && input.cursor.uidValidity !== uidValidity) {
        throw new ProtocolError('CURSOR_EXPIRED', `Folder ${folder} uidValidity changed; restart sync from scratch`);
      }
      const lastUid = input.cursor?.lastUid ?? 0;
      const uids = await client.search({uid: `${lastUid + 1}:*`}, {uid: true});
      const fresh = (Array.isArray(uids) ? uids : [])
        .map(uid => Number(uid))
        .filter(uid => uid > lastUid)
        .sort((left, right) => left - right)
        .slice(0, input.limit);
      const messages: MailMessage[] = [];
      if (fresh.length > 0) {
        for await (const message of client.fetch(fresh, {uid: true, envelope: true, flags: true}, {uid: true})) {
          const stamped = messageFromImap(message.uid, folder, message.envelope ?? {}, message.flags?.has('\\Seen') ?? false);
          stamped.uidValidity = uidValidity;
          messages.push(stamped);
        }
      }
      const consumed = messages.map(entry => entry.uid).reduce((max, uid) => Math.max(max, uid), lastUid);
      return {
        messages,
        uidValidity,
        nextCursor: {uidValidity, lastUid: consumed},
        hasMore: fresh.length === input.limit,
      };
    } catch (error) {
      if (error instanceof ProtocolError) throw error;
      throw mapImapError(error);
    } finally {
      lock.release();
    }
  }

  async getMessage(_accountRef: string, folder: string, uid: number): Promise<MailMessage | undefined> {
    const client = await this.connect();
    const lock = await client.getMailboxLock(folder);
    try {
      for await (const message of client.fetch(String(uid), {uid: true, envelope: true, flags: true}, {uid: true})) {
        const stamped = messageFromImap(message.uid, folder, message.envelope ?? {}, message.flags?.has('\\Seen') ?? false);
        stamped.uidValidity = typeof client.mailbox === 'object' && client.mailbox !== null && client.mailbox.uidValidity ? Number(client.mailbox.uidValidity) : 0;
        return stamped;
      }
      return undefined;
    } catch (error) {
      throw mapImapError(error);
    } finally {
      lock.release();
    }
  }

  async markSeen(_accountRef: string, input: MailMarkSeenInput): Promise<{uid: number; seen: boolean}> {
    if (input.idempotencyKey.length === 0) throw new ProtocolError('INVALID_ARGUMENT', 'idempotencyKey is required');
    const client = await this.connect();
    const lock = await client.getMailboxLock(input.folder);
    try {
      await client.messageFlagsAdd(String(input.uid), ['\\Seen'], {uid: true});
      return {uid: input.uid, seen: true};
    } catch (error) {
      throw mapImapError(error);
    } finally {
      lock.release();
    }
  }

  async send(_accountRef: string, input: MailSendInput & {idempotencyKey: string}): Promise<MailSendResult> {
    if (input.idempotencyKey.length === 0) throw new ProtocolError('INVALID_ARGUMENT', 'idempotencyKey is required');
    const prior = this.sendActions.get(input.idempotencyKey);
    if (prior !== undefined) return prior;
    if (this.transporter === null) {
      this.transporter = nodemailer.createTransport({
        host: this.options.smtpHost,
        port: this.options.smtpPort,
        secure: true,
        auth: {user: this.options.user, pass: this.options.authCode},
        socketTimeout: Math.max(input.timeoutMs, 1_000),
      });
    }
    let result: MailSendResult;
    try {
      const info: SentMessageInfo = await Promise.race([
        this.transporter.sendMail({from: this.options.user, to: input.to, subject: input.subject, text: input.text}),
        rejectAfter(input.timeoutMs),
      ]);
      result = {state: 'confirmed'};
      if (typeof info.messageId === 'string') result.messageId = info.messageId;
    } catch (error) {
      // 超时或连接中断都意味着「结果未知」，不是失败：绝不盲重试（PA-014）。
      result = {state: 'unknown', reason: describe(error)};
    }
    this.sendActions.set(input.idempotencyKey, result);
    return result;
  }

  async dispose(): Promise<void> {
    this.client?.close();
    this.client = null;
    this.transporter?.close();
    this.transporter = null;
  }
}

function rejectAfter(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`send timed out after ${ms}ms`)), ms).unref?.();
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mapImapError(error: unknown): ProtocolError {
  const message = describe(error);
  if (/authentication|auth|login/i.test(message)) {
    return new ProtocolError('UNAUTHORIZED', `QQ mail rejected the credentials (check 授权码): ${message}`, false);
  }
  if (/timeout|etimedout/i.test(message)) {
    return new ProtocolError('TIMEOUT', `QQ mail IMAP timed out: ${message}`, true);
  }
  if (/econnrefused|econnreset|enotfound|ehostunreach|certificate/i.test(message)) {
    return new ProtocolError('EXTERNAL_FAILURE', `QQ mail IMAP connection failed: ${message}`, true);
  }
  return new ProtocolError('EXTERNAL_FAILURE', `QQ mail IMAP error: ${message}`, true);
}

function roleOf(specialUse: string | undefined): MailFolder['role'] {
  if (specialUse === '\\Inbox') return 'inbox';
  if (specialUse === '\\Sent') return 'sent';
  if (specialUse === '\\Drafts') return 'drafts';
  if (specialUse === '\\Archive' || specialUse === '\\All') return 'archive';
  return 'other';
}
