export function mountMailControls(root, invoke) {
  const settings = document.createElement('details');
  settings.className = 'sis-settings';
  settings.innerHTML = '<summary>QQ 邮件本地分类</summary><div class="sis-fields"><p class="notice">只读取收件箱信头，在本机 Laya 分类；不读取正文，不发送、移动或删除邮件。允许一次后整批自动分页，随时可以关闭。</p><label>QQ 邮箱<input data-mail="user" type="email" autocomplete="off" maxlength="254"></label><label>IMAP 授权码<input data-mail="key" type="password" autocomplete="off" maxlength="128" placeholder="仅在本机加密保存"></label><label><input data-mail="consent" type="checkbox">允许本会话读取收件箱信头并本地分类</label><button data-mail="save" type="button">保存配置</button><button data-mail="enable" type="button">允许本会话</button><button data-mail="read" type="button">开始批量分类</button><button data-mail="disable" type="button">关闭并撤销</button><p data-mail="status" class="notice" role="status"></p></div>';
  const anchor = root.querySelector('#error');
  if (anchor) anchor.before(settings); else root.append(settings);
  const field = name => settings.querySelector(`[data-mail="${name}"]`);
  let busy = false, state = {};
  const buttons = () => {
    field('save').disabled = busy;
    field('enable').disabled = busy || !state.configured;
    field('read').disabled = busy || !state.configured || !state.sessionAllowed || state.requiresRestart || !state.localModelReady
      || ['unavailable', 'reading', 'waiting_approval', 'classifying', 'stopping', 'stop_unconfirmed'].includes(state.status);
    field('disable').disabled = busy || !state.sessionAllowed;
  };
  const run = async (name, payload) => {
    busy = true; buttons();
    try {
      const result = await invoke(name, payload);
      if (result) render(result);
    } catch {field('status').textContent = '邮箱操作未完成，请查看本地状态或重新配置';}
    finally {busy = false; buttons();}
  };
  field('save').onclick = async () => {
    const payload = {user: field('user').value.trim(), authCode: field('key').value.trim(), readConsent: field('consent').checked};
    field('key').value = '';
    try {await run('mail.configure', payload);} finally {payload.authCode = '';}
  };
  field('enable').onclick = () => run('mail.enable', {readConsent: field('consent').checked});
  field('read').onclick = () => run('mail.read');
  field('disable').onclick = () => run('mail.disable');
  function render(value = {}) {
    state = value;
    const counts = value.counts ?? {};
    const labels = {meeting:'会议', work:'工作', subscription:'订阅', transaction:'订单与账单', personal:'个人', other:'其他'};
    const states = {unconfigured:'未配置', enabled:'已允许', disabled:'已停止', ready:'就绪', unavailable:'不可用',
      reading:'正在读取', running:'正在读取', pending:'等待处理', classifying:'正在分类', classification_unavailable:'分类中断，可重试',
      complete:'本批分类完成', failed:'读取失败', cancelled:'已取消', stop_unconfirmed:'正在确认停止'};
    const groups = Object.entries(counts.groups ?? {}).map(([key,count]) => `${labels[key] || key} ${count}`).join('，');
    field('status').textContent = `${value.account || '未配置邮箱'} · ${states[value.status] || value.status || '未配置'}${value.requiresRestart ? ' · 配置已保存，下次启动生效' : ''} · 已分类 ${counts.total ?? 0}，待核对 ${counts.needsReview ?? 0}，会议候选 ${counts.meetingCandidates ?? 0}${groups ? ` · ${groups}` : ''}${!value.localModelReady ? ' · 请先启动本地 Laya' : ''}${value.reason ? ` · ${value.reason}` : ''}`;
    if (!value.sessionAllowed) field('consent').checked = false;
    buttons();
  }
  return {render, showSettings(show) {settings.hidden = !show;}, close() {field('key').value = ''; settings.remove();}};
}
