export function mountLiveVoiceControls(root, invoke) {
  const settings = document.createElement('details');
  settings.className = 'sis-settings';
  settings.innerHTML = '<summary>Live 实时语音设置</summary><div class="sis-fields"><p class="notice">千问负责实时听说；工作由同一个 AgentArts 主智能体执行。使用百炼北京业务空间。</p><label>业务空间 ID<input id="live-workspace" autocomplete="off" maxlength="128"></label><label>百炼 API Key<input id="live-key" type="password" autocomplete="off" maxlength="4096" placeholder="仅在本机加密保存"></label><label>启停快捷键<select id="live-hotkey">'+Array.from({length:12},(_,i)=>`<option${i===7?' selected':''}>F${i+1}</option>`).join('')+'</select></label><label><input id="live-consent" type="checkbox">开启 Live 时将麦克风音频和对话上下文发送到阿里云，用于实时对话</label><button id="live-save" type="button">保存 Live 配置</button><p class="notice" id="live-config-result" role="status"></p></div>';
  const status = document.createElement('p'); status.className = 'notice'; status.setAttribute('role', 'status');
  root.querySelector('#error').before(settings, status);
  const key = settings.querySelector('#live-key'), workspace = settings.querySelector('#live-workspace');
  const hotkey = settings.querySelector('#live-hotkey'), consent = settings.querySelector('#live-consent');
  const result = settings.querySelector('#live-config-result');
  let editing = false;
  settings.addEventListener('input', () => {editing = true;});
  settings.querySelector('#live-save').onclick = async () => {
    const button = settings.querySelector('#live-save'); button.disabled = true;
    const request = {workspaceId: workspace.value.trim(), apiKey: key.value.trim(), hotkey: hotkey.value, audioConsent: consent.checked};
    key.value = ''; result.textContent = '正在加密保存…';
    try {await invoke('live.configure', request); editing = false; result.textContent = '已保存；点圆形语音按钮或按快捷键开始 Live。'; settings.open = false;}
    catch (error) {result.textContent = error.message;}
    finally {request.apiKey = ''; button.disabled = false;}
  };
  return {
    showSettings(show, expanded = false) {
      settings.hidden = !show; status.hidden = !show;
      if (show && expanded) settings.open = true;
    },
    async toggle() {
      try {await invoke('live.toggle');}
      catch (error) {result.textContent = error.message; settings.open = true;}
    },
    render(live = {}) {
      if (!editing) {workspace.value = live.workspaceId ?? ''; hotkey.value = live.hotkey ?? 'F8'; consent.checked = Boolean(live.configured);}
      const names = {connecting:'正在连接',reconnecting:'正在续接',listening:'正在聆听',speaking:'正在回答',working:'主智能体正在处理任务',stopping:'正在关闭',idle:'已关闭',error:'连接失败'};
      status.textContent = `Live：${names[live.status] ?? '未配置'} · ${live.shortcut?.key ?? 'F8'} 开启 / 关闭`;
      if (live.status === 'error' || !live.configured) status.textContent += ` · ${live.reason ?? '请先配置'}`;
      if (live.shortcut?.reason) status.textContent += ` · ${live.shortcut.reason}`;
    },
  };
}
