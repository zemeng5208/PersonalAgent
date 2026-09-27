const statusNames = {disabled:'未开启',waiting_approval:'等待授权',monitoring:'正在监控',error:'监控异常'};
const analysisNames = {submitting:'正在提交分析',submitted:'分析任务已受理',submission_unknown:'提交结果待核实',pending:'等待分析',running:'正在分析',verifying:'正在核实',waiting_approval:'分析任务等待授权',waiting_external:'等待外部结果',waiting_reconciliation:'等待核实',succeeded:'分析完成',failed:'分析失败',cancelled:'分析已取消',cancelling:'正在取消'};

// Pure snapshot projection, shared by settings and the compact panel.
export function proactiveSuggestions(snapshot) {
  const unique = new Map();
  for (const item of snapshot?.suggestions ?? []) {
    if (typeof item?.id === 'string' && item.id && typeof item.summary === 'string' && item.summary.trim()) unique.set(item.id, item);
  }
  return [...unique.values()];
}

export function mountProactiveControls(container, invoke, {settings = false} = {}) {
  const section = document.createElement('section');
  section.className = settings ? 'feature-page' : 'proactive-notices';
  section.setAttribute('aria-label', settings ? '主动变化提醒设置' : '主动变化提醒');
  section.innerHTML = `<h2>主动变化提醒</h2>${settings ? '<p class="notice">仅读取 CPU / 内存占用，每 30 秒采样一次。本次应用会话最长 8 小时；关闭监控或退出应用立即撤销，重启后不恢复开关。实际执行仍需经过本地 Policy 校验与必要审批。</p><form class="settings-list"><label class="setting-row"><input type="checkbox" name="enabled">开启电脑状态监控</label><label class="setting-row"><input type="checkbox" name="cloudAnalysis">允许持续 CPU / 内存压力触发 AgentArts 自动分析</label><p class="notice">云端分析默认关闭。启用后，持续 CPU / 内存压力会自动触发 AgentArts 分析，仅发送最小脱敏指标：CPU / 内存占用比例、来源及采样时间；也可手动请求分析。保存设置不表示系统调整已获授权。</p><button class="btn btn-sm" type="submit">保存主动提醒设置</button><p class="notice" data-feedback role="status"></p></form>' : ''}<p class="notice" data-status role="status"></p><div data-suggestions></div>`;
  container.append(section);
  const status = section.querySelector('[data-status]');
  const list = section.querySelector('[data-suggestions]');
  const form = section.querySelector('form');
  const feedback = section.querySelector('[data-feedback]');
  let current, dirty = false, saving = false;
  const rows = new Map(), pending = new Set();
  if (form) {
    form.addEventListener('change', () => {dirty = true; feedback.textContent = '有未保存的设置';});
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (saving || !current) return;
      saving = true; form.querySelector('button').disabled = true;
      const payload = {enabled:form.elements.enabled.checked,cloudAnalysis:form.elements.cloudAnalysis.checked};
      form.elements.enabled.disabled = true; form.elements.cloudAnalysis.disabled = true;
      feedback.textContent = '正在保存设置…';
      try {
        await invoke('proactive.configure', payload);
        dirty = false;
        feedback.textContent = '设置已保存。监控与授权状态以当前读回为准；实际执行仍需 Policy 校验。';
      } catch (error) {feedback.textContent = error.message;}
      finally {
        saving = false;
        form.elements.enabled.disabled = !current;
        form.elements.cloudAnalysis.disabled = !current;
        form.querySelector('button').disabled = !current;
      }
    });
  }
  function render(snapshot) {
    current = snapshot;
    const items = proactiveSuggestions(snapshot);
    if (!settings) section.hidden = items.length === 0;
    status.textContent = snapshot ? `${statusNames[snapshot.status] ?? '状态未知'}${snapshot.reason ? ` · ${snapshot.reason}` : ''}` : '主动监控尚未连接';
    if (form) {
      if (!dirty && !saving) {form.elements.enabled.checked = snapshot?.enabled === true; form.elements.cloudAnalysis.checked = snapshot?.cloudAnalysis === true;}
      form.elements.enabled.disabled = !snapshot || saving;
      form.elements.cloudAnalysis.disabled = !snapshot || saving;
      form.querySelector('button').disabled = !snapshot || saving;
    }
    const ids = new Set(items.map(item => item.id));
    for (const [id, row] of rows) if (!ids.has(id)) {row.remove(); rows.delete(id);}
    for (const item of items) {
      let row = rows.get(item.id);
      if (!row) {
        row = document.createElement('article'); row.className = 'task';
        row.innerHTML = '<p data-summary></p><p class="notice" data-analysis></p><p class="assistant-message" data-result></p><button class="btn btn-sm" type="button">交给主智能体分析</button><p class="notice" data-action-status role="status"></p>';
        row.querySelector('button').addEventListener('click', async () => {
          if (row.querySelector('button').disabled || pending.has(item.id)) return;
          pending.add(item.id); row.querySelector('button').disabled = true;
          const receipt = row.querySelector('[data-action-status]'); receipt.textContent = '正在请求分析…';
          try {await invoke('proactive.analyze', {id:item.id}); receipt.textContent = '分析请求已返回，结果以任务状态读回为准。';}
          catch (error) {receipt.textContent = error.message;}
          finally {pending.delete(item.id); render(current);}
        });
        rows.set(item.id, row); list.append(row);
      }
      row.querySelector('[data-summary]').textContent = item.summary;
      const details = [analysisNames[item.analysisState] ?? (item.status === 'suggested' ? '本地建议，尚未执行系统调整' : item.status ?? '')];
      if (item.analysisTaskId) details.push(`任务：${item.analysisTaskId}`);
      row.querySelector('[data-analysis]').textContent = details.filter(Boolean).join(' · ');
      const result = typeof item.result === 'string' ? item.result : typeof item.analysisTask?.resultSummary === 'string' ? item.analysisTask.resultSummary : '';
      row.querySelector('[data-result]').textContent = result;
      row.querySelector('[data-result]').hidden = !result;
      const button = row.querySelector('button');
      const allowed = snapshot?.enabled && snapshot?.cloudAnalysis && snapshot?.status === 'monitoring' && item.kind === 'system_pressure';
      button.disabled = !allowed || Boolean(item.analysisTaskId) || pending.has(item.id);
      button.title = item.analysisTaskId ? '分析任务已受理，请查看任务状态' : item.kind !== 'system_pressure' ? '当前云端授权仅覆盖 CPU / 内存采样；此建议尚无已授权投影' : !snapshot?.cloudAnalysis ? '请在设置 → 电脑操控中开启云端分析' : !allowed ? '请先开启监控并完成必要授权' : '仅提交分析；实际执行仍需 Policy 校验';
    }
  }
  return {render, show(visible) {section.hidden = !visible;}};
}
