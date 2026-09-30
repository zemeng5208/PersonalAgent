export function mountCalendarControls(root, invoke) {
  const settings = document.createElement('details');
  settings.className = 'sis-settings';
  settings.innerHTML = '<summary>CalDAV 日历配置</summary><div class="sis-fields"><p class="notice">保存连接信息；日历读取能力尚未接入，不会自动读取或修改日历。凭据仅在本机加密保存。</p><label>日历名称<input data-calendar="name" autocomplete="off" maxlength="120"></label><label>HTTPS 日历集合地址<input data-calendar="url" type="url" autocomplete="off" maxlength="2048" placeholder="https://server/calendars/user/default/"></label><label>账号<input data-calendar="user" autocomplete="off" maxlength="256"></label><label>应用密码<input data-calendar="password" type="password" autocomplete="off" maxlength="4096" placeholder="原地址及账号未变时留空可保留已存凭据"></label><button data-calendar="save" type="button">保存配置</button><button data-calendar="revoke" type="button">撤销并清除配置</button><p data-calendar="status" class="notice" role="status"></p></div>';
  const anchor = root.querySelector('#error');
  if (anchor) anchor.before(settings); else root.append(settings);
  const field = name => settings.querySelector(`[data-calendar="${name}"]`);
  let busy = false, state = {};
  const buttons = () => {
    field('save').disabled = busy;
    field('revoke').disabled = busy || (!state.configured && state.status !== 'unavailable');
  };
  const run = async (action, payload) => {
    busy = true; buttons();
    try {render(await invoke(action, payload));}
    catch {field('status').textContent = '日历配置操作未完成，请检查输入及本机安全存储';}
    finally {busy = false; buttons();}
  };
  field('save').onclick = async () => {
    const payload = {providerKind: 'caldav', calendarUrl: field('url').value.trim(),
      calendarName: field('name').value.trim(), username: field('user').value.trim(),
      password: field('password').value};
    field('password').value = '';
    try {await run('calendar.configure', payload);} finally {payload.password = '';}
  };
  field('revoke').onclick = async () => {
    await run('calendar.revoke');
    if (state.status === 'unconfigured' && !state.configured) {
      for (const name of ['name', 'url', 'user', 'password']) field(name).value = '';
    }
  };
  function render(value = {}) {
    state = value ?? {};
    field('status').textContent = `${state.calendarName || 'CalDAV 日历'} · ${state.configured ? '已保存配置' : '未配置'} · ${state.reason ?? '日历读取能力尚未接入'}`;
    buttons();
  }
  return {render, show(show) {
    settings.hidden = !show;
    if (!show) field('password').value = '';
  }, close() {field('password').value = ''; settings.remove();}};
}
