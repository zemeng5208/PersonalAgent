import type { TodoWhen } from './time.js';

export type TodoStatus = 'open' | 'done' | 'cancelled';
export type MissedRunPolicy = 'run_once' | 'skip';
export type ReminderState = 'scheduled' | 'delivered' | 'missed';

export interface TodoReminder {
  remindAt: TodoWhen;
  missedPolicy: MissedRunPolicy;
  state: ReminderState;
}

export interface TodoItem {
  id: string;
  title: string;
  notes?: string;
  status: TodoStatus;
  due?: TodoWhen;
  reminder?: TodoReminder;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface ReminderDispatch {
  scheduleId: string;
  status: 'fired' | 'skipped';
}
