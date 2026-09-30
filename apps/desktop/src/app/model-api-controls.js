/** Safe presentation only; the trusted host independently enforces the declaration. */
export function describeModelThinking(entry, depth) {
  if (depth !== undefined && (!Number.isInteger(depth) || depth < 0 || depth > 5)) throw Error('思考深度无效');
  const requestedEffort = depth === undefined ? null : ['none', 'low', 'low', 'medium', 'high', 'high'][depth];
  const supported = Boolean(entry?.available && requestedEffort !== null && entry.reasoningEfforts?.includes(requestedEffort));
  return {configurationRef: entry?.configurationRef ?? '', depth: depth ?? null,
    stepBudget: {maxSteps: depth === undefined ? 6 : Math.max(2, (depth + 1) * 2)},
    modelReasoning: {requestedEffort, effort: supported ? requestedEffort : null, supported,
      verification: 'conditional', thinkingBudgetSupported: false,
      reason: supported ? '按此配置声明发送 reasoning_effort，真实端点尚未验证'
        : '此档位未声明原生推理支持，仅调整执行步骤预算'}};
}

/** Renderer-only controls. Invoke must be a restricted trusted-host IPC bridge. */
export function mountModelApiControls(root, invoke) {
  const settings = document.createElement('details');
  settings.className = 'sis-settings';
  settings.innerHTML = `<summary>辅助子任务模型</summary><div class="sis-fields">
    <p class="notice">由主智能体委派时使用；保存配置不会发起模型调用。</p>
    <p data-model-api="defaultExecution" class="notice"></p>
    <label>已保存模型<select data-model-api="saved"><option value="">添加模型</option></select></label>
    <label>供应商<select data-model-api="provider"><option value="pangu">盘古</option><option value="openai-compatible">OpenAI 兼容</option></select></label>
    <label>显示名称<input data-model-api="displayName" maxlength="200" autocomplete="off"></label>
    <label>Endpoint<input data-model-api="baseUrl" type="url" maxlength="2048" autocomplete="off" placeholder="https://.../v1"></label>
    <label>模型 ID<input data-model-api="model" maxlength="200" autocomplete="off"></label>
    <label>API Key<input data-model-api="key" type="password" maxlength="8192" autocomplete="new-password" placeholder="同一目的地留空保留，修改目的地需重新填写"></label>
    <label><input data-model-api="enabled" type="checkbox" checked>启用</label>
    <label><input data-model-api="default" type="checkbox">设为独立 API 默认选项</label>
    <fieldset><legend>当前模型支持的 reasoning_effort</legend>
      <p class="notice">请根据供应商文档或已有验证声明；未知模型保持不选。更改供应商、Endpoint 或模型后需重新确认。</p>
      ${['none', 'low', 'medium', 'high'].map(effort => `<label><input data-model-effort="${effort}" type="checkbox">${effort}</label>`).join('')}
      <label><input data-model-api="reasoningConfirmed" type="checkbox">确认此目的地与模型支持所选参数</label>
    </fieldset>
    <p data-model-api="capabilities" class="notice"></p>
    <button data-model-api="save" type="button">保存加密配置</button>
    <button data-model-api="remove" type="button">删除并撤销</button>
    <p data-model-api="status" class="notice" role="status"></p></div>`;
  root.append(settings);
  const field = name => settings.querySelector(`[data-model-api="${name}"]`);
  let state = {}, busy = false, closed = false;
  const effortInputs = [...settings.querySelectorAll('[data-model-effort]')];
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
    for (const input of effortInputs) input.checked = Boolean(entry?.reasoningEfforts?.includes(input.dataset.modelEffort));
    field('reasoningConfirmed').checked = Boolean(entry?.reasoningEfforts?.length);
    field('capabilities').textContent = entry
      ? `${entry.available ? '已配置，真实连接尚未验证' : '当前不可用或已停用'} · 文本与 JSON 工具提案；原生推理${entry.reasoningEfforts?.length ? `已声明 ${entry.reasoningEfforts.join(' / ')}，真实端点尚未验证` : '未声明'}；thinkingBudget 不支持`
      : '执行步骤预算由任务控制；原生推理默认不发送，thinkingBudget 不支持';
    buttons();
  }
  function render(value = {}, selectedId = field('saved').value) {
    if (closed) return;
    state = value;
    field('defaultExecution').textContent = value.defaultExecution?.reason
      ?? '默认 AgentArts 子任务执行器尚未公布；独立 API 按子对话明确选型使用';
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
  for (const name of ['provider', 'baseUrl', 'model']) field(name).addEventListener('input', () => {
    for (const input of effortInputs) input.checked = false;
    field('reasoningConfirmed').checked = false;
    field('capabilities').textContent = '目的地或模型已更改，请重新声明支持列表；真实端点尚未验证';
  });
  field('save').onclick = async () => {
    const selected = state.models?.find(entry => entry.id === field('saved').value);
    const payload = {provider: field('provider').value, displayName: field('displayName').value,
      baseUrl: field('baseUrl').value, model: field('model').value, apiKey: field('key').value,
      enabled: field('enabled').checked, makeDefault: field('default').checked,
      reasoningEfforts: effortInputs.filter(input => input.checked).map(input => input.dataset.modelEffort),
      reasoningSupportConfirmed: field('reasoningConfirmed').checked,
      ...(selected?.configurationRef ? {expectedConfigurationRef: selected.configurationRef} : {}),
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
