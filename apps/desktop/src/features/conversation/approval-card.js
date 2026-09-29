const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function approvalCards(task, approvals = [], now = Date.now()) {
  if (task.state !== 'waiting_approval') return '';
  return approvals.filter(item=>item.taskId===task.taskId && item.state==='pending').map(item=>{
    const expired=Date.parse(item.expiresAt)<=now;
    const buttons=expired?'<p>此授权已过期，请停止任务后重新发起。</p>':
      `<div class="turn-actions"><button type="button" class="turn-action" data-approval-decision="allow_once" data-approval-id="${escape(item.approvalId)}">批准并继续</button><button type="button" class="turn-action" data-approval-decision="deny" data-approval-id="${escape(item.approvalId)}">拒绝</button></div>`;
    return `<section class="approval-card" role="group" aria-label="操作授权"><strong>需要你确认这次操作</strong><p>${escape(item.toolName)}</p><p>权限：${escape(item.scopes.join('、'))}</p>${buttons}<p>批准后继续当前任务，无需再发一条消息。</p></section>`;
  }).join('');
}

export function approvalResponse(id, decision, tasks, approvals, now = Date.now()) {
  const approval=approvals.find(item=>item.approvalId===id && item.state==='pending');
  const task=approval && tasks.find(item=>item.taskId===approval.taskId);
  if (!approval || task?.state!=='waiting_approval' || Date.parse(approval.expiresAt)<=now
    || !['allow_once','deny'].includes(decision)) throw Error('授权已变化，请查看最新任务状态');
  return {approvalId:id,decision,expectedRevision:approval.revision,taskId:approval.taskId};
}
