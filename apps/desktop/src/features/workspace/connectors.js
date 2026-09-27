const definitions = [
  {
    id: 'weather',
    name: '天气',
    path: 'M7 16a4 4 0 1 1 1-7 5 5 0 0 1 9 3 3 3 0 0 1 0 6H7M7 21l1-2m5 2 1-2m5 2 1-2',
    defaultPreview: '<div class="weather-preview"><strong>--<span>°</span></strong><div>未查询天气<small>可在主对话询问例如“北京天气”自动获取</small></div></div>',
    render(data, escape) {
      if (data.weather && typeof data.weather.temp !== 'undefined') {
        return {
          status: '实时',
          preview: `<div class="weather-preview"><strong>${escape(data.weather.temp)}<span>°</span></strong><div>${escape(data.weather.condition ?? '晴')}<small>${escape(data.weather.city ?? '当前城市')} · ${escape(data.weather.range ?? '')}</small></div></div>`,
          footer: '已连接 · 实时天气数据',
        };
      }
      return {
        status: '预览',
        preview: '<div class="weather-preview"><strong>--<span>°</span></strong><div>未查询天气<small>可在主对话询问例如“北京天气”自动获取</small></div></div>',
        footer: 'Open-Meteo · 实时查询已就绪（示例预览）',
      };
    },
  },
  {
    id: 'calendar',
    name: '日程与待办',
    path: 'M7 3v4m10-4v4M4 10h16M5 5h14v16H5V5m4 9h2m3 0h2m-7 4h2',
    defaultPreview: '<div class="agenda-row"><time>待办</time><div>暂无待办事项<small>在主对话安排待办与提醒</small></div></div>',
    render(data, escape) {
      const items = Array.isArray(data.todo?.items) ? data.todo.items : [];
      if (items.length > 0) {
        const rows = items.slice(0, 3).map(todo => {
          const time = todo.reminder?.remindAt?.utc
            ? new Date(todo.reminder.remindAt.utc).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})
            : (todo.due?.utc ? new Date(todo.due.utc).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) : '待办');
          const statusText = {open: '待完成', done: '已完成', cancelled: '已取消'}[todo.status] ?? todo.status;
          return `<div class="agenda-row"><time>${escape(time)}</time><div>${escape(todo.title)}<small>${escape(statusText)}${todo.notes ? ' · ' + escape(todo.notes) : ''}</small></div></div>`;
        }).join('');
        return {
          status: data.todo.sessionAllowed ? '已允许' : '已就绪',
          preview: rows,
          footer: `来自本地待办存储 · ${items.length} 项（外部日历未接入）`,
        };
      }
      if (data.todo?.available) {
        return {
          status: data.todo.sessionAllowed ? '已允许' : '已就绪',
          preview: '<div class="agenda-row"><time>待办</time><div>暂无待办事项<small>在主对话安排待办或在设置中添加</small></div></div>',
          footer: '本地待办已就绪 · 外部日历未接入',
        };
      }
      return {
        status: '未连接',
        preview: '<div class="agenda-row"><time>--:--</time><div>待办与日程未连接<small>等待 Runtime 初始化</small></div></div>',
        footer: '未连接',
      };
    },
  },
  {
    id: 'mail',
    name: '邮件',
    path: 'M3 5h18v14H3V5m0 0 9 7 9-7',
    defaultPreview: '<div class="mail-preview"><span class="mail-avatar">M</span><div><strong>电子邮箱</strong><small>未配置</small></div></div><p class="preview-excerpt">可在设置中配置 QQ 邮箱或企业邮箱</p>',
    render(data, escape) {
      if (!data.mail || !data.mail.configured) {
        return {
          status: '未配置',
          preview: '<div class="mail-preview"><span class="mail-avatar">M</span><div><strong>电子邮箱</strong><small>未配置</small></div></div><p class="preview-excerpt">可在设置中配置 QQ 邮箱或企业邮箱以启用邮件分析</p>',
          footer: '未连接',
        };
      }
      const hasUnread = typeof data.mail.counts?.unread === 'number';
      const unreadText = hasUnread ? `${data.mail.counts.unread} 封未读` : (data.mail.status === 'ready' ? '未同步未读数' : '尚未拉取邮件');
      return {
        status: data.mail.sessionAllowed ? '已允许' : '已配置',
        preview: `<div class="mail-preview"><span class="mail-avatar">M</span><div><strong>${escape(data.mail.user || '电子邮箱')}</strong><small>${escape(unreadText)}</small></div></div><p class="preview-excerpt">${escape(data.mail.reason || (data.mail.sessionAllowed ? '已允许本会话读取与分析' : '已保存配置，会话读取未允许'))}</p>`,
        footer: `${data.mail.sessionAllowed ? '已授权本会话' : '已保存配置'} · ${escape(unreadText)}`,
      };
    },
  },
  {
    id: 'obsidian',
    name: '知识库与笔记',
    path: 'm12 3 7 5-2 11-8 2-4-9 7-9zm0 0 2 10-5 8m5-8 5-5',
    defaultPreview: '<div class="note-preview"><span>知识库</span><strong>未挂载</strong><p>可在环境变量配置 PERSONAL_AGENT_KNOWLEDGE_DIR</p></div>',
    render(data, escape) {
      if (data.knowledge?.configured) {
        return {
          status: '已就绪',
          preview: `<div class="note-preview"><span>知识库</span><strong>${escape(data.knowledge.name || '本地知识与笔记')}</strong><p>${escape(data.knowledge.reason || '已连接')}</p></div>`,
          footer: '本地知识库已挂载',
        };
      }
      return {
        status: '未配置',
        preview: '<div class="note-preview"><span>知识库</span><strong>未挂载</strong><p>设置 PERSONAL_AGENT_KNOWLEDGE_DIR 接入本地 Markdown 库</p></div>',
        footer: '未接入',
      };
    },
  },
  {
    id: 'feeds',
    name: '订阅',
    path: 'M5 4a15 15 0 0 1 15 15M5 10a9 9 0 0 1 9 9M5 17h2v2H5z',
    defaultPreview: '<div class="feed-preview"><span>RSS / Atom 订阅</span><strong>尚未添加订阅源</strong><p>可在设置中添加感兴趣的 RSS 订阅</p></div>',
    render(data, escape) {
      const subs = Array.isArray(data.feeds?.subscriptions) ? data.feeds.subscriptions : [];
      if (subs.length > 0) {
        return {
          status: data.feeds.sessionAllowed ? '已允许' : '已配置',
          preview: `<div class="feed-preview"><span>已订阅 ${subs.length} 个源</span><strong>${escape(subs[0].title)}</strong><p>${subs.length > 1 ? `以及 ${escape(subs[1].title)} 等` : '可在主对话汇总最新文章'}</p><small>${data.feeds.sessionAllowed ? '已允许会话读取与汇总' : '会话读取未允许'}</small></div>`,
          footer: `${data.feeds.sessionAllowed ? '已授权本会话' : '已配置'} · ${subs.length} 个订阅源`,
        };
      }
      if (data.feeds?.available) {
        return {
          status: '已就绪',
          preview: '<div class="feed-preview"><span>RSS / Atom 订阅</span><strong>尚未添加订阅源</strong><p>可在设置中添加感兴趣的 RSS 订阅源</p></div>',
          footer: '订阅服务已就绪 · 暂无订阅源',
        };
      }
      return {
        status: '未连接',
        preview: '<div class="feed-preview"><span>RSS / Atom</span><strong>未连接</strong><p>订阅服务未就绪</p></div>',
        footer: '未连接',
      };
    },
  },
];
const labels = {ready: '已连接', connecting: '连接中', reauth_required: '需要授权', degraded: '连接异常', disconnected: '未连接', unavailable: '未接入'};
export function connectorCards(data, escape) {
  const cards = definitions.map(item => {
    const health = (data.health || []).find(entry => entry.id === item.id);
    const rendered = item.render(data, escape);
    const status = rendered?.status ?? '预览';
    const preview = rendered?.preview ?? item.defaultPreview;
    const footer = rendered?.footer ?? `${escape(health ? labels[health.state] || health.state : '未连接')} · 示例预览`;
    return `<article class="connector-card" data-connector="${item.id}"><header><span class="connector-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${item.path}"/></svg></span><h3>${item.name}</h3><span class="connector-status">${escape(status)}</span></header>${preview}<footer>${footer}</footer></article>`;
  }).join('');

  const notifList = Array.isArray(data.notifications) ? data.notifications : [];
  const notifError = data.todo?.failure || (data.health || []).find(h => h.id === 'notifications' && h.state === 'error')?.reason;
  const notifStatus = notifError ? '读取失败' : `${notifList.length} 条`;
  const notifContent = notifError
    ? `<p class="notif-error" style="color:var(--danger)">通知读取失败：${escape(notifError)}</p>`
    : notifList.length
      ? notifList.slice(0, 5).map(item => `<p>${escape(item.summary)}<small>${escape(new Date(item.occurredAt).toLocaleString())}</small></p>`).join('')
      : '<p>暂无未读通知<small>待办提醒与系统状态将在此处汇总呈现</small></p>';

  return cards + `<article class="connector-card notification-card"><header><h3>通知</h3><span class="connector-status">${escape(notifStatus)}</span></header>${notifContent}</article>`;
}

