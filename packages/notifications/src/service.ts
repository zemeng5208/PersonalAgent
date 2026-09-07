import { ProtocolError } from '@personal-agent/contracts';
import type { StoragePort, ProtocolContracts } from '@personal-agent/contracts';
import { nextQuietEndMs, quietHoursActive } from './policy.js';
import type { NotificationPolicy } from './policy.js';

type ConnectorItem = ProtocolContracts['connectorItem'];

/** 待裁定事件的持久化形态：原始条目＋到达时刻＋去重键。 */
export interface PendingItem {
  dedupeKey: string;
  source: string;
  receivedAt: string;
  item: ConnectorItem;
}

/** 一次裁定产出：要么立即条目，要么摘要请求。条目引用的是 dedupeKey，不复制内容。 */
export interface NotificationBatch {
  id: string;
  kind: 'immediate' | 'digest';
  itemRefs: string[];
  decidedAt: string;
  heldSince: string;
  reason: string;
}

export interface DrainReport {
  batches: NotificationBatch[];
  held: {quiet: number; paused: number; digest: number};
}

export interface StatusReport {
  pausedUntil: string | null;
  quietUntil: string | null;
  pending: number;
  nextDigestCloseAt: string | null;
}

export interface NotificationServiceOptions {
  now: () => number;
  idFactory: () => string;
}

const PENDING_KEY = 'notifications:pending';
const DELIVERED_PREFIX = 'notifications:delivered:';

/**
 * 通知汇总策略（MOD-23）：只做裁定，不调度、不展示。
 * 宿主按 Runtime 调度调用 drain：安静结束/摘要窗口关闭时（见 planSchedules 的建议），
 * 或任意时刻调用（幂等，无产出时返回空）。去重按 dedupeKey——同一事件重复投递只裁一次。
 */
export class NotificationService {
  private readonly policy: NotificationPolicy;

  constructor(
    private readonly storage: StoragePort,
    policy: NotificationPolicy,
    private readonly options: NotificationServiceOptions,
  ) {
    if (!storage) throw new ProtocolError('INVALID_ARGUMENT', 'Notification storage must be explicitly provided');
    if (!policy || typeof policy !== 'object') throw new ProtocolError('INVALID_ARGUMENT', 'Notification policy must be provided');
    this.policy = policy;
  }

  /** 接收标准事件。重复 dedupeKey 静默忽略（计数披露在返回值）。 */
  ingest(items: readonly ConnectorItem[]): {accepted: number; duplicates: number} {
    const pending = this.readPending();
    let accepted = 0;
    let duplicates = 0;
    for (const item of items) {
      if (!item || typeof item !== 'object' || typeof item.dedupeKey !== 'string' || item.dedupeKey.length === 0) {
        throw new ProtocolError('INVALID_ARGUMENT', 'Ingested items must be ConnectorItems with a dedupeKey');
      }
      if (this.isDelivered(item.dedupeKey) || pending.some(existing => existing.dedupeKey === item.dedupeKey)) {
        duplicates += 1;
        continue;
      }
      pending.push({dedupeKey: item.dedupeKey, source: item.source, receivedAt: this.isoNow(), item: structuredClone(item)});
      accepted += 1;
    }
    this.storage.set(PENDING_KEY, pending);
    return {accepted, duplicates};
  }

  /**
   * 裁定并交付。暂停与安静时段 hold 一切（含摘要）；聚合来源等窗口关闭或达上限。
   * 已裁定的条目标记 delivered，重复 drain 不会重复产出。
   */
  drain(): DrainReport {
    const now = this.options.now();
    const nowIso = this.isoNow();
    const pending = this.readPending();
    const held: DrainReport['held'] = {quiet: 0, paused: 0, digest: 0};
    const deliver: PendingItem[] = [];
    const digestPool: PendingItem[] = [];
    const keep: PendingItem[] = [];

    for (const entry of pending) {
      if (this.paused(now)) {
        held.paused += 1;
        keep.push(entry);
        continue;
      }
      if (this.policy.digest !== undefined && this.inDigestScope(entry)) {
        digestPool.push(entry);
        continue;
      }
      if (this.policy.quietHours !== undefined && quietHoursActive(this.policy.quietHours, now)) {
        held.quiet += 1;
        keep.push(entry);
        continue;
      }
      deliver.push(entry);
    }

    const batches: NotificationBatch[] = [];
    if (deliver.length > 0) {
      batches.push({
        id: this.options.idFactory(),
        kind: 'immediate',
        itemRefs: deliver.map(entry => entry.dedupeKey),
        decidedAt: nowIso,
        heldSince: earliest(deliver),
        reason: 'immediate',
      });
      for (const entry of deliver) this.markDelivered(entry.dedupeKey);
    }

    if (digestPool.length > 0) {
      const digest = this.policy.digest as NonNullable<NotificationPolicy['digest']>;
      const windowClosesAt = Math.min(...digestPool.map(entry => Date.parse(entry.receivedAt))) + digest.windowMs;
      const flushes = digest.maxItems !== undefined && digestPool.length >= digest.maxItems;
      const windowElapsed = windowClosesAt <= now;
      // 摘要交付同样尊重安静时段：窗口到了但在安静期，继续持有并披露。
      const quietNow = this.policy.quietHours !== undefined && quietHoursActive(this.policy.quietHours, now);
      if ((flushes || windowElapsed) && !this.paused(now) && !quietNow) {
        batches.push({
          id: this.options.idFactory(),
          kind: 'digest',
          itemRefs: digestPool.map(entry => entry.dedupeKey),
          decidedAt: nowIso,
          heldSince: earliest(digestPool),
          reason: flushes ? 'digest_max_items' : 'digest_window_closed',
        });
        for (const entry of digestPool) this.markDelivered(entry.dedupeKey);
      } else {
        held.digest = digestPool.length;
        keep.push(...digestPool);
      }
    }

    this.storage.set(PENDING_KEY, keep);
    return {batches, held};
  }

  status(): StatusReport {
    const now = this.options.now();
    const pending = this.readPending();
    const quietEnd = this.policy.quietHours === undefined ? null : nextQuietEndMs(this.policy.quietHours, now);
    let nextDigest: number | null = null;
    if (this.policy.digest !== undefined) {
      const scoped = pending.filter(entry => this.inDigestScope(entry));
      if (scoped.length > 0) {
        const oldest = Math.min(...scoped.map(entry => Date.parse(entry.receivedAt)));
        nextDigest = Math.min(oldest + this.policy.digest.windowMs, now + this.policy.digest.windowMs);
      }
    }
    const report: StatusReport = {
      pausedUntil: this.paused(now) ? (this.policy.pauseUntilUtc as string) : null,
      quietUntil: quietEnd === null ? null : isoMinute(quietEnd),
      pending: pending.length,
      nextDigestCloseAt: nextDigest === null ? null : isoMinute(nextDigest),
    };
    return report;
  }

  /** 结构兼容 Runtime `ScheduleInput` 的调度建议：安静结束与摘要窗口关闭各一条，错过即补跑一次。 */
  planSchedules(conversationId: string): {scheduleId: string; goal: string; conversationId: string; runAt: string; timeZone: string; missedRunPolicy: 'run_once'; taskIdempotencyKey: string}[] {
    const now = this.options.now();
    const plans: {scheduleId: string; goal: string; conversationId: string; runAt: string; timeZone: string; missedRunPolicy: 'run_once'; taskIdempotencyKey: string}[] = [];
    const quietEnd = this.policy.quietHours === undefined ? null : nextQuietEndMs(this.policy.quietHours, now);
    if (quietEnd !== null) {
      plans.push({
        scheduleId: `notifications:quiet-end:${isoMinute(quietEnd)}`,
        goal: '安静时段结束，裁定被持有的通知',
        conversationId,
        runAt: isoMinute(quietEnd),
        timeZone: 'UTC',
        missedRunPolicy: 'run_once',
        taskIdempotencyKey: `notifications:quiet-end:${isoMinute(quietEnd)}`,
      });
    }
    const status = this.status();
    if (status.nextDigestCloseAt !== null) {
      plans.push({
        scheduleId: `notifications:digest:${status.nextDigestCloseAt}`,
        goal: '聚合窗口关闭，产出摘要请求',
        conversationId,
        runAt: status.nextDigestCloseAt,
        timeZone: 'UTC',
        missedRunPolicy: 'run_once',
        taskIdempotencyKey: `notifications:digest:${status.nextDigestCloseAt}`,
      });
    }
    return plans;
  }

  private paused(now: number): boolean {
    return this.policy.pauseUntilUtc !== undefined && Date.parse(this.policy.pauseUntilUtc) > now;
  }

  private inDigestScope(entry: PendingItem): boolean {
    const digest = this.policy.digest;
    if (digest === undefined) return false;
    return digest.sources === undefined || digest.sources.includes(entry.source);
  }

  private isDelivered(dedupeKey: string): boolean {
    return this.storage.get(DELIVERED_PREFIX + dedupeKey) === true;
  }

  private markDelivered(dedupeKey: string): void {
    this.storage.set(DELIVERED_PREFIX + dedupeKey, true);
  }

  private readPending(): PendingItem[] {
    const value = this.storage.get(PENDING_KEY);
    return Array.isArray(value) ? value.filter(isPendingItem) : [];
  }

  private isoNow(): string {
    return isoMinute(this.options.now());
  }
}

function isPendingItem(value: unknown): value is PendingItem {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.dedupeKey === 'string' && typeof entry.source === 'string' && typeof entry.receivedAt === 'string' && !!entry.item;
}

function earliest(entries: readonly PendingItem[]): string {
  return entries.reduce((min, entry) => entry.receivedAt < min ? entry.receivedAt : min, entries[0]?.receivedAt ?? '');
}

function isoMinute(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19)}.000Z`;
}
