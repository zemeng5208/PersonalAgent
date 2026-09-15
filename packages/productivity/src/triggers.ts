import type { ReminderDispatch, TodoItem } from './item.js';

export type {ReminderDispatch};

/**
 * 提醒触发定义。字段与 Runtime（MOD-03）的 `ScheduleInput` 结构兼容：
 * 本包不导入 `apps/runtime`（ADR-0002：packages 不依赖 apps），装配方把
 * ReminderTrigger 直接交给 `SchedulerPort.createSchedule` 即可。
 */
export interface ReminderTrigger {
  scheduleId: string;
  goal: string;
  conversationId: string;
  runAt: string;
  timeZone: string;
  missedRunPolicy: 'run_once' | 'skip';
  taskIdempotencyKey: string;
}

export function reminderScheduleId(itemId: string, remindAtUtc: string): string {
  return `todo-reminder:${itemId}:${remindAtUtc}`;
}

/** 为单个条目生成触发定义；已完结、无提醒或提醒已投递/错过的条目返回 null。 */
export function buildReminderTrigger(item: TodoItem, conversationId: string): ReminderTrigger | null {
  if (item.status !== 'open') return null;
  if (!item.reminder || item.reminder.state !== 'scheduled') return null;
  const remindAt = item.reminder.remindAt;
  const scheduleId = reminderScheduleId(item.id, remindAt.utc);
  return {
    scheduleId,
    goal: `提醒待办：${item.title}`,
    conversationId,
    runAt: remindAt.utc,
    timeZone: remindAt.timeZone,
    missedRunPolicy: item.reminder.missedPolicy,
    taskIdempotencyKey: scheduleId,
  };
}

export function reminderTriggers(items: readonly TodoItem[], conversationId: string): ReminderTrigger[] {
  const triggers: ReminderTrigger[] = [];
  for (const item of items) {
    const trigger = buildReminderTrigger(item, conversationId);
    if (trigger) triggers.push(trigger);
  }
  return triggers;
}

/**
 * 把 Runtime 调度回执映射回条目：`fired` → 提醒已投递，`skipped` → 标记错过。
 * 返回被更新的条目（新对象，revision 递增）；调度器保证同一 schedule 只投递一次，
 * 与 scheduleId/taskIdempotencyKey 的确定性共同构成「不重复提醒」。
 */
export function applyReminderDispatches(
  items: readonly TodoItem[],
  dispatches: readonly ReminderDispatch[],
  now: () => number,
): TodoItem[] {
  const updated: TodoItem[] = [];
  for (const dispatch of dispatches) {
    for (const item of items) {
      if (!item.reminder || item.reminder.state !== 'scheduled') continue;
      if (reminderScheduleId(item.id, item.reminder.remindAt.utc) !== dispatch.scheduleId) continue;
      const next: TodoItem = {
        ...item,
        reminder: {
          ...item.reminder,
          state: dispatch.status === 'fired' ? 'delivered' : 'missed',
        },
        updatedAt: isoNow(now),
        revision: item.revision + 1,
      };
      updated.push(next);
    }
  }
  return updated;
}

function isoNow(now: () => number): string {
  return `${new Date(now()).toISOString().slice(0, 19)}.000Z`;
}
