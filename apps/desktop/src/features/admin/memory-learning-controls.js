const escape = value => String(value ?? '').replace(/[&<>"']/g,
  char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));

/** Only metadata and opaque references enter this independent admin component. */
export function memoryLearningControlsHtml({status = {}, refs = [], version = null,
  active = null, taskId = '', message = '', form = {}} = {}) {
  const workflow = version ? `<p>候选 v${escape(version.revision)} · ${escape(version.validation)} ·
    ${version.hasEvidence ? '有 Runtime 验证记录' : '等待验证'}</p>` : '<p>尚未选择流程版本。</p>';
  const memories = refs.map((ref, index) => `<div class="setting-row"><span>私人记忆 ${index + 1} · v${escape(ref.revision)}</span>
    <div class="setting-control"><button class="btn btn-sm" data-ml-withdraw="${index}">撤回消费</button>
    <button class="btn btn-sm" data-ml-delete="${index}">删除历史</button></div></div>`).join('');
  return `<section class="card memory-learning-panel" aria-label="私人记忆与流程学习">
    <h3>私人记忆</h3><p>${status.writeEnabled ? '确认写入已接通' : '写入未接通'} · 当前应用库删除保障</p>
    <p class="muted">撤回立即停止消费；删除保留 Vault 原文件。外部副本由用户自行管理。</p>
    ${memories || '<p>没有选中的私人记忆引用。</p>'}
    <h3>流程学习</h3><p class="muted">固定参考摘要 Skill：验证任务通过后单独确认启用，可选择旧已验证版本回退。</p>
    <div class="settings-form">
    <label>流程 ID<input name="ml-workflow" value="${escape(form.workflowId ?? version?.workflowId ?? 'reference-review')}" maxlength="128"></label>
    <label>参考文件相对路径<input name="ml-path" value="${escape(form.path ?? '')}" placeholder="reference.md" maxlength="480"></label>
    <label>流程说明<input name="ml-summary" value="${escape(form.summary ?? '')}" maxlength="1024" placeholder="读取已授权参考并返回摘要"></label>
    <label>查看版本<input name="ml-revision" type="text" inputmode="numeric" value="${escape(form.revision ?? version?.revision ?? 1)}"></label>
    </div>
    ${workflow}<p>当前启用：${active ? `v${escape(active.revision)}` : '无'}</p>
    ${taskId ? `<p>验证任务：${escape(taskId)}</p>` : ''}
    <div class="form-actions">
      <button class="btn btn-sm" data-ml-action="read">读取版本</button>
      <button class="btn btn-sm" data-ml-action="propose">生成候选</button>
      <button class="btn btn-sm" data-ml-action="startValidation" ${!version || taskId ? 'disabled' : ''}>提交验证任务</button>
      <button class="btn btn-sm" data-ml-action="validate" ${taskId ? '' : 'disabled'}>读回验证</button>
      <button class="btn btn-sm" data-ml-action="activate" ${version?.validation === 'passed' ? '' : 'disabled'}>确认启用此版本</button>
      <button class="btn btn-sm" data-ml-action="run" ${active ? '' : 'disabled'}>运行已启用版本</button>
      <button class="btn btn-sm" data-ml-action="erase" ${version ? '' : 'disabled'}>删除流程</button>
    </div><p class="muted">${status.learningAvailable ? '学习宿主已配置' : '学习宿主未配置'}</p>
    <p role="status" aria-live="polite">${escape(message)}</p></section>`;
}

/** P8 mounts this inside the trusted admin surface; invoke uses its sender-checked preload. */
export function mountMemoryLearningControls(root, {invoke, status, refs = []}) {
  const state = {status, refs: structuredClone(refs), version: null, active: null, taskId: '', message: '', form: {}};
  const events = new AbortController();
  let busy = false;
  let disposed = false;
  const render = () => { if (!disposed) root.innerHTML = memoryLearningControlsHtml(state); };
  render();
  root.addEventListener('click', async event => {
    const button = event.target.closest('button');
    if (!button || !root.contains(button) || busy || button.disabled) return;
    const action = button.dataset.mlAction;
    const withdraw = button.dataset.mlWithdraw;
    const deletion = button.dataset.mlDelete;
    if (!action && withdraw === undefined && deletion === undefined) return;
    const value = name => root.querySelector(`[name="ml-${name}"]`)?.value.trim();
    const workflowId = value('workflow');
    const revision = Number(value('revision'));
    const path = value('path');
    const summary = value('summary');
    const previous = state.version;
    state.form = {workflowId, revision, path, summary};
    busy = true;
    button.disabled = true;
    try {
      let result;
      if (withdraw !== undefined || deletion !== undefined) {
        const index = Number(withdraw ?? deletion);
        const ref = state.refs[index];
        if (!ref) throw Error('请刷新记忆引用');
        result = await invoke(withdraw !== undefined ? 'memory.withdraw' : 'memory.delete', {ref});
        if (result.state === 'withdrawn') state.refs[index] = {...ref, revision: result.revision};
        if (result.state === 'deleted') state.refs.splice(index, 1);
      } else {
        const payload = {workflowId, revision};
        if (action === 'propose') Object.assign(payload, {summary, path,
          expectedRevision: state.version?.workflowId === workflowId ? state.version.revision : null});
        if (action === 'validate') payload.taskId = state.taskId;
        if (action === 'activate') payload.expectedActiveRevision = state.active?.revision ?? null;
        if (action === 'run') payload.revision = state.active.revision;
        if (action === 'erase') payload.expectedRevision = revision;
        result = await invoke(`learning.${action}`, payload);
        if (result.version) state.version = result.version;
        if (action === 'read') {
          state.active = result.active;
          if (previous?.workflowId !== workflowId || previous?.revision !== revision) state.taskId = '';
        }
        if (action === 'propose') state.taskId = '';
        if (result.version) state.form.revision = result.version.revision;
        if (action === 'startValidation') state.taskId = result.taskId;
        if (action === 'activate' && result.state === 'activated') state.active = state.version;
        if (action === 'erase' && result.state === 'deleted') {
          state.version = null; state.active = null; state.taskId = '';
        }
      }
      state.message = result.state === 'declined' ? '已取消确认，未更改。'
        : result.state === 'pending' ? `任务仍为 ${result.taskState}，请在任务区处理后读回。`
          : result.taskId ? `任务已受理：${result.taskId}（${result.state}）`
            : result.version?.validation === 'failed' ? '验证失败，不能启用。'
              : result.state === 'deleted' ? '删除读回完成。'
                : result.state === 'withdrawn' ? '已撤回，后续任务不可消费。' : '状态已读回。';
    } catch (error) { state.message = error?.message ?? '操作失败，请刷新后核对。'; }
    finally { busy = false; render(); }
  }, {signal: events.signal});
  return Object.freeze({dispose() { disposed = true; events.abort(); },
    update({status: next, refs: nextRefs}) {
      if (next) state.status = next;
      if (nextRefs) state.refs = structuredClone(nextRefs);
      render();
    }});
}
