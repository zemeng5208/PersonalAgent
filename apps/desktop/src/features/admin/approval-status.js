const stateLabels = {
  pending: '待处理',
  allowed: '已允许',
  denied: '已拒绝',
  expired: '已失效',
  invalid: '期限无效',
};

function expiryMillis(expiresAt) {
  if (typeof expiresAt !== 'string') return Number.NaN;
  return Date.parse(expiresAt);
}

export function approvalPresentation(item, now = Date.now()) {
  const expiresAtMillis = expiryMillis(item?.expiresAt);
  const hasValidExpiry = Number.isFinite(expiresAtMillis);
  const sourceState = ['pending', 'allowed', 'denied'].includes(item?.state) ? item.state : 'invalid';
  const state = sourceState === 'pending'
    ? (!hasValidExpiry ? 'invalid' : expiresAtMillis <= now ? 'expired' : 'pending')
    : sourceState;
  const scopes = Array.isArray(item?.scopes)
    ? item.scopes.filter(scope => typeof scope === 'string' && scope.length > 0)
    : [];
  return {
    action: typeof item?.action === 'string' && item.action ? item.action : 'Runtime 未公开工具',
    scopesLabel: scopes.length ? scopes.join(', ') : 'Runtime 未公开范围',
    argumentLabel: item?.argumentSummary === 'redacted' ? '已由 Runtime 脱敏' : 'Runtime 未公开参数',
    expiresAtLabel: hasValidExpiry ? new Date(expiresAtMillis).toISOString() : 'Runtime 未公开有效期限',
    state,
    stateLabel: stateLabels[state],
    actionable: state === 'pending',
    expiresAtMillis,
  };
}

export function nextApprovalExpiry(items, now = Date.now()) {
  let next;
  for (const item of items ?? []) {
    const presentation = approvalPresentation(item, now);
    if (!presentation.actionable) continue;
    if (next === undefined || presentation.expiresAtMillis < next) next = presentation.expiresAtMillis;
  }
  return next;
}

export function authorizationListHtml(items, escape, now = Date.now(), options = {}) {
  const {canRevoke = false, revocations = new Map()} = options;
  const rows = (items ?? []).map(item => {
    const presentation = approvalPresentation(item, now);
    const revision = Number.isSafeInteger(item?.revision) ? item.revision : 0;
    const revokeStatus = revocations.get(`${item.approvalId}:${revision}`);
    const revokeControl = revokeStatus?.state === 'confirmed'
      ? `<span class="status-note">${revokeStatus.revoked ? '已撤销' : '已无有效授权'}（授权存储读回）</span>`
      : canRevoke && presentation.state === 'allowed' && revision > 0
        ? `<button class="btn btn-sm btn-danger" data-revoke="${escape(item.approvalId)}" data-task="${escape(item.taskId)}" data-revision="${revision}" ${revokeStatus?.state === 'checking' ? 'disabled' : ''}>${revokeStatus?.state === 'error' ? '重试撤销' : '核验并撤销'}</button>${revokeStatus?.state === 'error' ? '<small role="alert">撤销未获确认</small>' : ''}`
        : '<span class="status-note">不可操作</span>';
    const decisions = presentation.actionable
      ? `<button class="btn btn-sm" data-approval="allow_once" data-id="${escape(item.approvalId)}" data-task="${escape(item.taskId)}" data-revision="${revision}">允许一次</button> <button class="btn btn-sm btn-danger" data-approval="deny" data-id="${escape(item.approvalId)}" data-task="${escape(item.taskId)}" data-revision="${revision}">拒绝</button>`
      : revokeControl;
    return `<tr><td>${escape(item.approvalId)}</td><td>${escape(item.taskId)}</td><td><b>${escape(presentation.action)}</b><br><small>参数：${escape(presentation.argumentLabel)}</small><br><small>范围：${escape(presentation.scopesLabel)}</small></td><td>${escape(presentation.stateLabel)}<br><small>到期：${escape(presentation.expiresAtLabel)}</small></td><td>${revision}<br>${decisions}</td></tr>`;
  }).join('');
  return `<div class="sheet"><h2>授权状态</h2><p class="muted">撤销需受信宿主逐次鉴权并读回授权存储；仅阻止后续使用，已开始的操作不会回滚。</p><div class="table-scroll"><table><thead><tr><th>授权</th><th>任务</th><th>工具与范围</th><th>状态与期限</th><th>决定</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="empty">没有待处理授权。授权决定由 Runtime 校验，界面不直接授予权限。</td></tr>'}</tbody></table></div></div>`;
}
