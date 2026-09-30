// Host-local overlay for the existing Conversations store, not a second task store.
export function createLiveVoiceHistory({save, readContext = () => '', recentLimit = 20}) {
  if (typeof save !== 'function' || !Number.isSafeInteger(recentLimit) || recentLimit < 1) {
    throw Error('Live 历史保存端口无效');
  }
  const recent = new Map(), pending = new Map();
  function trim() {
    for (const id of recent.keys()) {
      if (recent.size <= recentLimit) break;
      if (!pending.has(id)) recent.delete(id);
    }
  }
  function flush() {
    for (const [id, message] of pending) {
      try {save({...message});} catch {return false;}
      pending.delete(id);
    }
    trim();
    return true;
  }
  function record(message) {
    if (!message || !['user', 'assistant'].includes(message.role)
      || typeof message.id !== 'string' || !message.id || message.id.length > 256
      || typeof message.sessionId !== 'string' || !message.sessionId || message.sessionId.length > 256
      || typeof message.text !== 'string' || !message.text.trim() || message.text.length > 100000
      || !Number.isFinite(Date.parse(message.createdAt))) throw Error('Live 对话消息格式无效');
    const prior = recent.get(message.id);
    if (prior && (prior.sessionId !== message.sessionId || prior.role !== message.role)) {
      throw Error('Live 对话消息标识冲突');
    }
    const value = {id:message.id, sessionId:message.sessionId, role:message.role,
      text:message.text.trim(), createdAt:prior?.createdAt ?? new Date(message.createdAt).toISOString()};
    if (!prior || prior.text !== value.text) {
      recent.set(value.id, value);
      pending.set(value.id, value);
    }
    flush();
    trim();
    return {...value};
  }
  function context() {
    let data = {};
    try {
      const raw = readContext();
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
    } catch { /* A store read failure must not discard the unsaved overlay. */ }
    const entries = [], messages = new Map();
    for (const task of (Array.isArray(data.tasks) ? data.tasks : [])) {
      const time = Date.parse(task?.createdAt) || 0;
      if (typeof task?.goal === 'string' && task.goal.trim()) entries.push({time, role:'user', text:task.goal});
      if (task?.state === 'succeeded' && typeof task.result === 'string' && task.result.trim()) {
        entries.push({time:time+1, role:'assistant', text:task.result});
      } else if (task?.state === 'failed') {
        entries.push({time:time+1, role:'assistant', text:`[任务执行失败：${task.failureReason || '未成功'}]`});
      } else if (task?.state === 'cancelled') entries.push({time:time+1, role:'assistant', text:'[任务已取消]'});
    }
    let index = 0;
    for (const message of [...(Array.isArray(data.messages) ? data.messages : []), ...recent.values()]) {
      if (!message || !['user', 'assistant'].includes(message.role)
        || typeof message.text !== 'string' || !message.text.trim()) continue;
      // Identity dedup preserves intentional repeated sentences in separate turns.
      const id = typeof message.id === 'string' ? message.id : `unidentified:${index++}`;
      messages.set(id, {time:Date.parse(message.createdAt)||0, role:message.role, text:message.text});
    }
    entries.push(...messages.values());
    return entries.sort((a,b)=>a.time-b.time).slice(-10)
      .map(({role,text})=>({role,text:String(text).slice(0,1600)}));
  }
  return {record, flush, context, messages:()=>[...recent.values()].map(message=>({...message})), snapshot:()=>({degraded:pending.size>0, pendingCount:pending.size,
    transcripts:[...recent.values()].slice(-recentLimit).map(message=>({...message}))})};
}
