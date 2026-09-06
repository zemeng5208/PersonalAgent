export function orbState(task) {
  if (!task) return 'idle';
  if (task.state === 'planning') return 'thinking';
  if (['running','verifying'].includes(task.state)) return 'executing';
  if (task.state.startsWith('waiting_') || task.state === 'cancelling') return 'waiting';
  return task.state === 'failed' ? 'error' : 'idle';
}
export const stateNames = {created:'已创建',planning:'思考中',running:'执行中',verifying:'验证中',waiting_approval:'等待授权',waiting_external:'等待外部结果',waiting_reconciliation:'结果待核实',cancelling:'正在取消',succeeded:'已完成',failed:'失败',cancelled:'已取消'};
export const isTerminal = task => ['succeeded','failed','cancelled'].includes(task.state);
