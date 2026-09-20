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
  /**
   * 批次生命周期：裁定即 ready_for_delivery（持久化，等待桌面取走）；桌面确认接收后
   * acknowledge() 置 delivered。drain 不会删除未确认批次——崩溃重启后原样取回。
   */
  state: 'ready_for_delivery' | 'delivered';
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
  /** 已裁定但桌面尚未确认接收的批次数（崩溃重启后这些批次会被再次返回）。 */
  unacknowledgedBatches: number;
}

export interface NotificationServiceOptions {
  now: () => number;
  idFactory: () => string;
}

/**
 * 全部通知状态的持久化形态，存于**单一存储键**。
 *
 * 原子性（goo122 2026-09-09 复审 P1）：pending 消费、去重标记与批次创建曾写三个键，
 * 写入间隙注入异常会永久丢失通知（重放又被去重拒绝）。现在每次变更都在内存中算出
 * 完整新状态并**一次写入**——存储层崩溃要么完全应用新状态，要么保留旧状态，
 * 不存在「事件被标记已裁但批次未落盘」的窗口。宿主若提供真实事务型存储，
 * 可在 writeState 处替换为事务提交，语义不变。
 */
interface NotificationState {
  pending: PendingItem[];
  batches: NotificationBatch[];
  /** 已交付 dedupeKey 的有界 FIFO（去重窗口），淘汰由宿主按 dedupeKey 吸收。 */
  delivered: string[];
}

const STATE_KEY = 'notifications:state';
/** 已确认批次的保留上限：只作幂等记录，超限淘汰最旧。 */
const DELIVERED_BATCH_LIMIT = 100;
/** 已交付 dedupeKey 的窗口上限。 */
const DELIVERED_KEY_LIMIT = 500;

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

  /** 接收标准事件。重复 dedupeKey 静默忽略（计数披露在返回值）。单次状态写入，原子。 */
  ingest(items: readonly ConnectorItem[]): {accepted: number; duplicates: number} {
    const state = this.readState();
    // Outstanding batches pin their keys independently of the bounded history
    // window. Reconstruct from stored batches; no second dedupe store is needed.
    const unacknowledgedKeys = new Set(state.batches
      .filter(batch => batch.state === 'ready_for_delivery')
      .flatMap(batch => batch.itemRefs));
    let accepted = 0;
    let duplicates = 0;
    for (const item of items) {
      if (!item || typeof item !== 'object' || typeof item.dedupeKey !== 'string' || item.dedupeKey.length === 0) {
        throw new ProtocolError('INVALID_ARGUMENT', 'Ingested items must be ConnectorItems with a dedupeKey');
      }
      if (unacknowledgedKeys.has(item.dedupeKey) || state.delivered.includes(item.dedupeKey)
        || state.pending.some(existing => existing.dedupeKey === item.dedupeKey)) {
        duplicates += 1;
        continue;
      }
      state.pending.push({dedupeKey: item.dedupeKey, source: item.source, receivedAt: this.isoNow(), item: structuredClone(item)});
      accepted += 1;
    }
    if (accepted > 0) this.writeState(state);
    return {accepted, duplicates};
  }

  /**
   * 裁定并交付。暂停与安静时段 hold 一切（含摘要）；聚合来源等窗口关闭或达上限。
   * 全部状态变更（消费 pending、标记 delivered、创建批次）在**一次状态写入**中生效：
   * 确认前批次保持 `ready_for_delivery`，崩溃重启后原样取回，不重复生成。
   */
  drain(): DrainReport {
    const now = this.options.now();
    const nowIso = this.isoNow();
    const state = this.readState();
    const held: DrainReport['held'] = {quiet: 0, paused: 0, digest: 0};
    const deliver: PendingItem[] = [];
    const digestPool: PendingItem[] = [];
    const keep: PendingItem[] = [];

    for (const entry of state.pending) {
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

    const decided: NotificationBatch[] = [];
    if (deliver.length > 0) {
      decided.push({
        id: this.options.idFactory(),
        kind: 'immediate',
        itemRefs: deliver.map(entry => entry.dedupeKey),
        decidedAt: nowIso,
        heldSince: earliest(deliver),
        reason: 'immediate',
        state: 'ready_for_delivery',
      });
    }

    if (digestPool.length > 0) {
      const digest = this.policy.digest as NonNullable<NotificationPolicy['digest']>;
      const windowClosesAt = Math.min(...digestPool.map(entry => Date.parse(entry.receivedAt))) + digest.windowMs;
      const flushes = digest.maxItems !== undefined && digestPool.length >= digest.maxItems;
      const windowElapsed = windowClosesAt <= now;
      // 摘要交付同样尊重安静时段：窗口到了但在安静期，继续持有并披露。
      const quietNow = this.policy.quietHours !== undefined && quietHoursActive(this.policy.quietHours, now);
      if ((flushes || windowElapsed) && !this.paused(now) && !quietNow) {
        decided.push({
          id: this.options.idFactory(),
          kind: 'digest',
          itemRefs: digestPool.map(entry => entry.dedupeKey),
          decidedAt: nowIso,
          heldSince: earliest(digestPool),
          reason: flushes ? 'digest_max_items' : 'digest_window_closed',
          state: 'ready_for_delivery',
        });
      } else {
        held.digest = digestPool.length;
        keep.push(...digestPool);
      }
    }

    // 单次原子写入：消费的条目移出 pending、进入 delivered 窗口与批次列表；失败则整体不生效。
    const nextState: NotificationState = {
      pending: keep,
      batches: trimBatches([...state.batches, ...decided]),
      delivered: [...state.delivered, ...deliver.map(entry => entry.dedupeKey), ...flushedKeys(digestPool, decided)].slice(-DELIVERED_KEY_LIMIT),
    };
    if (decided.length > 0) this.writeState(nextState);

    // 恢复语义优先：未确认批次排在本次新裁定之前返回；不重复生成（id 不变）。
    // 输出边界深拷贝：调用方改动返回批次不得影响存储内的状态（返回对象可能携带内部引用）。
    const prior = state.batches.filter(batch => batch.state === 'ready_for_delivery');
    return {batches: structuredClone([...prior, ...decided]), held};
  }

  /** 桌面确认接收一个批次：置 delivered（幂等，重复确认无副作用）。单次写入，原子。 */
  acknowledge(batchId: string): NotificationBatch {
    if (typeof batchId !== 'string' || batchId.length === 0) {
      throw new ProtocolError('INVALID_ARGUMENT', 'batchId must be a non-empty string');
    }
    const state = this.readState();
    const target = state.batches.find(batch => batch.id === batchId);
    if (target === undefined) throw new ProtocolError('NOT_FOUND', `No notification batch ${batchId}`);
    if (target.state === 'ready_for_delivery') {
      target.state = 'delivered';
      this.writeState({...state, batches: trimBatches(state.batches)});
    }
    return structuredClone(target);
  }

  status(): StatusReport {
    const now = this.options.now();
    const state = this.readState();
    const quietEnd = this.policy.quietHours === undefined ? null : nextQuietEndMs(this.policy.quietHours, now);
    let nextDigest: number | null = null;
    if (this.policy.digest !== undefined) {
      const scoped = state.pending.filter(entry => this.inDigestScope(entry));
      if (scoped.length > 0) {
        const oldest = Math.min(...scoped.map(entry => Date.parse(entry.receivedAt)));
        nextDigest = Math.min(oldest + this.policy.digest.windowMs, now + this.policy.digest.windowMs);
      }
    }
    const report: StatusReport = {
      pausedUntil: this.paused(now) ? (this.policy.pauseUntilUtc as string) : null,
      quietUntil: quietEnd === null ? null : isoMinute(quietEnd),
      pending: state.pending.length,
      nextDigestCloseAt: nextDigest === null ? null : isoMinute(nextDigest),
      unacknowledgedBatches: state.batches.filter(batch => batch.state === 'ready_for_delivery').length,
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

  private readState(): NotificationState {
    const value = this.storage.get(STATE_KEY);
    if (value === undefined || value === null) return {pending: [], batches: [], delivered: []};
    if (typeof value !== 'object' || Array.isArray(value)) return {pending: [], batches: [], delivered: []};
    const record = value as Record<string, unknown>;
    const state: NotificationState = {
      pending: Array.isArray(record.pending) ? record.pending.filter(isPendingItem) : [],
      batches: Array.isArray(record.batches) ? record.batches.filter(isBatch) : [],
      delivered: Array.isArray(record.delivered) ? record.delivered.filter((key): key is string => typeof key === 'string').slice(-DELIVERED_KEY_LIMIT) : [],
    };
    // 读边界整态深拷贝（goo122 2026-09-13 复审 P1）：StoragePort 不保证 get 返回副本，
    // 不拷贝则 acknowledge 对状态对象的就地修改会先于写入生效——写失败也"生效"了。
    return structuredClone(state);
  }

  private writeState(state: NotificationState): void {
    this.storage.set(STATE_KEY, {
      pending: state.pending,
      batches: trimBatches(state.batches),
      delivered: state.delivered.slice(-DELIVERED_KEY_LIMIT),
    });
  }

  private isoNow(): string {
    return `${new Date(this.options.now()).toISOString().slice(0, 19)}.000Z`;
  }
}

/** 已确认批次保留最近 DELIVERED_BATCH_LIMIT 条作幂等记录；未确认批次永不淘汰。 */
function trimBatches(batches: NotificationBatch[]): NotificationBatch[] {
  const unacknowledged = batches.filter(batch => batch.state === 'ready_for_delivery');
  const delivered = batches.filter(batch => batch.state === 'delivered');
  return [...unacknowledged, ...delivered.slice(-DELIVERED_BATCH_LIMIT)];
}

/** 被摘要批次的条目键同样进 delivered 窗口（批次已创建即视为已裁）。 */
function flushedKeys(digestPool: readonly PendingItem[], decided: readonly NotificationBatch[]): string[] {
  const hasDigest = decided.some(batch => batch.kind === 'digest');
  return hasDigest ? digestPool.map(entry => entry.dedupeKey) : [];
}

function isPendingItem(value: unknown): value is PendingItem {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.dedupeKey === 'string' && typeof entry.source === 'string' && typeof entry.receivedAt === 'string' && !!entry.item;
}

function isBatch(value: unknown): value is NotificationBatch {
  if (!value || typeof value !== 'object') return false;
  const batch = value as Record<string, unknown>;
  return typeof batch.id === 'string'
    && (batch.kind === 'immediate' || batch.kind === 'digest')
    && Array.isArray(batch.itemRefs)
    && typeof batch.decidedAt === 'string'
    && typeof batch.reason === 'string'
    && (batch.state === 'ready_for_delivery' || batch.state === 'delivered');
}

function earliest(entries: readonly PendingItem[]): string {
  return entries.reduce((min, entry) => entry.receivedAt < min ? entry.receivedAt : min, entries[0]?.receivedAt ?? '');
}

function isoMinute(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19)}.000Z`;
}
