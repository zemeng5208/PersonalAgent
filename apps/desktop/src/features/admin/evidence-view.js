const metadataFields = [
  ['evidenceId', 'Evidence ID'],
  ['kind', '类型'],
  ['sourceRef', '来源'],
  ['capturedAt', '记录时间'],
  ['summary', '执行摘要'],
  ['verification', '核实级别'],
  ['sensitivity', '敏感级别'],
];

export function evidencePanelHtml(state, escape) {
  if (!state || state.status === 'idle') {
    return '<p class="muted">执行元数据需由受信宿主逐次鉴权后读取；引用数量不代表外部结果已核实。</p>';
  }
  if (state.status === 'loading') return '<p class="muted" role="status">正在读取受控执行元数据…</p>';
  if (state.status === 'error') {
    return '<p role="alert">执行元数据未读取；宿主接口不可用或本次访问未获授权。</p><button class="btn btn-sm" data-evidence-retry>重试</button>';
  }
  const rows = state.items.map(item => `<tr><td>${escape(item.evidenceId)}</td><td>${escape(item.summary)}</td><td>${escape(item.verification)}</td><td><button class="btn btn-sm" data-evidence-id="${escape(item.evidenceId)}">查看元数据</button></td></tr>`).join('');
  const detail = state.detailStatus === 'loading' ? '<p role="status">正在读取详情…</p>'
    : state.detailStatus === 'error' ? '<p role="alert">详情读取失败；可能已无权访问。</p>'
      : state.detail ? `<dl>${metadataFields.map(([key, label]) => `<dt>${label}</dt><dd>${escape(state.detail[key] ?? '—')}</dd>`).join('')}</dl><p class="muted">此处仅为 Runtime 执行元数据；conditional 不表示目标系统已核实。</p>` : '';
  return `<div class="table-scroll"><table><thead><tr><th>Evidence</th><th>摘要</th><th>核实</th><th>详情</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="empty">没有可读取的执行元数据。</td></tr>'}</tbody></table></div>${state.nextBeforeEvidenceId ? '<button class="btn btn-sm" data-evidence-more>加载更早记录</button>' : ''}${detail}`;
}
