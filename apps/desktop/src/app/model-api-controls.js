/** Renderer-only controls. Invoke must be a restricted trusted-host IPC bridge. */
export function mountModelApiControls(root, invoke) {
  const settings = document.createElement('details');
  settings.className = 'sis-settings';
  settings.innerHTML = `<summary>辅助子任务模型</summary><div class="sis-fields">
    <p class="notice">由主智能体委派时使用；保存配置不会发起模型调用。</p>
    <label>已保存模型<select data-model-api="saved"><option value="">添加模型</option></select></label>
    <label>供应商<select data-model-api="provider"><option value="pangu">盘古</option><option value="openai-compatible">OpenAI 兼容</option></select></label>
    <label>显示名称<input data-model-api="displayName" maxlength="200" autocomplete="off"></label>
    <label>Endpoint<input data-model-api="baseUrl" type="url" maxlength="2048" autocomplete="off" placeholder="https://.../v1"></label>
    <label>模型 ID<input data-model-api="model" maxlength="200" autocomplete="off"></label>
    <label>API Key<input data-model-api="key" type="password" maxlength="8192" autocomplete="new-password" placeholder="同一目的地留空保留，修改目的地需重新填写"></label>
    <label><input data-model-api="enabled" type="checkbox" checked>启用</label>
    <label><input data-model-api="default" type="checkbox">设为默认辅助模型</label>
    <p data-model-api="capabilities" class="notice"></p>
    <button data-model-api="save" type="button">保存加密配置</button>
    <button data-model-api="remove" type="button">删除并撤销</button>
    <p data-model-api="status" class="notice" role="status"></p></div>`;
  root.append(settings);
  const field = name => settings.querySelector(`[data-model-api="${name}"]`);
  let state = {}, busy = false, closed = false;
  const buttons = () => {
    field('save').disabled = busy;
    field('remove').disabled = busy || !field('saved').value;
    field('saved').disabled = busy;
  };
  function select() {
    const entry = state.models?.find(item => item.id === field('saved').value);
    for (const name of ['displayName', 'baseUrl', 'model']) field(name).value = entry?.[name] ?? '';
    field('provider').value = entry?.provider ?? 'pangu';
    field('enabled').checked = entry?.enabled ?? true;
    field('default').checked = Boolean(entry && entry.id === state.defaultId);
    field('key').value = '';
    field('capabilities').textContent = entry
      ? `${entry.available ? '已配置，真实连接尚未验证' : '当前不可用或已停用'} · 文本与 JSON 工具提案；原生工具调用与原生思考参数尚未验证`
      : '执行步骤预算由任务控制；当前没有可选的原生模型思考参数';
    buttons();
  }
  function render(value = {}, selectedId = field('saved').value) {
    if (closed) return;
    state = value;
    field('saved').replaceChildren();
    for (const entry of [{id: '', displayName: '添加模型'}, ...(value.models ?? [])]) {
      const option = document.createElement('option');
      option.value = entry.id;
      option.textContent = entry.displayName;
      field('saved').append(option);
    }
    field('saved').value = value.models?.some(entry => entry.id === selectedId) ? selectedId : '';
    field('status').textContent = value.reason ?? '辅助模型未配置';
    select();
  }
  async function run(operation, payload) {
    busy = true; buttons();
    try {
      const value = await invoke(operation, payload);
      if (value) render(value, payload?.id || value.models?.at(-1)?.id);
    } catch {
      if (!closed) field('status').textContent = '模型配置操作未完成，请检查字段与安全存储';
    } finally {busy = false; if (!closed) buttons();}
  }
  field('saved').onchange = select;
  field('save').onclick = async () => {
    const payload = {provider: field('provider').value, displayName: field('displayName').value,
      baseUrl: field('baseUrl').value, model: field('model').value, apiKey: field('key').value,
      enabled: field('enabled').checked, makeDefault: field('default').checked,
      ...(field('saved').value ? {id: field('saved').value} : {})};
    field('key').value = '';
    try {await run('modelApi.configure', payload);} finally {payload.apiKey = '';}
  };
  field('remove').onclick = () => run('modelApi.remove', {id: field('saved').value});
  select();
  return {render, showSettings(show) {settings.hidden = !show;}, close() {
    closed = true; field('key').value = ''; settings.remove();
  }};
}
