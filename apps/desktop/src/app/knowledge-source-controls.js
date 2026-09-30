/** Renderer only: no paths, filesystem, authorization grants, or direct tool execution. */
export function mountKnowledgeSourceControls(root, invoke) {
  const section = document.createElement('section');
  section.className = 'sheet knowledge-source-settings';
  section.setAttribute('aria-label', '知识源与笔记整理');
  section.innerHTML = `
    <h2>知识源与笔记整理</h2>
    <p class="notice" data-knowledge-source="name"></p>
    <p class="notice">本机选择器选定知识库；切换或撤销会停止旧知识源调用。</p>
    <button class="btn" type="button" data-knowledge-source="select">选择知识库</button>
    <button class="btn" type="button" data-knowledge-source="notes">选择可整理的笔记</button>
    <label class="setting-row"><input type="checkbox" data-knowledge-source="enabled">启用所选知识源</label>
    <label class="setting-row">数据范围 <select data-knowledge-source="level"><option value="private">私人，仅本机</option><option value="public">我确认这是公开演示资料</option></select></label>
    <label class="setting-row"><input type="checkbox" data-knowledge-source="write">本会话允许整理所选笔记（仍需逐次审批）</label>
    <label class="setting-row"><input type="checkbox" data-knowledge-source="cloud">本会话允许公开演示结果发送给 AgentArts</label>
    <label class="setting-row">允许出机的公开查询（一行一条）<textarea rows="2" maxlength="2048" data-knowledge-source="queries"></textarea></label>
    <button class="btn" type="button" data-knowledge-source="save">保存所选权限</button>
    <button class="btn" type="button" data-knowledge-source="revoke">撤销知识源</button>
    <p class="notice" data-knowledge-source="status" role="status"></p>
    <h3>整理选定笔记</h3>
    <label class="setting-row">笔记 <select data-knowledge-source="note"></select></label>
    <button class="btn" type="button" data-knowledge-source="read">读取当前版本</button>
    <pre class="knowledge-source-preview" data-knowledge-source="preview"></pre>
    <label class="setting-row">要替换的唯一原文<textarea rows="3" maxlength="16384" data-knowledge-source="old"></textarea></label>
    <label class="setting-row">替换后的段落<textarea rows="3" maxlength="16384" data-knowledge-source="new"></textarea></label>
    <p class="notice">只修改选定笔记的精确段落，保留现有链接和元数据；文件有新改动时请重新读取。备份留在本机受保护目录。</p>
    <button class="btn" type="button" data-knowledge-source="submit">提交整理并请求审批</button>
    <p class="notice" data-knowledge-source="write-status" role="status"></p>`;
  root.append(section);
  const field = name => section.querySelector(`[data-knowledge-source="${name}"]`);
  let state = {}, busy = false, noteVersion, settingsDirty = false;
  const binding = () => ({sourceId: state.sourceId, configRevision: state.configRevision});
  function buttons() {
    for (const button of section.querySelectorAll('button')) button.disabled = busy;
    field('notes').disabled = busy || !state.available;
    field('read').disabled = busy || !state.available || !field('note').value;
    field('submit').disabled = busy || !state.writeAvailable || !noteVersion;
    field('cloud').disabled = field('level').value !== 'public';
  }
  function clearNote() {noteVersion = undefined; field('preview').textContent = ''; field('old').value = ''; field('new').value = '';}
  function render(next) {
    if (state.sourceId !== next.sourceId || state.configRevision !== next.configRevision) {clearNote(); settingsDirty = false;}
    state = next;
    field('name').textContent = state.configured ? `${state.displayName} · 配置版本 ${state.configRevision}` : '尚未选择知识库';
    if (!settingsDirty) {
      field('enabled').checked = state.enabled === true;
      field('level').value = state.dataLevel === 'public' ? 'public' : 'private';
      field('write').checked = state.writeAvailable === true;
      field('cloud').checked = state.cloudExportAllowed === true;
      field('queries').value = (state.publicQueries ?? []).join('\n');
    }
    const selected = field('note').value;
    field('note').replaceChildren(...(state.allowedNotePaths ?? []).map(value => {
      const option = document.createElement('option'); option.value = value; option.textContent = value; return option;
    }));
    if ((state.allowedNotePaths ?? []).includes(selected)) field('note').value = selected;
    field('status').textContent = state.reason ?? ''; buttons();
  }
  async function act(action, payload, receive = render) {
    if (busy) return;
    busy = true; buttons();
    try {receive(await invoke(action, payload));}
    catch (error) {field('status').textContent = error?.message ?? '知识源操作失败';}
    finally {busy = false; buttons();}
  }
  field('select').addEventListener('click', () => act('knowledge.source.select'));
  field('notes').addEventListener('click', () => act('knowledge.source.selectNotes', binding()));
  field('revoke').addEventListener('click', () => act('knowledge.source.revoke'));
  field('save').addEventListener('click', () => act('knowledge.source.configure', {...binding(),
    enabled: field('enabled').checked, dataLevel: field('level').value, writeAllowed: field('write').checked,
    cloudExportAllowed: field('level').value === 'public' && field('cloud').checked,
    publicQueries: field('queries').value.split(/\r?\n/).map(value => value.trim()).filter(Boolean)}));
  for (const name of ['enabled', 'level', 'write', 'cloud', 'queries']) {
    field(name).addEventListener('input', () => {settingsDirty = true;});
  }
  field('level').addEventListener('change', () => {settingsDirty = true; if (field('level').value !== 'public') field('cloud').checked = false; buttons();});
  field('note').addEventListener('change', () => {clearNote(); buttons();});
  field('read').addEventListener('click', () => act('knowledge.source.readNote', {...binding(), path: field('note').value}, result => {
    if (result.sourceId !== state.sourceId || result.configRevision !== state.configRevision || result.path !== field('note').value) return;
    noteVersion = result; field('preview').textContent = result.content; field('write-status').textContent = '已读取当前版本；填写要整理的段落';
  }));
  field('submit').addEventListener('click', () => {
    if (!noteVersion || !field('old').value) return;
    const payload = {...binding(), path: noteVersion.path, expectedSha256: noteVersion.revision,
      edits: [{oldText: field('old').value, newText: field('new').value}]};
    void act('knowledge.source.submitPatch', payload, result => {
      // Runtime readback alone determines task/approval state. Submission is never displayed as a write success.
      clearNote();
      const taskState = result?.state ?? result?.task?.state ?? 'pending';
      field('write-status').textContent = taskState === 'waiting_approval' ? '已提交，等待审批'
        : taskState === 'waiting_reconciliation' ? '写入结果待核实，请查看任务状态'
          : `已受理整理任务：${taskState}；以任务读回为准`;
    });
  });
  return {element: section, update(snapshot) {render(snapshot?.knowledgeSource ?? snapshot ?? {});},
    dispose() {section.remove();}};
}
