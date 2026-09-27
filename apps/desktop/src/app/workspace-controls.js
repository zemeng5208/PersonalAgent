/** Renderer controls only; the trusted host selects and binds the workspace. */
export function mountWorkspaceControls(root, invoke) {
  const section = document.createElement('section');
  section.className = 'sheet coding-workspace';
  section.setAttribute('aria-label', '编程工作区');
  section.innerHTML = `
    <h2>编程工作区</h2>
    <p class="notice">选择目录时由本机宿主打开系统选择器；此页面不读取或传递目录路径。</p>
    <p class="notice" data-workspace="name"></p>
    <p class="notice" data-workspace="capabilities"></p>
    <button class="btn" type="button" data-workspace="select">选择工作区</button>
    <label class="setting-row"><input type="checkbox" data-workspace="cloud">允许将此工作区的工具结果发送给 AgentArts</label>
    <label class="setting-row"><input type="checkbox" data-workspace="write">额外允许写入工作区</label>
    <label class="setting-row"><input type="checkbox" data-workspace="command">额外允许执行受限命令</label>
    <p class="notice">发送范围与写入、命令许可由宿主保存；每次实际执行仍须经过本地 Policy 校验与必要审批。</p>
    <button class="btn" type="button" data-workspace="authorize">授权所选权限</button>
    <button class="btn" type="button" data-workspace="revoke">撤销工作区授权</button>
    <p class="notice" data-workspace="status" role="status"></p>`;
  root.append(section);

  const field = name => section.querySelector(`[data-workspace="${name}"]`);
  let state = {};
  let busy = false;
  let consentDirty = false;
  let feedback = '';

  function updateButtons() {
    const configured = state.configured === true;
    field('select').disabled = busy;
    field('cloud').disabled = busy || !configured;
    field('write').disabled = busy || !configured;
    field('command').disabled = busy || !configured;
    field('authorize').disabled = busy || !configured || !field('cloud').checked;
    field('revoke').disabled = busy || (!configured && state.cloudExportAllowed !== true);
  }

  function render(snapshot = {}, {keepFeedback = false} = {}) {
    if (!keepFeedback) feedback = '';
    const next = snapshot?.coding ?? {};
    const previousName = state.displayName;
    state = next && typeof next === 'object' ? next : {};
    const configured = state.configured === true;
    const displayName = configured && typeof state.displayName === 'string' && state.displayName.trim()
      ? state.displayName : configured ? '已选择工作区' : '未选择工作区';
    field('name').textContent = `当前工作区：${displayName}`;
    field('capabilities').textContent = configured
      ? `读取：${state.readAvailable === true ? '可用' : '不可用'} · 写入：${state.writeAvailable === true ? '可用' : '不可用'} · 受限命令：${state.commandAvailable === true ? '可用' : '不可用'} · AgentArts 结果发送：${state.cloudExportAllowed === true ? '已允许' : '未允许'}`
      : '读取、写入和受限命令均未启用';
    if (!configured || previousName !== state.displayName) {
      field('write').checked = false;
      field('command').checked = false;
      consentDirty = false;
    }
    if (!consentDirty) field('cloud').checked = configured && state.cloudExportAllowed === true;
    field('status').textContent = feedback || (typeof state.reason === 'string' ? state.reason : '')
      || (configured ? '请按需选择授权范围；设置状态以宿主读回为准。' : '请先由本机宿主选择工作区。');
    updateButtons();
  }

  async function run(action, payload) {
    if (busy) return;
    busy = true;
    feedback = '';
    updateButtons();
    try {
      const result = payload === undefined ? await invoke(action) : await invoke(action, payload);
      if (result && typeof result === 'object' && result.coding) {
        consentDirty = false;
        render(result);
      } else {
        feedback = '请求已返回，等待本机宿主状态读回。';
        render({coding: state}, {keepFeedback: true});
      }
    } catch {
      feedback = '工作区操作未完成，可重试或查看本机状态。';
      render({coding: state}, {keepFeedback: true});
    } finally {
      busy = false;
      updateButtons();
    }
  }

  field('cloud').addEventListener('change', () => { consentDirty = true; updateButtons(); });
  field('select').addEventListener('click', () => run('coding.select'));
  field('authorize').addEventListener('click', () => {
    if (!field('cloud').checked || state.configured !== true) return;
    run('coding.authorize', {
      cloudExportAllowed: true,
      writeAllowed: field('write').checked,
      commandAllowed: field('command').checked,
    });
  });
  field('revoke').addEventListener('click', () => run('coding.revoke'));

  render();
  return {render,show:visible=>{section.hidden=!visible;}};
}
