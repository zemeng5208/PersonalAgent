import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {toolArgumentsDigest} from '@personal-agent/tool-gateway';

const TOOL = 'computer.notepad.replace_text';
const END = new Set(['succeeded', 'failed', 'cancelled', 'waiting_reconciliation']);

/** Local user gesture -> existing prepared Runtime task -> Policy -> native adapter.
 * No model can supply the presence gesture, target reference or authorization decision. */
export function createDesktopNotepadHost({createAdapter, createAttempts, transport,
  registerConfirmation, openNotepad, respond, cancelTask, reconcileTask,
  onUpdate = () => {}, onTask = () => {}, now = Date.now}) {
  let application, current, closed = false, refreshing = false, recovering = false;
  let state = {available: true, busy: false, state: 'ready',
    reason: '填写文本后，新建并确认一个空白记事本窗口。'};
  function update(value) { state = {...state, ...value}; onUpdate(); }
  function belongs(taskId) { return current?.taskId === taskId && !current.controller.signal.aborted; }
  const adapter = createAdapter({transport, attempts: createAttempts(() => application.runtime),
    authorizePresence: async ({taskId, targetRef}) => !closed && belongs(taskId)
      && (!targetRef || (current.targetRef === targetRef && current.confirmedUntil > now())),
    prepareObservation: async ({taskId, signal}) => {
      if (!belongs(taskId)) throw Error('Notepad task is no longer active');
      const operation = current;
      await new Promise((resolve, reject) => {
        let done = false, unregister;
        const finish = error => {
          if (done) return;
          done = true; unregister?.(); signal.removeEventListener('abort', abort);
          error ? reject(error) : resolve();
        };
        const abort = () => finish(Error('Notepad preparation cancelled'));
        signal.addEventListener('abort', abort, {once: true});
        if (signal.aborted) { abort(); return; }
        unregister = registerConfirmation(() => {
          if (!belongs(taskId)) return;
          operation.confirmedUntil = now() + 30_000;
          finish();
        });
        if (typeof unregister !== 'function') {
          finish(Error('Notepad confirmation shortcut is unavailable')); return;
        }
        update({state: 'waiting_confirmation',
          reason: '确认新打开的记事本是独立的空白单标签窗口，保持它在前台，按 F9 允许本次写入。'});
        Promise.resolve().then(openNotepad).catch(() => finish(Error('Notepad could not be opened')));
      });
    },
  });
  function pendingTasks() {
    const tasks=[];
    if (!application) return tasks;
    let beforeSequence;
    do {
      const page=application.runtime.listTasks({states:['waiting_reconciliation'],limit:100,
        ...(beforeSequence === undefined ? {} : {beforeSequence})});
      for (const task of page.items) {
        try {
          const read=application.readHostToolTask(task.taskId);
          if (read.toolName === TOOL && read.toolVersion === '1.0.0') tasks.push({taskId:task.taskId,state:task.state});
        } catch { /* Only the original host namespace is eligible. */ }
      }
      beforeSequence=page.nextBeforeSequence;
    } while (beforeSequence !== undefined);
    return tasks;
  }
  function snapshot() { return structuredClone({...state,recovering,
    recoveryAvailable:typeof reconcileTask === 'function',pendingTasks:pendingTasks()}); }
  /** Host-only status read. Runtime validates and persists any confirmed result. Never execute here. */
  async function recoverOriginalRun(input, context) {
    if (closed || !application || current || !input || typeof input.taskId !== 'string'
      || input.runId !== `host-tool-${input.taskId}` || !(context?.signal instanceof AbortSignal)
      || !Number.isFinite(Date.parse(context.deadline))) throw Error('原始记事本读回不可用');
    const read=application.readHostToolTask(input.taskId), intent=application.runtime.loadCheckpoint(input.taskId,'host-tool-intent');
    const record=application.runtime.readToolExecutions(input.taskId).find(item=>item.evidenceId === input.runId);
    const attempt=application.runtime.loadCheckpoint(input.taskId,'windows-host-attempt:'+input.runId);
    if (read.toolName !== TOOL || read.toolVersion !== '1.0.0' || read.task.state !== 'waiting_reconciliation'
      || !intent || intent.toolName !== TOOL || intent.toolVersion !== '1.0.0'
      || intent.argumentsDigest !== input.argumentsDigest || intent.argumentsDigest !== toolArgumentsDigest(intent.arguments)
      || !record || record.taskId !== input.taskId || record.toolName !== TOOL || record.toolVersion !== '1.0.0'
      || record.policyDecision !== 'allow' || !record.executionStarted || !['started','unknown'].includes(record.state)
      || !application.runtime.matchesToolExecutionInput(record,{arguments:intent.arguments,scopeRef:input.runId})
      || !attempt || attempt.taskId !== input.taskId || attempt.runId !== input.runId
      || attempt.argumentsDigest !== intent.argumentsDigest || attempt.targetRef !== intent.arguments.targetRef) {
      throw Error('核实请求不匹配原始执行');
    }
    function assertCurrent() {
      if (closed || context.signal.aborted || now() >= Date.parse(context.deadline)
        || application.runtime.getTask(input.taskId).state !== 'waiting_reconciliation'
        || !isDeepStrictEqual(application.runtime.loadCheckpoint(input.taskId,'host-tool-intent'),intent)
        || !isDeepStrictEqual(application.runtime.loadCheckpoint(input.taskId,'windows-host-attempt:'+input.runId),attempt)) {
        throw Error('原始核实绑定已经改变或到期');
      }
    }
    assertCurrent();const result=await adapter.recover(input.taskId,input.runId);assertCurrent();return result;
  }
  async function recover(payload) {
    if (closed || current || recovering || typeof reconcileTask !== 'function' || !payload
      || Object.keys(payload).length !== 1 || typeof payload.taskId !== 'string'
      || !pendingTasks().some(task=>task.taskId === payload.taskId)) throw Error('请选择原始待核实任务');
    recovering=true;update({reason:'正在读取原始执行状态；不会再次写入记事本。'});
    try {
      await reconcileTask(payload.taskId);
      const read=application.readHostToolTask(payload.taskId);
      const verified=read.task.state === 'succeeded' && read.confirmed?.result?.state === 'verified'
        && read.confirmed.evidenceRefs.length > 0;
      update({taskId:payload.taskId,state:read.task.state,busy:false,
        evidenceRefs:verified ? read.confirmed.evidenceRefs : [],reason:verified
          ? '原始执行已核实，原生读回及执行证据已保存。文件尚未保存。'
          : '原始结果仍未获确认；保留待核实状态，不会重复写入。'});
    } finally {recovering=false;onUpdate();}
    return snapshot();
  }
  async function finishPreparation(operation) {
    try {
      const target = await adapter.observe(operation.taskId, operation.deadline, operation.controller.signal);
      if (!belongs(operation.taskId)) throw Error('Notepad task cancelled');
      operation.targetRef = target.targetRef;
      operation.confirmedUntil = Math.min(operation.confirmedUntil, Date.parse(target.expiresAt));
      application.finalizeHostToolTask({taskId: operation.taskId, commandId: operation.commandId,
        expectedTaskRevision: operation.revision, arguments: {targetRef: target.targetRef,
          expectedText: '', replacementText: operation.text}});
      operation.finalized = true;
      operation.text = '';
      update({state: 'authorizing', reason: '已确认本次写入，正在由 Runtime 校验授权与目标。'});
      await refresh();
    } catch (error) {
      await adapter.releaseObservation(operation.taskId).catch(() => {});
      if (!operation.finalized) {
        try { application.cancelPreparedHostToolTask(operation.taskId, operation.commandId, operation.revision); }
        catch { /* Runtime state is read below; never overwrite a concurrent terminal state. */ }
      }
      operation.text = '';
      const task = application.runtime.getTask(operation.taskId);
      update({busy: false, state: task.state, taskId: operation.taskId,
        failureCode: ['UNAUTHORIZED','NOT_FOUND','CANCELLED','TIMEOUT','PROTOCOL_MISMATCH'].includes(error?.code)
          ? error.code : 'EXTERNAL_FAILURE',
        reason: error?.code === 'UNAUTHORIZED' || error?.code === 'NOT_FOUND'
          ? '窗口不满足条件，未获准写入。请使用确认后新建的独立空白单标签窗口。'
          : '准备未完成，已停止本次操作；不会自动重试。'});
      current = undefined;
    }
  }
  function start(payload) {
    if (closed || !application || current || recovering || pendingTasks().length) {
      throw Error('记事本操作尚未就绪或有原始执行等待核实');
    }
    if (!payload || Object.keys(payload).length !== 1 || typeof payload.text !== 'string'
      || !payload.text.trim() || payload.text.length > 4096) throw Error('请输入 1～4096 个字符');
    const commandId = randomUUID(), deadline = new Date(now() + 300_000).toISOString();
    const task = application.prepareHostToolTask({commandId, toolName: TOOL, toolVersion: '1.0.0', deadline});
    current = {taskId: task.taskId, revision: task.revision, commandId, deadline, text: payload.text,
      controller: new AbortController(), finalized: false, confirmedUntil: 0, approvalSent: false};
    try { onTask({taskId: task.taskId, goal: '向新空白记事本写入本次文本'}); }
    catch (error) {
      current.controller.abort(); current = undefined;
      application.cancelPreparedHostToolTask(task.taskId, commandId, task.revision);
      throw error;
    }
    update({busy: true, state: 'preparing', taskId: task.taskId,
      reason: '正在连接本机执行宿主；尚未写入。', evidenceRefs: [], failureCode: null});
    current.job = finishPreparation(current);
    return snapshot();
  }
  async function refresh() {
    if (refreshing || !current?.finalized) return;
    refreshing = true;
    const operation = current;
    try {
      const readback = application.readHostToolTask(operation.taskId);
      if (readback.approval?.state === 'pending' && !operation.approvalSent) {
        operation.approvalSent = true;
        let allow = belongs(operation.taskId) && operation.confirmedUntil > now();
        if (allow) {
          try {
            const ready = await adapter.checkObservationReady(operation.taskId, operation.deadline,
              operation.controller.signal);
            allow = ready.taskId === operation.taskId && ready.targetRef === operation.targetRef
              && operation.confirmedUntil > now();
          } catch { allow = false; }
        }
        await respond({approvalId: readback.approval.approvalId,
          expectedRevision: readback.approval.revision, decision: allow ? 'allow_once' : 'deny'});
        return;
      }
      if (!END.has(readback.task.state)) return;
      const verified = readback.task.state === 'succeeded' && readback.confirmed?.result?.state === 'verified'
        && readback.confirmed.evidenceRefs.length > 0;
      await adapter.releaseObservation(operation.taskId);
      operation.controller.abort(); current = undefined;
      update({busy: false, state: readback.task.state, evidenceRefs: verified ? readback.confirmed.evidenceRefs : [],
        reason: verified ? '写入已完成，原生宿主已读回匹配的文本。文件尚未保存。'
          : readback.task.state === 'cancelled' ? '本次操作已取消；已发生的写入不会自动撤销。'
          : '写入未获确认，请检查记事本实际内容；不会自动重试。'});
    } catch {
      // Do not silently retry an approval whose response may have been lost.
      operation.controller.abort();
      await adapter.releaseObservation(operation.taskId).catch(() => {});
      await cancelTask(operation.taskId).catch(() => {});
      current = undefined;
      update({busy: false, state: 'result_unknown', reason: '本次结果暂时无法确认；请检查任务记录与记事本，不要重复写入。'});
    } finally { refreshing = false; }
  }
  async function cancel() {
    if (!current) return snapshot();
    const operation = current;
    operation.controller.abort();
    if (operation.finalized) await cancelTask(operation.taskId);
    else await operation.job;
    await refresh();
    return snapshot();
  }
  function projectTask(task) {
    if (!application || task?.goal !== `Host tool ${TOOL}`) return null;
    const userMessage = '向新空白记事本写入本次文本';
    try {
      const readback = application.readHostToolTask(task.taskId);
      if (readback.toolName !== TOOL || readback.task.revision !== task.revision) return {userMessage};
      const verified = readback.task.state === 'succeeded' && readback.confirmed?.result?.state === 'verified'
        && readback.confirmed.evidenceRefs.length > 0;
      return {userMessage, ...(verified ? {resultSummary:
        '记事本写入已完成，原生宿主已读回匹配的文本，执行证据已保存。文件尚未保存。'}
        : task.state === 'cancelled' ? {resultSummary: '本次记事本操作已取消，写入未获确认；请核对窗口内容。'} : {})};
    } catch { return {userMessage, ...(task.state === 'cancelled'
      ? {resultSummary: '本次记事本操作已取消，未确认写入；请核对窗口内容。'} : {})}; }
  }
  return {tools: [adapter.tool], bind(value) {if (application) throw Error('Already bound'); application = value;},
    start, refresh, cancel, snapshot, projectTask, recover, recoverOriginalRun,
    async close() {closed = true; await cancel(); await adapter.close();},
  };
}
