import {randomUUID} from 'node:crypto';
import {ProtocolError} from '@personal-agent/contracts';
import type {HostToolTaskReadback} from './runtime-application.js';

export const MAIL_READ_SESSION_CHECKPOINT = 'mail-read-session';
export const MAIL_READ_TOOL = 'mail.inbox';
export const MAIL_READ_VERSION = '0.1.0-alpha.1';
export interface StartMailReadSessionRequest {accountRef: string; folder: 'INBOX'; expiresAt: string; limit?: number;}
export interface MailReadSession {sessionId: string; accountRef: string; folder: 'INBOX'; expiresAt: string; limit: number;}
interface Lease extends MailReadSession {sequence: number; taskId?: string; cursor?: string; done: boolean;}

/** A process-local, fixed inbox read lease. Owns no timer or inbox store. */
export class MailReadSessions {
  private readonly leases = new Map<string, Lease>();
  constructor(private readonly now: () => number, private readonly cancel: (taskId: string) => void) {}
  start(request: StartMailReadSessionRequest): MailReadSession {
    if (!request || Object.keys(request).some(key => !['accountRef', 'folder', 'expiresAt', 'limit'].includes(key))
      || typeof request.accountRef !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(request.accountRef)
      || request.folder !== 'INBOX' || !Number.isFinite(Date.parse(request.expiresAt))
      || Date.parse(request.expiresAt) <= this.now()
      || !Number.isSafeInteger(request.limit ?? 100) || (request.limit ?? 100) < 1 || (request.limit ?? 100) > 100) {
      throw new ProtocolError('INVALID_ARGUMENT', 'Mail read consent must bind one inbox and future expiry');
    }
    for (const lease of this.leases.values()) {
      if (Date.parse(lease.expiresAt) <= this.now()) this.stop(lease.sessionId);
      else if (lease.accountRef === request.accountRef) throw new ProtocolError('REVISION_CONFLICT', 'Inbox session is already active');
    }
    const lease: Lease = {...request, sessionId: randomUUID(), limit: request.limit ?? 100, sequence: 0, done: false};
    this.leases.set(lease.sessionId, lease);
    return {sessionId: lease.sessionId, accountRef: lease.accountRef, folder: lease.folder,
      expiresAt: lease.expiresAt, limit: lease.limit};
  }
  private require(sessionId: string): Lease {
    const lease = this.leases.get(sessionId);
    if (!lease) throw new ProtocolError('UNAUTHORIZED', 'Inbox read session is absent or revoked');
    if (this.now() >= Date.parse(lease.expiresAt)) {
      this.stop(sessionId);
      throw new ProtocolError('TIMEOUT', 'Inbox read session expired');
    }
    return lease;
  }
  next(sessionId: string, read: (taskId: string) => HostToolTaskReadback):
    {state: 'busy' | 'blocked' | 'done'; taskId?: string} |
    {state: 'ready'; commandId: string; arguments: Record<string, unknown>; deadline: string} {
    const lease = this.require(sessionId);
    if (lease.done) return {state: 'done'};
    if (lease.taskId) {
      const result = read(lease.taskId);
      if (!['succeeded', 'failed', 'cancelled'].includes(result.task.state)) return {state: 'busy', taskId: lease.taskId};
      if (!result.confirmed || result.task.state !== 'succeeded') return {state: 'blocked', taskId: lease.taskId};
      const page = result.confirmed.result as {account?: unknown; folder?: unknown; nextCursor?: unknown; hasMore?: unknown};
      if (!page || page.account !== lease.accountRef || page.folder !== lease.folder
        || typeof page.nextCursor !== 'string' || !/^\d+:\d+$/.test(page.nextCursor)
        || typeof page.hasMore !== 'boolean') throw new ProtocolError('EXTERNAL_FAILURE', 'Confirmed inbox page is invalid');
      if (!page.hasMore) {lease.done = true; return {state: 'done'};}
      if (page.nextCursor === lease.cursor) throw new ProtocolError('CURSOR_EXPIRED', 'Inbox page cursor did not advance');
      lease.cursor = page.nextCursor;
    }
    lease.sequence++;
    return {state: 'ready', commandId: `mail:${sessionId}:${lease.sequence}`,
      arguments: {account: lease.accountRef, folder: lease.folder, limit: lease.limit,
        ...(lease.cursor ? {cursor: lease.cursor} : {})}, deadline: lease.expiresAt};
  }
  bind(sessionId: string, taskId: string): void {this.require(sessionId).taskId = taskId;}
  assertPage(sessionId: string, taskId: string): void {
    if (this.require(sessionId).taskId !== taskId) throw new ProtocolError('UNAUTHORIZED', 'Inbox task is outside its session');
  }
  stop(sessionId: string): {stopped: boolean} {
    const lease = this.leases.get(sessionId);
    if (!lease) return {stopped: false};
    this.leases.delete(sessionId);
    if (lease.taskId) this.cancel(lease.taskId);
    return {stopped: true};
  }
  stopAll(): void {for (const id of this.leases.keys()) this.stop(id);}
}
