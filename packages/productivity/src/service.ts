import { ProtocolError } from '@personal-agent/contracts';
import type { StoragePort } from '@personal-agent/contracts';
import type { MissedRunPolicy, ReminderState, TodoItem, TodoStatus } from './item.js';
import { assertWhenValid, resolveWhen, type TodoWhen, type WhenInput } from './time.js';

export interface TodoServiceOptions {
  now: () => number;
  idFactory: () => string;
}

export interface ReminderInput {
  remindAt: WhenInput;
  missedPolicy?: MissedRunPolicy;
}

export interface TodoCreateInput {
  title: string;
  notes?: string;
  due?: WhenInput;
  reminder?: ReminderInput;
}

export interface TodoUpdateInput {
  title?: string;
  notes?: string;
  status?: TodoStatus;
  due?: WhenInput;
  reminder?: ReminderInput;
  clearDue?: boolean;
  clearReminder?: boolean;
}

const IDS_KEY = 'todo:ids';
const ITEM_PREFIX = 'todo:item:';

export class TodoService {
  constructor(
    private readonly storage: StoragePort,
    private readonly options: TodoServiceOptions,
  ) {}

  create(input: TodoCreateInput): TodoItem {
    if (!input || typeof input !== 'object') throw new ProtocolError('INVALID_ARGUMENT', 'Create input must be an object');
    if (typeof input.title !== 'string' || input.title.trim().length === 0) {
      throw new ProtocolError('INVALID_ARGUMENT', 'Title must be a non-empty string');
    }
    if (input.title.length > 200) throw new ProtocolError('INVALID_ARGUMENT', 'Title must be at most 200 characters');
    if (input.notes !== undefined && (typeof input.notes !== 'string' || input.notes.length > 2000)) {
      throw new ProtocolError('INVALID_ARGUMENT', 'Notes must be a string of at most 2000 characters');
    }
    const due = input.due === undefined ? undefined : resolveWhen(input.due, 'due');
    if (due !== undefined) assertWhenValid(due, 'due');
    const reminder = this.resolveReminder(input.reminder, due);
    const nowUtc = this.isoNow();
    const item: TodoItem = {
      id: this.options.idFactory(),
      title: input.title,
      status: 'open',
      createdAt: nowUtc,
      updatedAt: nowUtc,
      revision: 1,
    };
    if (input.notes !== undefined) item.notes = input.notes;
    if (due !== undefined) item.due = due;
    if (reminder !== undefined) item.reminder = reminder;
    this.write(item);
    return structuredClone(item);
  }

  update(id: string, patch: TodoUpdateInput): TodoItem {
    const current = this.get(id);
    if (!patch || typeof patch !== 'object') throw new ProtocolError('INVALID_ARGUMENT', 'Update patch must be an object');
    const next: TodoItem = {...current};
    if (patch.title !== undefined) {
      if (typeof patch.title !== 'string' || patch.title.trim().length === 0 || patch.title.length > 200) {
        throw new ProtocolError('INVALID_ARGUMENT', 'Title must be a non-empty string of at most 200 characters');
      }
      next.title = patch.title;
    }
    if (patch.notes !== undefined) {
      if (typeof patch.notes !== 'string' || patch.notes.length > 2000) {
        throw new ProtocolError('INVALID_ARGUMENT', 'Notes must be a string of at most 2000 characters');
      }
      next.notes = patch.notes;
    }
    if (patch.status !== undefined) {
      this.assertTransition(current.status, patch.status);
      next.status = patch.status;
    }
    if (patch.clearDue && patch.due !== undefined) {
      throw new ProtocolError('INVALID_ARGUMENT', 'clearDue and due are mutually exclusive');
    }
    if (patch.clearReminder && patch.reminder !== undefined) {
      throw new ProtocolError('INVALID_ARGUMENT', 'clearReminder and reminder are mutually exclusive');
    }
    if (patch.clearDue) delete next.due;
    if (patch.clearReminder) delete next.reminder;
    if (patch.due !== undefined) {
      next.due = resolveWhen(patch.due, 'due');
      assertWhenValid(next.due, 'due');
    }
    if (patch.reminder !== undefined) {
      const reminder = this.resolveReminder(patch.reminder, next.due);
      if (reminder !== undefined) next.reminder = reminder;
    }
    // 截止时间改动后重验既有提醒：把 due 提前到提醒之后而不同步调整提醒，会留下一个
    // 在截止之后才响的提醒——这正是「改期重验」要拦下的状态。
    if (next.due !== undefined && next.reminder !== undefined && Date.parse(next.reminder.remindAt.utc) > Date.parse(next.due.utc)) {
      throw new ProtocolError('INVALID_ARGUMENT', 'Reminder must not be after due; move the reminder together with the new due time');
    }
    const changed = jsonOf(next) !== jsonOf(current);
    if (!changed) return structuredClone(current);
    next.updatedAt = this.isoNow();
    next.revision = current.revision + 1;
    this.write(next);
    return structuredClone(next);
  }

  get(id: string): TodoItem {
    if (typeof id !== 'string' || id.length === 0) throw new ProtocolError('INVALID_ARGUMENT', 'Item id must be a non-empty string');
    const stored = this.storage.get(ITEM_PREFIX + id);
    if (!isTodoItem(stored)) throw new ProtocolError('NOT_FOUND', `Todo item ${id} not found`);
    return stored;
  }

  list(filter?: {status?: TodoStatus}): TodoItem[] {
    const ids = this.readIds();
    const items = ids.map(id => this.get(id));
    if (filter?.status === undefined) return items;
    return items.filter(item => item.status === filter.status);
  }

  /** 供宿主把 dispatch 后的条目写回（applyReminderDispatches 的产物）。 */
  save(item: TodoItem): void {
    if (!isTodoItem(item)) throw new ProtocolError('INVALID_ARGUMENT', 'Not a todo item');
    const existing = this.storage.get(ITEM_PREFIX + item.id);
    if (!isTodoItem(existing)) throw new ProtocolError('NOT_FOUND', `Todo item ${item.id} not found`);
    if (item.revision <= existing.revision) {
      throw new ProtocolError('INVALID_ARGUMENT', 'Revision must increase');
    }
    this.write(item);
  }

  private resolveReminder(input: ReminderInput | undefined, due: TodoWhen | undefined): {remindAt: TodoWhen; missedPolicy: MissedRunPolicy; state: ReminderState} | undefined {
    if (input === undefined) return undefined;
    if (!input || typeof input !== 'object' || !input.remindAt) {
      throw new ProtocolError('INVALID_ARGUMENT', 'Reminder requires remindAt');
    }
    const remindAt = resolveWhen(input.remindAt, 'reminder.remindAt');
    assertWhenValid(remindAt, 'reminder.remindAt');
    if (due !== undefined && Date.parse(remindAt.utc) > Date.parse(due.utc)) {
      throw new ProtocolError('INVALID_ARGUMENT', 'Reminder must not be after due');
    }
    const missedPolicy: MissedRunPolicy = input.missedPolicy ?? 'run_once';
    if (missedPolicy !== 'run_once' && missedPolicy !== 'skip') {
      throw new ProtocolError('INVALID_ARGUMENT', 'missedPolicy must be run_once or skip');
    }
    return {remindAt, missedPolicy, state: 'scheduled'};
  }

  private assertTransition(from: TodoStatus, to: TodoStatus): void {
    if (to !== 'open' && to !== 'done' && to !== 'cancelled') {
      throw new ProtocolError('INVALID_ARGUMENT', 'Status must be open, done or cancelled');
    }
    if (from !== 'open' && from !== to) {
      throw new ProtocolError('INVALID_ARGUMENT', `Terminal status ${from} cannot transition to ${to}`);
    }
    if (from === 'open' && to === 'open') return;
  }

  private write(item: TodoItem): void {
    const ids = this.readIds();
    if (!ids.includes(item.id)) {
      ids.push(item.id);
      this.storage.set(IDS_KEY, ids);
    }
    this.storage.set(ITEM_PREFIX + item.id, structuredClone(item));
  }

  private readIds(): string[] {
    const ids = this.storage.get(IDS_KEY);
    return Array.isArray(ids) ? ids.filter(id => typeof id === 'string') : [];
  }

  private isoNow(): string {
    return `${new Date(this.options.now()).toISOString().slice(0, 19)}.000Z`;
  }
}

function jsonOf(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, sortKeys(entry)]).sort(([a], [b]) => String(a).localeCompare(String(b))));
  }
  return value;
}

function isTodoItem(value: unknown): value is TodoItem {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== 'string' || typeof item.title !== 'string' || typeof item.createdAt !== 'string' || typeof item.updatedAt !== 'string' || typeof item.revision !== 'number') return false;
  if (item.status !== 'open' && item.status !== 'done' && item.status !== 'cancelled') return false;
  return true;
}
