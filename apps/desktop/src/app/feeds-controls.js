export function mountFeedsControls(root,invoke) {
  const section = document.createElement('section'); section.className = 'sheet';
  section.innerHTML = '<h2>RSS / Atom 订阅</h2><p>订阅地址在本机加密保存。允许后，可在主对话中让智能体读取、分页并汇总订阅文章。</p><form class="settings-form"><label>名称<input name="title" maxlength="200" required></label><label>订阅地址<input name="url" type="url" autocomplete="off" required></label><button class="btn" type="submit">添加订阅</button></form><ul data-feeds="list"></ul><label><input type="checkbox" data-feeds="consent">允许本会话读取订阅，并向 AgentArts 发送文章标题、摘要、来源与分页结果</label><div><button class="btn" data-feeds="enable">允许本会话</button> <button class="btn" data-feeds="disable">关闭并撤销</button></div><p data-feeds="status" role="status"></p>';
  root.append(section);
  const field = name => section.querySelector(`[data-feeds="${name}"]`);
  const form = section.querySelector('form'); let state = {}, busy = false;
  async function run(name,input) {
    busy = true; render(state);
    let error;
    try {render(await invoke(name,input));}
    catch {error = '订阅操作未完成，请检查配置和当前连接状态';}
    finally {busy = false; render(state); if (error) field('status').textContent = error;}
  }
  form.addEventListener('submit',event => {
    event.preventDefault();
    const input = {title:form.elements.title.value.trim(),url:form.elements.url.value.trim()};
    form.elements.url.value = '';
    void run('feeds.add',input).finally(() => {input.url='';});
  });
  field('enable').onclick = () => run('feeds.authorize',{readAndCloudConsent:field('consent').checked});
  field('disable').onclick = () => run('feeds.revoke');
  function render(value = {}) {
    const wasAllowed = state.sessionAllowed;
    state = value;
    const list = field('list'); list.replaceChildren();
    for (const item of value.subscriptions ?? []) {
      const row = document.createElement('li'), label = document.createElement('span'), remove = document.createElement('button');
      label.textContent = item.title; remove.textContent = '移除'; remove.className = 'btn btn-sm';
      remove.disabled = busy; remove.onclick = () => run('feeds.remove',{id:item.id});
      row.append(label,' ',remove); list.append(row);
    }
    form.querySelector('button').disabled = busy;
    field('enable').disabled = busy || !value.available || value.requiresRestart;
    field('disable').disabled = busy || !value.sessionAllowed;
    if (value.sessionAllowed) field('consent').checked = true;
    else if (wasAllowed) field('consent').checked = false;
    field('status').textContent = value.reason || '订阅连接尚未装配';
  }
  return {render,show(visible) {section.hidden=!visible;}};
}
