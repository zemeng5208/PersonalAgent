const escape = str => String(str ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function mountKnowledgeControls(container, invoke) {
  const section = document.createElement('section');
  section.className = 'feature-page';
  section.setAttribute('aria-label', '知识库与笔记检索');
  section.innerHTML = `
    <h2>本地知识库与笔记</h2>
    <p class="notice">只读访问已配置的本地知识目录（支持 Markdown 与 Obsidian 知识库）。知识检索结果可用于主智能体参考；不会向外部发送未经授权的笔记内容。</p>
    <div class="settings-list" style="margin-bottom:16px">
      <div class="setting-row">
        <span>知识库状态</span>
        <strong data-vault-status>检测中…</strong>
      </div>
      <div class="setting-row">
        <span>目录路径</span>
        <code data-vault-path style="font-size:12px;word-break:break-all">未配置</code>
      </div>
    </div>
    <form class="knowledge-search-form" style="display:flex;gap:8px;margin-bottom:12px">
      <input type="text" name="query" placeholder="输入关键词检索本地笔记…" style="flex:1;padding:6px 10px;border-radius:4px;border:1px solid var(--border-color,#444);background:var(--input-bg,#222);color:inherit" required>
      <button class="btn btn-sm" type="submit">检索笔记</button>
    </form>
    <p class="notice" data-search-status role="status"></p>
    <div class="knowledge-results" data-results></div>
  `;
  container.append(section);

  const vaultStatus = section.querySelector('[data-vault-status]');
  const vaultPath = section.querySelector('[data-vault-path]');
  const form = section.querySelector('form');
  const searchStatus = section.querySelector('[data-search-status]');
  const resultsContainer = section.querySelector('[data-results]');
  const searchButton = form.querySelector('button');

  let current = null;
  let searching = false;

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (searching) return;
    const query = form.elements.query.value.trim();
    if (!query) return;
    searching = true;
    searchButton.disabled = true;
    searchStatus.textContent = `正在检索 "${query}"…`;
    resultsContainer.innerHTML = '';
    try {
      const res = await invoke('knowledge.search', {query, limit: 10});
      const hits = Array.isArray(res?.hits) ? res.hits : [];
      if (hits.length === 0) {
        searchStatus.textContent = `未找到与 "${query}" 相关的笔记内容。`;
      } else {
        searchStatus.textContent = `检索到 ${hits.length} 条相关结果${res.truncated ? '（已截断展示）' : ''}：`;
        resultsContainer.innerHTML = hits.map(hit => `
          <article class="task" style="margin-bottom:8px">
            <p><strong>${escape(hit.source?.path || '未知文件')}</strong> <span class="notice">第 ${Number(hit.source?.line || 1)} 行</span></p>
            <p class="assistant-message" style="margin-top:4px;white-space:pre-wrap;font-size:13px">${escape(hit.excerpt || '')}</p>
          </article>
        `).join('');
      }
    } catch (err) {
      searchStatus.textContent = `检索失败：${err.message || '未知错误'}`;
    } finally {
      searching = false;
      searchButton.disabled = !current?.available;
    }
  });

  function render(value = {}) {
    current = value;
    const isAvailable = value.available === true;
    vaultStatus.textContent = isAvailable ? `${value.name || '本地知识库'}（就绪）` : (value.reason || '未装配');
    vaultPath.textContent = value.rootPath || '未配置';
    searchButton.disabled = !isAvailable || searching;
  }

  return {
    render,
    show(visible) { section.hidden = !visible; },
  };
}
