import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import path from 'node:path';

// Desktop-owned metadata. Runtime still owns task state and results.
export class Conversations {
  constructor(file) {
    this.file = file;
    this.turns = new Map();
    if (file && existsSync(file)) {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.turns)) throw Error('对话记录格式无法读取');
      for (const turn of data.turns) {
        if (typeof turn.taskId === 'string' && ['panel','workspace'].includes(turn.surface) && typeof turn.goal === 'string') this.turns.set(turn.taskId, turn);
      }
    }
  }
  surface(taskId) { return this.turns.get(taskId)?.surface ?? 'panel'; }
  goal(taskId) { return this.turns.get(taskId)?.goal; }
  add(taskId, surface, goal) {
    this.turns.set(taskId, {taskId, surface, goal, createdAt:new Date().toISOString()});
    if (!this.file) return;
    mkdirSync(path.dirname(this.file), {recursive:true});
    const temporary = `${this.file}.tmp-${process.pid}`;
    writeFileSync(temporary, JSON.stringify({version:1,turns:[...this.turns.values()]}), 'utf8');
    renameSync(temporary, this.file);
  }
  history(tasks, taskId) {
    const surface = this.surface(taskId);
    const messages = [];
    for (const task of tasks) {
      if (task.taskId === taskId) break;
      const goal = this.goal(task.taskId);
      if (!goal || this.surface(task.taskId) !== surface || task.state !== 'succeeded') continue;
      const answer = (task.resultSummary ?? '').replace(/\s*\[model=[^;\]]+;\s*verification=[^;\]]+;\s*tokens=[^\]]+\]\s*$/, '').trim();
      if (answer) messages.push({role:'user',content:goal},{role:'assistant',content:answer});
    }
    return messages;
  }
}
