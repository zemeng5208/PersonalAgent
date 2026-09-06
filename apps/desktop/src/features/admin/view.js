import {stateNames} from '../conversation/state.js';

export const sections = {
  overview: '概览',
  capabilities: '能力',
  models: '模型',
  connections: '连接',
  tasks: '任务',
  memory: '记忆',
  authorizations: '授权',
  settings: '设置',
};

const tone = state => ['ready', 'connected'].includes(state) ? 'ready' : ['unavailable', 'disconnected', '未连接'].includes(state) ? 'off' : 'warn';
const badge = (label, state) => `<span class="badge" data-tone="${tone(state)}"><span class="badge-dot"></span>${label}</span>`;

export function mountAdmin(root, invoke, escape) {
  let section = 'overview';
  let current = {tasks: [], capabilities: [], health: [], approvals: []};
  root.innerHTML = `<div class="admin"><header class="admin-bar"><span class="admin-title">PersonalAgent · 管理后台</span><span class="spacer"></span><button class="icon-btn hdr-btn" id="admin-close" title="关闭" aria-label="关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6 6 18"/></svg></button></header><aside class="side"><div class="brand">PersonalAgent</div><nav>${Object.entries(sections).map(([id, title]) => `<button data-page="${id}">${title}</button>`).join('')}</nav><footer>私人助理 · Windows<br>冷光青 / 标准毛玻璃</footer></aside><section class="main"><div class="eyebrow">PERSONAL WORKSPACE</div><h1 id="page-title"></h1><div class="banner" id="connection"></div><div id="content"></div><p class="error" role="alert" id="error"></p></section></div>`;

  function taskTable(data) {
    const rows = data.tasks.map(task => `<tr><td>${escape(task.taskId)}</td><td>${stateNames[task.state] ?? escape(task.state)}</td><td>${task.revision}</td><td>${escape(task.resultSummary ?? '—')}</td></tr>`).join('');
    return `<div class="sheet"><h2>任务记录</h2><div class="table-scroll"><table><thead><tr><th>任务</th><th>状态</th><th>版本</th><th>结果</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="empty">还没有任务<br>从悬浮面板开始新的对话</td></tr>'}</tbody></table></div></div>`;
  }

  function capabilityTable(data) {
    const rows = data.capabilities.map(item => `<tr><td>${escape(item.name ?? item.id ?? '—')}</td><td>${escape(item.version ?? '—')}</td><td>${escape(item.sideEffect ?? item.kind ?? '—')}</td><td>${escape((item.requiredScopes ?? item.capabilities ?? []).join(', ') || '—')}</td></tr>`).join('');
    return `<div class="sheet"><div class="row"><h2>已注册能力</h2><span class="spacer"></span><button class="btn btn-sm" id="refresh-capabilities">刷新</button></div><div class="table-scroll"><table><thead><tr><th>名称</th><th>版本</th><th>副作用</th><th>范围</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="empty">Runtime 当前没有公开能力目录。</td></tr>'}</tbody></table></div></div>`;
  }

  function healthTable(data) {
    const rows = data.health.map(item => `<tr><td>${escape(item.id)}</td><td>${badge(escape(item.state), item.state)}</td><td>${escape(item.reason ?? '—')}</td></tr>`).join('');
    return `<div class="sheet"><h2>连接健康</h2><div class="table-scroll"><table><thead><tr><th>能力</th><th>状态</th><th>说明</th></tr></thead><tbody>${rows || '<tr><td colspan="3" class="empty">暂无连接器健康信息。</td></tr>'}</tbody></table></div></div>`;
  }

  function authorizationList(data) {
    const rows = data.approvals.map(item => `<tr><td>${escape(item.approvalId)}</td><td>${escape(item.taskId)}</td><td>${escape(item.action)}</td><td>${item.revision}<br><button class="btn btn-sm" data-approval="allow_once" data-id="${escape(item.approvalId)}" data-task="${escape(item.taskId)}" data-revision="${item.revision}">允许一次</button> <button class="btn btn-sm btn-danger" data-approval="deny" data-id="${escape(item.approvalId)}" data-task="${escape(item.taskId)}" data-revision="${item.revision}">拒绝</button></td></tr>`).join('');
    return `<div class="sheet"><h2>待处理授权</h2><div class="table-scroll"><table><thead><tr><th>授权</th><th>任务</th><th>动作</th><th>决定</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="empty">没有待处理授权。授权决定由 Runtime 校验，界面不直接授予权限。</td></tr>'}</tbody></table></div></div>`;
  }

  function modelSettings(data) {
    const model = data.model ?? {};
    const thinking = data.thinking ?? {depth: 1, fast: false, reason: 'Runtime 尚未公开思考参数契约'};
    const status = model.status === 'ready' ? '已测试' : model.status === 'configured' ? '待测试' : '未连接';
    const capabilityText = model.capabilities ? `文本：${model.capabilities.text ? '支持' : '不支持'} · 流式：${model.capabilities.streaming ? '支持' : '关闭'} · 工具调用：${model.capabilities.toolCalling ? '支持' : '关闭'}` : '能力尚未读取';
    return `<div class="settings-grid"><div class="sheet"><h2>真实模型 API</h2><p class="muted">盘古 V2 OpenAI 格式适配器。API Key 只发送到主进程；保存时使用系统加密存储，不写入快照、日志或前端。</p><form id="model-config-form" class="settings-form"><label>Endpoint<input id="model-base-url" name="baseUrl" type="url" placeholder="https://…" value="${escape(model.baseUrl ?? '')}" required></label><label>模型名称<input id="model-name" name="model" value="${escape(model.model ?? 'pangu-nlp-n1-32k')}" required></label><label>部署名称<input id="model-deployment" name="deployment" value="${escape(model.deployment ?? model.model ?? 'pangu-nlp-n1-32k')}" required></label><label>API Key<input id="model-api-key" name="apiKey" type="password" autocomplete="off" placeholder="留空沿用已保存密钥"></label><div class="form-actions"><button class="btn" type="submit" id="model-save">保存配置</button><button class="btn btn-primary" type="button" id="model-test" ${model.configured ? '' : 'disabled'}>测试真实连接</button></div></form><p class="settings-status">状态：${badge(status, model.status)} ${escape(model.reason ?? '尚未测试')}<br><span class="muted">${escape(capabilityText)}</span></p></div><div class="sheet"><h2>思考设置测试</h2><p class="muted">这些值现在只保存为桌面测试状态；Runtime 尚未公开思考参数字段，未伪装成已传入任务。</p><label class="range-label"><span>思考深度 <b id="thinking-depth-label">${['最低','低','平衡','深入','高','最高'][thinking.depth] ?? '低'}</b></span><input id="thinking-depth" type="range" min="0" max="5" step="1" value="${Number(thinking.depth) || 0}"></label><label class="toggle-row"><input id="thinking-fast" type="checkbox" ${thinking.fast ? 'checked' : ''}>快速模式</label><p class="settings-status" id="thinking-status">${escape(thinking.reason ?? 'Runtime 尚未公开思考参数契约')}</p></div></div>`;
  }

  function render(data) {
    current = data;
    root.querySelector('#page-title').textContent = sections[section];
    const connection = data.connectionError ? `${data.connection} · ${data.connectionError}` : data.connection;
    root.querySelector('#connection').textContent = `${connection}。未连接的能力会保持明确的不可用状态。`;
    root.querySelectorAll('[data-page]').forEach(button => button.setAttribute('aria-current', button.dataset.page === section ? 'page' : 'false'));
    const modelLabel = data.model?.status === 'ready' ? '已连接' : '未连接';
    const modelReason = data.model?.reason ?? '模型 Provider 状态未知';
    let content = '';
    if (section === 'overview') {
      content = `<p class="muted">把注意力留给重要的事。</p><div class="cards"><div class="card"><span>本次会话任务</span><b>${data.tasks.length}</b></div><div class="card"><span>盘古大模型 2.0</span><b>${modelLabel}</b><span>${escape(modelReason)}</span></div><div class="card"><span>麦克风</span><b>未连接</b><span>语音供应商尚未接入</span></div></div>${taskTable(data)}`;
    } else if (section === 'capabilities') {
      content = capabilityTable(data);
    } else if (section === 'models') {
      content = `<div class="sheet"><h2>模型网关</h2><p>${escape(data.model?.label ?? '盘古大模型 2.0')}</p><p>${badge(modelLabel, data.model?.status)} ${escape(modelReason)}</p><div class="empty">快速模式与思考深度只有 MOD-04 暴露真实能力后才会启用。</div></div>`;
    } else if (section === 'connections') {
      content = healthTable(data);
    } else if (section === 'tasks') {
      content = taskTable(data);
    } else if (section === 'authorizations') {
      content = authorizationList(data);
    } else if (section === 'settings') {
      content = `${modelSettings(data)}<div class="sheet appearance-sheet"><h2>桌面外观</h2><p>ORB-02 · 规则点阵</p><p>标准毛玻璃 · 冷光青 · 完整动效</p><p>靠近半径 90px · 面板 372px · 球体模糊关闭</p><p class="muted">Runtime、模型和语音配置由对应宿主接口提供；API Key 仅通过系统加密存储恢复。</p><button class="btn" id="quit">退出 PersonalAgent</button></div>`;
    } else {
      content = `<div class="sheet"><h2>${sections[section]}</h2><div class="empty">尚未连接${sections[section]}服务<br>连接后将在这里显示真实数据。</div></div>`;
    }
    root.querySelector('#content').innerHTML = content;
    root.querySelector('#quit')?.addEventListener('click', () => invoke('app.quit'));
    root.querySelector('#refresh-capabilities')?.addEventListener('click', async () => {
      try { await invoke('capability.list'); } catch (error) { root.querySelector('#error').textContent = error.message; }
    });
    const modelForm = root.querySelector('#model-config-form');
    modelForm?.addEventListener('submit', async event => {
      event.preventDefault();
      const button = root.querySelector('#model-save');
      button.disabled = true;
      try {
        const result = await invoke('model.configure', {
          baseUrl: root.querySelector('#model-base-url').value,
          model: root.querySelector('#model-name').value,
          deployment: root.querySelector('#model-deployment').value,
          apiKey: root.querySelector('#model-api-key').value,
        });
        root.querySelector('#model-api-key').value = '';
        root.querySelector('#model-test').disabled = !result?.configured;
        root.querySelector('#error').textContent = '';
      } catch (error) {
        root.querySelector('#error').textContent = error.message;
      } finally { button.disabled = false; }
    });
    root.querySelector('#model-test')?.addEventListener('click', async event => {
      const button = event.currentTarget;
      button.disabled = true;
      try { await invoke('model.test'); root.querySelector('#error').textContent = ''; }
      catch (error) { root.querySelector('#error').textContent = error.message; }
      finally { button.disabled = false; }
    });
    const thinkingSlider = root.querySelector('#thinking-depth');
    const thinkingFast = root.querySelector('#thinking-fast');
    thinkingSlider?.addEventListener('input', async () => {
      const value = Number(thinkingSlider.value);
      root.querySelector('#thinking-depth-label').textContent = ['最低','低','平衡','深入','高','最高'][value] ?? '低';
      try { await invoke('thinking.update', {depth: value, fast: Boolean(thinkingFast.checked)}); }
      catch (error) { root.querySelector('#error').textContent = error.message; }
    });
    thinkingFast?.addEventListener('change', async () => {
      try { await invoke('thinking.update', {depth: Number(thinkingSlider.value), fast: Boolean(thinkingFast.checked)}); }
      catch (error) { root.querySelector('#error').textContent = error.message; }
    });
    root.querySelectorAll('[data-approval]').forEach(button => button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await invoke('authorization.respond', {approvalId: button.dataset.id, taskId: button.dataset.task, decision: button.dataset.approval, expectedRevision: Number(button.dataset.revision)});
      } catch (error) {
        root.querySelector('#error').textContent = error.message;
        button.disabled = false;
      }
    }));
  }

  root.querySelector('#admin-close').addEventListener('click', () => invoke('admin.close').catch(error => { root.querySelector('#error').textContent = error.message; }));
  root.querySelector('nav').addEventListener('click', event => {
    const button = event.target.closest('[data-page]');
    if (button) { section = button.dataset.page; render(current); }
  });
  return render;
}
