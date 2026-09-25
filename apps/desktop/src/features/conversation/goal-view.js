import {stateNames, isTerminal} from './state.js';

export function appliedGoalRef(task) {
  const ref = task?.result?.currentGoal;
  return task?.state === 'succeeded' && task.result.kind === 'applied'
    && Array.isArray(task.evidenceRefs) && task.evidenceRefs.length > 0
    && typeof ref?.id === 'string' && ref.id
    && Number.isSafeInteger(ref.revision) && ref.revision > 0 ? ref : null;
}

// User goals are explicit graph changes. A conversation task never creates one.
// All calls go through the trusted Desktop bridge; this module has no store access.
export function createGoalControl(invoke, getDraftSummary = () => '') {
  if (!document.querySelector('link[data-goal-view]')) {
    const stylesheet = element('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = new URL('./goal-view.css', import.meta.url).href;
    stylesheet.dataset.goalView = '';
    document.head.append(stylesheet);
  }
  const button = element('button', '持续目标（未接通）');
  button.type = 'button';
  button.className = 'goal-open';
  button.setAttribute('aria-haspopup', 'dialog');

  const dialog = element('dialog');
  dialog.className = 'goal-dialog';
  dialog.setAttribute('aria-label', '持续目标');
  dialog.addEventListener('keydown', event => { if (event.key === 'Escape') event.stopPropagation(); });
  const title = element('h2', '持续目标');
  const status = element('p');
  status.setAttribute('aria-live', 'polite');
  const source = element('p', '来源由可信宿主记录。');
  const list = element('div');
  list.setAttribute('aria-label', '已保存的目标');
  const taskHistory = element('div');
  taskHistory.setAttribute('aria-label', '目标写入任务');
  const taskStatus = element('p');
  taskStatus.setAttribute('aria-live', 'polite');
  const taskActions = element('div');
  const readTask = action('刷新任务状态', () => void refreshTask());
  const cancelTask = action('取消目标任务', () => void cancelActiveTask());
  const allow = action('批准一次', () => void decide('allow_once'));
  const deny = action('拒绝', () => void decide('deny'));
  taskActions.append(readTask, cancelTask, allow, deny);

  const form = element('form');
  const id = field('目标 ID', 'input');
  const summary = field('目标内容', 'textarea');
  const reason = field('创建或修订原因', 'input');
  const validFrom = field('开始时间', 'input', 'datetime-local');
  const validUntil = field('截止时间', 'input', 'datetime-local');
  const sensitivity = field('敏感级别', 'select');
  options(sensitivity.control, [['private', '私有'], ['restricted', '受限'], ['public', '公开']]);
  const state = field('状态', 'select');
  options(state.control, [['active', '进行中'], ['withdrawn', '已撤回']]);
  const save = element('button', '保存目标');
  save.type = 'submit';
  form.append(id.label, summary.label, reason.label, validFrom.label, validUntil.label,
    sensitivity.label, state.label, save);

  const newGoal = action('新建目标', resetDraft);
  const reload = action('刷新目标', () => void refreshGoals());
  const close = action('关闭', () => dialog.close());
  dialog.append(title, status, source, list, taskHistory, taskStatus, taskActions,
    form, newGoal, reload, close);

  let graphRevision = null;
  let selected = null;
  let activeTask = null;
  let initialized = false;
  let available = false;
  let outcomeUnknown = false;

  function setStatus(kind, message) {
    status.dataset.state = kind;
    status.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    status.textContent = message;
  }

  function setAvailable(next, message = '') {
    available = next;
    button.textContent = next ? '持续目标（待验收）' : '持续目标（未接通）';
    form.hidden = !next;
    list.hidden = !next;
    newGoal.hidden = !next;
    if (!next) setStatus('unavailable', message || '持续目标尚未接通。');
  }
  setAvailable(false);

  function renderGoals(goals) {
    list.replaceChildren();
    if (!goals.length) list.append(element('p', '暂无已保存的目标。'));
    for (const goal of goals) {
      const row = element('div');
      row.append(element('span', `${goal.summary} · ${goal.state === 'withdrawn' ? '已撤回' : '进行中'} · 版本 ${goal.revision}`),
        action('修订', () => void selectGoal(goal.id)));
      list.append(row);
    }
  }

  async function refreshGoals() {
    try {
      const result = await invoke('goal.list');
      if (!Number.isSafeInteger(result?.graphRevision) || !Array.isArray(result.goals)) {
        throw Error('目标宿主未提供持久列表');
      }
      graphRevision = result.graphRevision;
      renderGoals(result.goals);
      setAvailable(true);
      if (!activeTask) setStatus('ready', '目标列表已从可信宿主读取。');
      return true;
    } catch (error) {
      setAvailable(false, `持续目标尚未接通：${message(error)}`);
      return false;
    }
  }

  async function selectGoal(goalId) {
    try {
      const result = await invoke('goal.get', goalId);
      if (!result?.goal || !Number.isSafeInteger(result.graphRevision)) throw Error('目标已不存在，请刷新列表');
      selected = result.goal;
      graphRevision = result.graphRevision;
      id.control.value = selected.id;
      id.control.readOnly = true;
      summary.control.value = selected.summary;
      reason.control.value = selected.reason;
      validFrom.control.value = toLocalTime(selected.validFrom);
      validUntil.control.value = toLocalTime(selected.validUntil);
      sensitivity.control.value = selected.sensitivity;
      state.control.value = selected.state;
      state.label.hidden = false;
      source.textContent = `来源：${selected.sourceRef}；目标版本 ${selected.revision}，图版本 ${graphRevision}。`;
      save.textContent = '保存修订';
      save.disabled = outcomeUnknown || Boolean(activeTask && !isTerminal(activeTask));
      setStatus('editing', `正在修订目标版本 ${selected.revision}。`);
    } catch (error) {
      setStatus('error', message(error));
    }
  }

  function resetDraft() {
    selected = null;
    form.reset();
    id.control.readOnly = false;
    id.control.value = globalThis.crypto?.randomUUID?.() ?? '';
    summary.control.value = String(getDraftSummary() ?? '').trim();
    validFrom.control.value = toLocalTime(new Date().toISOString());
    sensitivity.control.value = 'private';
    state.control.value = 'active';
    state.label.hidden = true;
    source.textContent = '来源由可信宿主记录；保存前不会写入。';
    save.textContent = '保存目标';
    save.disabled = outcomeUnknown || Boolean(activeTask && !isTerminal(activeTask));
    setStatus('editing', '请填写原因和有效期，再明确保存。');
  }

  function renderTaskHistory(tasks) {
    taskHistory.replaceChildren();
    for (const task of tasks) {
      taskHistory.append(action(`查看写入任务：${stateNames[task.state] ?? task.state}`,
        () => void refreshTask(task.taskId)));
    }
  }

  async function refreshTasks() {
    try {
      const tasks = await invoke('goal.listTasks');
      if (!Array.isArray(tasks)) throw Error('目标任务列表格式无效');
      renderTaskHistory(tasks);
      const pending = tasks.find(task => !isTerminal(task));
      if (pending) await showTask(pending);
    } catch (error) {
      taskStatus.textContent = `目标任务恢复状态暂不可用：${message(error)}`;
    }
  }

  async function refreshTask(taskId = activeTask?.taskId) {
    if (!taskId) return;
    try { await showTask(await invoke('goal.readTask', taskId)); }
    catch (error) { setStatus('error', `任务读回失败：${message(error)}。请勿重复提交。`); }
  }

  async function showTask(task, identified = false) {
    if (!task?.taskId || typeof task.state !== 'string') throw Error('目标任务读回格式无效');
    if (identified) outcomeUnknown = false;
    activeTask = task;
    taskStatus.textContent = `目标任务：${stateNames[task.state] ?? task.state} · 任务版本 ${task.revision}`;
    taskActions.hidden = false;
    readTask.disabled = false;
    cancelTask.hidden = isTerminal(task) || task.state === 'cancelling';
    allow.hidden = deny.hidden = !(task.state === 'waiting_approval' && task.approval?.state === 'pending');
    save.disabled = outcomeUnknown || !isTerminal(task);

    if (task.state === 'waiting_reconciliation') {
      setStatus('pending', '写入结果待核实，请勿重复提交。');
    } else if (task.state === 'cancelling') {
      setStatus('pending', '取消已受理，等待 Runtime 确认终态。');
    } else if (task.state === 'waiting_approval') {
      setStatus('pending', task.approval?.state === 'allowed' ? '授权已批准，等待任务恢复。' : '等待一次性授权决定。');
    } else if (!isTerminal(task)) {
      setStatus('pending', `任务${stateNames[task.state] ?? task.state}，尚未保存成功。`);
    } else if (appliedGoalRef(task)) {
      await verifyAppliedGoal(task);
    } else if (task.result?.kind === 'conflict') {
      await refreshGoals();
      save.disabled = true;
      setStatus('error', `目标版本冲突，当前图版本 ${task.result.graphRevision}；草稿已保留，请核对后重试。`);
    } else if (task.result?.kind === 'rejected') {
      setStatus('error', '目标写入被拒绝；没有保存成功。');
    } else {
      if (task.state === 'succeeded') save.disabled = true;
      setStatus('error', `目标任务${stateNames[task.state] ?? task.state}；${task.error?.message ?? '未取得经确认的目标读回'}。`);
    }
  }

  async function verifyAppliedGoal(task) {
    const ref = task.result.currentGoal;
    try {
      const readback = await invoke('goal.get', ref.id);
      if (!readback?.goal || readback.goal.id !== ref.id || readback.goal.revision !== ref.revision
        || readback.graphRevision < task.result.graphRevision) throw Error('目标版本与写入回执不一致');
      selected = readback.goal;
      graphRevision = readback.graphRevision;
      id.control.value = selected.id;
      id.control.readOnly = true;
      sensitivity.control.value = selected.sensitivity;
      state.control.value = selected.state;
      source.textContent = `来源：${selected.sourceRef}；目标版本 ${selected.revision}，图版本 ${graphRevision}。`;
      state.label.hidden = false;
      save.textContent = '保存修订';
      if (!(await refreshGoals())) throw Error('目标列表读回不可用');
      const previous = task.result.previousGoal?.revision ?? '新建';
      setStatus('saved', `目标已确认并读回：版本 ${previous} → ${ref.revision}，图版本 ${task.result.graphRevision}。`);
    } catch (error) {
      save.disabled = true;
      setStatus('error', `任务已结束，但目标读回尚未验证：${message(error)}。请勿重复提交。`);
    }
  }

  async function cancelActiveTask() {
    if (!activeTask || isTerminal(activeTask)) return;
    cancelTask.disabled = true;
    try {
      const result = await invoke('goal.cancel', activeTask.taskId);
      if (result?.task) await showTask(result.task);
      if (result?.cancelAccepted && !isTerminal(result.task ?? activeTask)) {
        setStatus('pending', '取消已受理，等待 Runtime 终态；写入结果仍需核实。');
      }
    } catch (error) { setStatus('error', `取消请求状态未知：${message(error)}。请刷新任务状态。`); }
    finally { cancelTask.disabled = false; }
  }

  async function decide(decision) {
    const approval = activeTask?.approval;
    if (activeTask?.state !== 'waiting_approval' || approval?.state !== 'pending') return;
    allow.disabled = deny.disabled = true;
    try {
      await invoke('authorization.respond', {approvalId: approval.approvalId,
        decision, expectedRevision: approval.revision, taskId: activeTask.taskId});
      setStatus('pending', decision === 'deny' ? '拒绝已提交，等待 Runtime 终态。' : '批准已提交，等待任务恢复。');
      await refreshTask(activeTask.taskId);
    } catch (error) { setStatus('error', `授权决定状态未知：${message(error)}。请刷新任务状态，勿重复决定。`); }
    finally { allow.disabled = deny.disabled = false; }
  }

  button.onclick = async () => {
    if (!initialized) { resetDraft(); initialized = true; }
    dialog.showModal();
    if (await refreshGoals()) await refreshTasks();
  };
  reload.onclick = () => void refreshGoals();
  form.onsubmit = async event => {
    event.preventDefault();
    if (!available || outcomeUnknown || !Number.isSafeInteger(graphRevision)
      || (activeTask && !isTerminal(activeTask))) return;
    const start = Date.parse(validFrom.control.value);
    const end = Date.parse(validUntil.control.value);
    if (!id.control.value.trim() || !summary.control.value.trim() || !reason.control.value.trim()
      || !Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
      setStatus('error', '请填写目标 ID、内容、原因和有效的起止时间。');
      return;
    }
    const goal = {id: id.control.value.trim(), summary: summary.control.value.trim(),
      validFrom: new Date(start).toISOString(), validUntil: new Date(end).toISOString(),
      sensitivity: sensitivity.control.value, state: selected ? state.control.value : 'active',
      reason: reason.control.value.trim(), dependencies: selected?.dependencies ?? []};
    const payload = {expectedGraphRevision: graphRevision,
      ...(selected ? {expectedGoalRevision: selected.revision} : {}), goal};
    save.disabled = true;
    outcomeUnknown = true;
    setStatus('pending', '目标写入任务正在提交；受理不等于完成。');
    try { await showTask(await invoke(selected ? 'goal.revise' : 'goal.create', payload), true); }
    catch (error) { setStatus('error', `提交结果未知：${message(error)}。草稿已保留，请核对目标任务；勿重复提交。`); }
  };

  taskActions.hidden = true;
  return {button, dialog};
}

function element(tag, text = '') {
  const value = document.createElement(tag);
  value.textContent = text;
  return value;
}
function action(text, callback) {
  const button = element('button', text);
  button.type = 'button';
  button.onclick = callback;
  return button;
}
function field(name, tag, type) {
  const label = element('label', name);
  const control = element(tag);
  if (type) control.type = type;
  control.setAttribute('aria-label', name);
  label.append(control);
  return {label, control};
}
function options(select, values) {
  for (const [value, label] of values) {
    const option = element('option', label);
    option.value = value;
    select.append(option);
  }
}
function message(error) { return error?.message || String(error); }
function toLocalTime(iso) {
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
