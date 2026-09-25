// Explicit user goals are separate from one-off conversation tasks.
// The trusted Desktop host owns authorization, source identity, and persistence.
export function createGoalControl(invoke, getDraftSummary = () => '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = '持续目标（未接通）';
  button.setAttribute('aria-haspopup', 'dialog');

  const dialog = document.createElement('dialog');
  dialog.setAttribute('aria-label', '持续目标');
  const title = document.createElement('h2');
  title.textContent = '持续目标';
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  const list = document.createElement('div');
  list.setAttribute('aria-label', '已保存的目标');
  const form = document.createElement('form');
  const summary = field('目标内容', 'textarea');
  const reason = field('创建或修订原因', 'input');
  const validFrom = field('开始时间', 'input', 'datetime-local');
  const validUntil = field('截止时间', 'input', 'datetime-local');
  const state = field('状态', 'select');
  for (const [value, label] of [['active', '进行中'], ['withdrawn', '已撤回']]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    state.control.append(option);
  }
  const save = document.createElement('button');
  save.type = 'submit';
  save.textContent = '保存目标';
  const newGoal = document.createElement('button');
  newGoal.type = 'button';
  newGoal.textContent = '新建目标';
  const reload = document.createElement('button');
  reload.type = 'button';
  reload.textContent = '刷新目标';
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '关闭';
  close.onclick = () => dialog.close();
  form.append(summary.label, reason.label, validFrom.label, validUntil.label, state.label, save);
  dialog.append(title, status, list, form, newGoal, reload, close);

  let graphRevision = null;
  let selected = null;
  const setAvailable = available => {
    button.textContent = available ? '持续目标' : '持续目标（未接通）';
    form.hidden = !available;
    list.hidden = !available;
    newGoal.hidden = !available;
    status.textContent = available ? '' : '持续目标尚未接通。';
  };
  setAvailable(false);

  function renderGoals(goals) {
    list.replaceChildren();
    for (const goal of goals) {
      const row = document.createElement('div');
      const description = document.createElement('span');
      description.textContent = `${goal.summary} · ${goal.state === 'withdrawn' ? '已撤回' : '进行中'} · 版本 ${goal.revision}`;
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.textContent = '修订';
      edit.onclick = () => void selectGoal(goal.id);
      row.append(description, edit);
      list.append(row);
    }
  }

  async function refresh() {
    try {
      const result = await invoke('goal.list');
      if (result?.available !== true || !Number.isSafeInteger(result.graphRevision) || !Array.isArray(result.goals)) {
        throw new Error('目标服务未提供可用的持久列表');
      }
      graphRevision = result.graphRevision;
      renderGoals(result.goals);
      setAvailable(true);
      return true;
    } catch (error) {
      setAvailable(false);
      status.textContent = `持续目标尚未接通：${error.message || String(error)}`;
      return false;
    }
  }

  async function selectGoal(id) {
    try {
      const result = await invoke('goal.get', {id});
      if (!result?.goal || !Number.isSafeInteger(result.graphRevision)) throw new Error('目标已不存在，请刷新列表');
      selected = result.goal;
      graphRevision = result.graphRevision;
      summary.control.value = selected.summary;
      reason.control.value = selected.reason;
      validFrom.control.value = toLocalTime(selected.validFrom);
      validUntil.control.value = toLocalTime(selected.validUntil);
      state.control.value = selected.state;
      state.label.hidden = false;
      save.textContent = '保存修订';
      status.textContent = `正在修订版本 ${selected.revision}`;
    } catch (error) {
      status.textContent = error.message || String(error);
    }
  }

  newGoal.onclick = () => {
    selected = null;
    form.reset();
    summary.control.value = getDraftSummary().trim();
    validFrom.control.value = toLocalTime(new Date().toISOString());
    state.label.hidden = true;
    save.textContent = '保存目标';
    status.textContent = '';
  };
  reload.onclick = () => void refresh();
  button.onclick = async () => {
    newGoal.click();
    dialog.showModal();
    await refresh();
  };

  form.onsubmit = async event => {
    event.preventDefault();
    if (!Number.isSafeInteger(graphRevision)) return;
    const start = Date.parse(validFrom.control.value);
    const end = Date.parse(validUntil.control.value);
    if (!summary.control.value.trim() || !reason.control.value.trim()
      || !Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
      status.textContent = '请填写目标、原因和有效的起止时间。';
      return;
    }
    const payload = {
      summary: summary.control.value.trim(),
      reason: reason.control.value.trim(),
      validFrom: new Date(start).toISOString(),
      validUntil: new Date(end).toISOString(),
      expectedGraphRevision: graphRevision,
      ...(selected ? {id: selected.id, expectedGoalRevision: selected.revision, state: state.control.value} : {}),
    };
    save.disabled = true;
    try {
      const result = await invoke(selected ? 'goal.revise' : 'goal.create', payload);
      if (!result?.goal || !Number.isSafeInteger(result.graphRevision)) throw new Error('未收到目标持久读回');
      selected = result.goal;
      status.textContent = `已保存并读回目标版本 ${selected.revision}`;
      await refresh();
      status.textContent = `已保存并读回目标版本 ${selected.revision}`;
    } catch (error) {
      status.textContent = `保存失败：${error.message || String(error)}。请刷新列表核对版本后重试。`;
    } finally {
      save.disabled = false;
    }
  };

  return {button, dialog};
}

function field(name, tag, type) {
  const label = document.createElement('label');
  label.textContent = name;
  const control = document.createElement(tag);
  if (type) control.type = type;
  control.setAttribute('aria-label', name);
  label.append(control);
  return {label, control};
}

function toLocalTime(iso) {
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
