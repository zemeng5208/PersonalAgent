const escape = str => String(str ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function mountKnowledgeControls(container, invoke) {
  const section = document.createElement('section');
  section.className = 'feature-page';
  section.setAttribute('aria-label', '知识库与关注监控');
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

    <hr style="border:0;border-top:1px solid var(--border-color,#333);margin:24px 0" />

    <h2>知识关注与增量更新 (P7 Knowledge Watch)</h2>
    <p class="notice">持续关注特定公共来源（如 RSS / 文档订阅），在版本变化时通过 Laya 触发重评。主对话与实时语音只消费已绑定的有效事实。</p>
    <div class="settings-list" style="margin-bottom:16px">
      <div class="setting-row">
        <span>关注宿主状态</span>
        <strong data-watch-status>未装配</strong>
      </div>
      <div class="setting-row">
        <span>关注命名空间</span>
        <code data-watch-namespace style="font-size:12px">未配置</code>
      </div>
    </div>

    <div style="display:flex;gap:8px;margin-bottom:12px">
      <button class="btn btn-sm" data-action-refresh-watch type="button">检查关注更新</button>
    </div>
    <p class="notice" data-watch-op-status role="status" style="margin-bottom:12px"></p>

    <h3 style="font-size:14px;margin-bottom:8px">已跟踪关注事项与事实状态</h3>
    <div data-watch-list class="knowledge-results" style="margin-bottom:16px">
      <p class="notice">暂无跟踪中的关注事项。</p>
    </div>

    <h3 style="font-size:14px;margin-bottom:8px">待确认提醒与投递回执</h3>
    <div data-notice-list class="knowledge-results">
      <p class="notice">暂无待确认提醒。</p>
    </div>
  `;
  container.append(section);

  const vaultStatus = section.querySelector('[data-vault-status]');
  const vaultPath = section.querySelector('[data-vault-path]');
  const form = section.querySelector('form');
  const searchStatus = section.querySelector('[data-search-status]');
  const resultsContainer = section.querySelector('[data-results]');
  const searchButton = form.querySelector('button');

  const watchStatus = section.querySelector('[data-watch-status]');
  const watchNamespace = section.querySelector('[data-watch-namespace]');
  const watchOpStatus = section.querySelector('[data-watch-op-status]');
  const refreshWatchBtn = section.querySelector('[data-action-refresh-watch]');
  const watchList = section.querySelector('[data-watch-list]');
  const noticeList = section.querySelector('[data-notice-list]');

  let current = null;
  let currentWatch = null;
  let searching = false;
  let operating = false;

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

  refreshWatchBtn.addEventListener('click', async () => {
    if (operating) return;
    operating = true;
    refreshWatchBtn.disabled = true;
    watchOpStatus.textContent = '正在检查关注来源增量…';
    try {
      const res = await invoke('knowledge.watch.refresh');
      if (res?.notified) {
        watchOpStatus.textContent = `检查完成：检测到来源版本更新，已提交重评任务。`;
      } else if (res?.reason) {
        watchOpStatus.textContent = `检查完成：${res.reason === 'unchanged' ? '来源未发生改变' : res.reason}。`;
      } else {
        watchOpStatus.textContent = '检查完成。';
      }
    } catch (err) {
      watchOpStatus.textContent = `检查失败：${err.message || '未知错误'}`;
    } finally {
      operating = false;
      refreshWatchBtn.disabled = false;
    }
  });

  async function handleAcknowledge(noticeId) {
    if (operating) return;
    operating = true;
    watchOpStatus.textContent = `正在发送提醒投递回执 (${noticeId})…`;
    try {
      const res = await invoke('knowledge.watch.acknowledge', {id: noticeId, state: 'delivered'});
      if (res?.accepted) {
        watchOpStatus.textContent = `回执已记录为已投递（投递成功不代表用户已读）。`;
      } else {
        watchOpStatus.textContent = `回执记录失败：${res?.reason || '未知原因'}`;
      }
    } catch (err) {
      watchOpStatus.textContent = `回执发送失败：${err.message || '未知错误'}`;
    } finally {
      operating = false;
    }
  }

  async function handleBind(topicId) {
    if (operating) return;
    operating = true;
    watchOpStatus.textContent = `正在确认接受更新并绑定新版本 (${topicId})…`;
    try {
      const res = await invoke('knowledge.watch.bind', {topicId});
      if (res?.accepted) {
        watchOpStatus.textContent = `新版本绑定成功！版本已更新为 ${res.revision}，现可作为正式当前事实消费。`;
      } else {
        watchOpStatus.textContent = `无法绑定新版本：${res?.reason || '未确认'}（任务状态：${res?.taskState || '未知'}；未提前修改绑定版本）。`;
      }
    } catch (err) {
      watchOpStatus.textContent = `绑定失败：${err.message || '未知错误'}`;
    } finally {
      operating = false;
    }
  }

  async function handleRevoke(topicId) {
    if (operating) return;
    if (!confirm(`确定撤销对主题 "${topicId}" 的关注吗？撤销后将不再跟踪与通知。`)) return;
    operating = true;
    watchOpStatus.textContent = `正在撤销关注 (${topicId})…`;
    try {
      const res = await invoke('knowledge.watch.revoke', {topicId, id: `user-revoke-${Date.now()}`});
      if (res?.state === 'revoked') {
        watchOpStatus.textContent = `主题 "${topicId}" 已成功撤销关注。`;
      } else {
        watchOpStatus.textContent = `撤销失败：${res?.reason || '未知错误'}`;
      }
    } catch (err) {
      watchOpStatus.textContent = `撤销失败：${err.message || '未知错误'}`;
    } finally {
      operating = false;
    }
  }

  function render(vaultValue = {}, watchValue = null) {
    current = vaultValue;
    currentWatch = watchValue;

    const isAvailable = vaultValue.available === true;
    vaultStatus.textContent = isAvailable ? `${vaultValue.name || '本地知识库'}（就绪）` : (vaultValue.reason || '未装配');
    vaultPath.textContent = vaultValue.rootPath || '未配置';
    searchButton.disabled = !isAvailable || searching;

    if (!watchValue || watchValue.state === 'unavailable') {
      watchStatus.textContent = watchValue?.reason || '知识关注宿主尚未装配';
      watchNamespace.textContent = '无';
      refreshWatchBtn.disabled = true;
      watchList.innerHTML = '<p class="notice">知识关注宿主尚未装配。</p>';
      noticeList.innerHTML = '<p class="notice">无提醒。</p>';
      return;
    }

    watchStatus.textContent = watchValue.health?.status === 'ready' ? '正常运行中' : (watchValue.health?.status || '就绪');
    watchNamespace.textContent = watchValue.namespace || '未指定';
    refreshWatchBtn.disabled = operating;

    // Render dialogue & watches
    const dialogueItems = Array.isArray(watchValue.dialogue?.items) ? watchValue.dialogue.items : [];
    const watches = watchValue.watches ? Object.values(watchValue.watches) : [];

    if (watches.length === 0 && dialogueItems.length === 0) {
      watchList.innerHTML = '<p class="notice">暂无跟踪中的关注事项。</p>';
    } else {
      const renderedTopics = new Set();
      const cards = [];

      for (const item of dialogueItems) {
        renderedTopics.add(item.topicId);
        const ans = item.answer || {};
        let kindLabel = '未就绪 (withheld)';
        let badgeColor = '#888';
        if (ans.kind === 'current_fact') {
          kindLabel = '已确认当前事实 (current_fact)';
          badgeColor = '#38a169';
        } else if (ans.kind === 'latest_observation') {
          kindLabel = '最新观察待重评 (latest_observation)';
          badgeColor = '#d69e2e';
        } else if (ans.kind === 'withheld') {
          kindLabel = `已扣留/待重评 (${ans.reason || 'withheld'})`;
          badgeColor = '#e53e3e';
        }

        cards.push(`
          <article class="task" style="margin-bottom:10px;padding:10px;border-radius:6px;border:1px solid var(--border-color,#333);background:var(--surface-bg,#1a1a1a)">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <strong>${escape(item.topicId)}</strong>
              <span style="font-size:12px;padding:2px 6px;border-radius:4px;background:${badgeColor};color:#fff">${kindLabel}</span>
            </div>
            <p style="font-size:12px;color:var(--text-muted,#aaa);margin:4px 0">
              当前绑定版本：<code>${escape(item.boundSource?.revision || '无')}</code> | 
              当前事实可用性：<strong>${item.usableAsCurrentFact ? '可用' : '不可作为当前事实'}</strong>
            </p>
            ${ans.citation ? `<p style="font-size:12px;margin:4px 0">引用：<a href="${escape(ans.citation)}" target="_blank" style="color:var(--link-color,#63b3ed)">${escape(ans.citation)}</a></p>` : ''}
            ${ans.kind === 'latest_observation' ? `
              <div style="margin:8px 0;padding:6px;background:rgba(214,158,46,0.1);border-left:3px solid #d69e2e;font-size:12px">
                <p>已观察到来源新版本：<code>${escape(ans.sourceRevision || '最新')}</code>。需经本地 Runtime 重评任务确认方可接受。</p>
                <div style="margin-top:6px;display:flex;gap:6px">
                  <button class="btn btn-sm" data-bind-topic="${escape(item.topicId)}" type="button">接受更新并绑定新版本</button>
                </div>
              </div>
            ` : ''}
            <div style="margin-top:6px;display:flex;justify-content:flex-end">
              <button class="btn btn-sm" style="color:#e53e3e" data-revoke-topic="${escape(item.topicId)}" type="button">撤销关注</button>
            </div>
          </article>
        `);
      }

      for (const watch of watches) {
        if (renderedTopics.has(watch.topicId)) continue;
        cards.push(`
          <article class="task" style="margin-bottom:10px;padding:10px;border-radius:6px;border:1px solid var(--border-color,#333);background:var(--surface-bg,#1a1a1a)">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <strong>${escape(watch.topicId)}</strong>
              <span style="font-size:12px;padding:2px 6px;border-radius:4px;background:#888;color:#fff">${escape(watch.state)}</span>
            </div>
            <p style="font-size:12px;color:var(--text-muted,#aaa);margin:4px 0">状态：${escape(watch.reason || '无')} | 版本：${Number(watch.revision || 1)}</p>
            <div style="margin-top:6px;display:flex;justify-content:flex-end">
              <button class="btn btn-sm" style="color:#e53e3e" data-revoke-topic="${escape(watch.topicId)}" type="button">撤销关注</button>
            </div>
          </article>
        `);
      }

      watchList.innerHTML = cards.join('');
    }

    // Render notices
    const notices = Array.isArray(watchValue.notices) ? watchValue.notices : [];
    if (notices.length === 0) {
      noticeList.innerHTML = '<p class="notice">暂无待确认提醒。</p>';
    } else {
      noticeList.innerHTML = notices.map(notice => `
        <article class="task" style="margin-bottom:8px;padding:8px;border-radius:4px;border:1px solid var(--border-color,#333)">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <strong>提醒 ID: ${escape(notice.id?.slice(0, 12))}…</strong>
            <span style="font-size:12px;color:${notice.delivered ? '#38a169' : '#e53e3e'}">${notice.delivered ? '已投递（未确认用户已读）' : '待投递回执'}</span>
          </div>
          <p style="font-size:12px;margin:4px 0">${escape(notice.text || notice.summary || '关注来源更新提醒')}</p>
          ${!notice.delivered ? `
            <div style="margin-top:6px">
              <button class="btn btn-sm" data-ack-notice="${escape(notice.id)}" type="button">确认投递回执</button>
            </div>
          ` : ''}
        </article>
      `).join('');
    }

    // Attach dynamic click handlers
    watchList.querySelectorAll('[data-bind-topic]').forEach(btn => {
      btn.addEventListener('click', () => handleBind(btn.dataset.bindTopic));
    });
    watchList.querySelectorAll('[data-revoke-topic]').forEach(btn => {
      btn.addEventListener('click', () => handleRevoke(btn.dataset.revokeTopic));
    });
    noticeList.querySelectorAll('[data-ack-notice]').forEach(btn => {
      btn.addEventListener('click', () => handleAcknowledge(btn.dataset.ackNotice));
    });
  }

  return {
    render,
    show(visible) { section.hidden = !visible; },
  };
}
