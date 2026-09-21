export function agentArtsModelPage(model, escape) {
  return `<div class="model-page"><div class="page-lead"><div><h2>AgentArts</h2><p>Competition Profile · 由可信主进程配置</p></div></div><div class="sheet"><h3>部署状态</h3><p>${model.configured ? '已配置；不代表真实任务已验收' : '尚未配置'}</p><p>Runtime：${escape(model.deployment || '未提供')}</p><p>${escape(model.reason || '真实调用与本地结果读回尚未验证')}</p></div><p class="model-footnote">此页面为只读状态。AgentArts 不使用本页的盘古模型编辑、连接测试或启停操作；凭据仅由可信主进程提供，不在页面输入或展示。任务是否完成以 Runtime 回读状态为准，不会自动回退 Local。</p></div>`;
}
