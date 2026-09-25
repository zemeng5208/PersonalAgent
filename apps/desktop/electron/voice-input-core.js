const CAPTURE_MS = 60_000;
const SESSION_MS = 10 * 60_000;
const TERMINAL = new Set(['stopped', 'cancelled', 'expired']);

function safeFailure(error) {
  if (error?.code === 'UNSUPPORTED_CAPABILITY') return '语音适配器当前不可用';
  if (error?.code === 'CANCELLED' || error?.code === 'STALE_SESSION') return '语音操作已取消';
  if (error?.code === 'TIMEOUT') return '语音操作已超时';
  return '语音处理失败';
}

/** Host-only explicit capture → ASR → Runtime consumer → playback workflow. */
export function createDesktopVoiceInputCore({source, microphoneHost, client, createBuffer,
  VoiceSessionManager, createConsumer, createSpeechPorts, onUpdate = () => {},
  enabled = false, now = Date.now}) {
  const ports = createSpeechPorts();
  const manager = new VoiceSessionManager({recognition: ports.recognition, output: ports.output});
  const consumer = createConsumer({client, conversationId: 'desktop-voice-panel'});
  let active;
  let lastError = '';
  let disposed = false;
  const publish = () => { try { onUpdate(); } catch {} };

  function snapshot() {
    const session = active?.sessionId ? manager.current() : undefined;
    return {available: false, experimental: enabled, verification: 'unverified',
      status: active?.phase ?? (lastError ? 'error' : 'unavailable'),
      reason: lastError || (enabled ? '语音试用尚待真实设备验收' : '语音供应商尚未连接'),
      capture: microphoneHost.snapshot(),
      ...(session ? {session: {state: session.state, revision: session.revision,
        transcriptReady: session.transcriptReady, replyReady: session.replyReady,
        playbackActive: session.playbackActive}} : {})};
  }

  function assertOwner(senderId) {
    if (!active || active.senderId !== senderId) throw Error('语音操作来源不受信任');
  }

  async function cleanup(record, reason = 'user') {
    let releaseError;
    record.controller.abort();
    record.subscription?.unsubscribe();
    try { await record.subscription?.closed; } catch (error) { releaseError = error; }
    record.buffer?.dispose();
    if (record.sessionId) {
      const state = manager.current();
      if (state?.sessionId === record.sessionId && !TERMINAL.has(state.state)) {
        try { await manager.stop(record.sessionId, reason); }
        catch (error) { releaseError ??= error; }
      }
    }
    if (microphoneHost.snapshot().subscriberCount === 0) {
      try { await microphoneHost.revoke(); }
      catch (error) { releaseError ??= error; }
    }
    if (active === record) active = undefined;
    publish();
    if (releaseError) throw releaseError;
  }

  function startCaptureRecord(senderId, reuseAuthorizedCapture = false) {
    if (!enabled || disposed) throw Error('语音试用当前不可用');
    if (!Number.isSafeInteger(senderId) || senderId <= 0) throw Error('语音操作来源不受信任');
    if (active) throw Error('请先结束当前语音会话');
    const controller = new AbortController();
    const captureDeadline = new Date(now() + CAPTURE_MS).toISOString();
    const sessionDeadline = new Date(now() + SESSION_MS).toISOString();
    const buffer = createBuffer({signal: controller.signal, deadline: sessionDeadline, maxDurationMs: CAPTURE_MS});
    try {
      if (!reuseAuthorizedCapture) microphoneHost.authorize();
    } catch (error) {
      buffer.dispose();
      throw error;
    }
    const record = {senderId, controller, captureDeadline, sessionDeadline, phase: 'acquiring', subscription: undefined,
      buffer,
      sessionId: undefined, replyId: undefined};
    active = record;
    lastError = '';
    publish();
    return record;
  }

  async function runCapture(record) {
    const {senderId} = record;
    try {
      record.subscription = source.subscribe({signal: record.controller.signal, deadline: record.captureDeadline,
        onFrame: frame => {
          if (active !== record || record.phase !== 'acquiring' && record.phase !== 'listening') return;
          try { record.buffer.append(frame.data); }
          catch { queueMicrotask(() => { if (active === record) void cancelCapture(senderId).catch(() => {
            lastError = '麦克风释放未确认'; publish();
          }); }); }
        },
        onEnd: reason => {
          if (active === record && record.phase === 'listening' && reason === 'deadline') {
            queueMicrotask(() => { if (active === record) void finishCapture(senderId).catch(() => {}); });
          } else if (active === record && ['acquiring', 'listening'].includes(record.phase)
            && reason !== 'cancelled') queueMicrotask(() => { if (active === record) void cancelCapture(senderId).catch(() => {
              lastError = '麦克风释放未确认'; publish();
            }); });
        },
      });
      await record.subscription.ready;
      if (active !== record || record.controller.signal.aborted) throw Error('语音采集已取消');
      const session = await manager.start({deadline: record.sessionDeadline, signal: record.controller.signal, locale: 'zh-CN'});
      record.sessionId = session.sessionId;
      record.phase = 'listening';
      publish();
      return snapshot();
    } catch (error) {
      lastError = safeFailure(error);
      try { await cleanup(record); } catch { lastError = '麦克风释放未确认'; }
      throw Error(lastError);
    }
  }

  async function beginCapture(senderId) {
    const record = startCaptureRecord(senderId);
    return runCapture(record);
  }

  /**
   * Trusted host internal entry for wake-triggered capture handoff.
   * Reuses the current active wake-authorized capture (authorized + active + subscriberCount > 0)
   * without calling microphoneHost.authorize() again. Rejects if capture is not in the expected
   * wake-active state.
   */
  async function beginWakeCapture(senderId) {
    const cap = microphoneHost.snapshot();
    if (!cap.authorized || !cap.active || !cap.subscriberCount || cap.subscriberCount <= 0) {
      throw Error('语音唤醒采集未就绪：需要有效的授权采集会话');
    }
    const record = startCaptureRecord(senderId, true);
    return runCapture(record);
  }

  async function finishCapture(senderId) {
    assertOwner(senderId);
    const record = active;
    if (record.phase !== 'listening') throw Error('当前没有可提交的语音采集');
    record.phase = 'recognizing';
    publish();
    let clip;
    try {
      record.subscription.unsubscribe();
      await record.subscription.closed;
      clip = record.buffer.finish();
      record.buffer = undefined;
      const transcript = await manager.recognizeAudio(record.sessionId, clip);
      clip.data.fill(0);
      record.phase = 'consuming';
      publish();
      const reply = await manager.consumeTranscript(record.sessionId, transcript.transcriptId, consumer);
      record.replyId = reply.replyId;
      record.phase = 'awaiting_speech';
      lastError = '';
      publish();
      return snapshot();
    } catch (error) {
      clip?.data.fill(0);
      lastError = safeFailure(error);
      try { await cleanup(record); } catch { lastError = '麦克风释放未确认'; }
      throw Error(lastError);
    }
  }

  async function playReply(senderId) {
    assertOwner(senderId);
    const record = active;
    if (record.phase !== 'awaiting_speech' || !record.replyId) throw Error('当前没有待播报回答');
    const replyId = record.replyId;
    record.replyId = undefined;
    record.phase = 'speaking';
    publish();
    try {
      const result = await manager.speakReply(record.sessionId, replyId);
      await cleanup(record);
      lastError = '';
      return {completed: result.completed, interrupted: result.interrupted, voice: snapshot()};
    } catch (error) {
      lastError = safeFailure(error);
      try { await cleanup(record); } catch { lastError = '语音资源释放未确认'; }
      throw Error(lastError);
    }
  }

  async function stopSpeaking(senderId) {
    assertOwner(senderId);
    const record = active;
    if (record.phase !== 'speaking') return {stopped: false, reason: '当前没有正在播报的回答'};
    try {
      const result = await manager.stopSpeaking(record.sessionId);
      publish();
      return {stopped: result.playbackStopped, resourcesReleased: result.resourcesReleased};
    } catch {
      throw Error('播报停止未确认');
    }
  }

  async function cancelCapture(senderId) {
    assertOwner(senderId);
    const record = active;
    record.phase = 'cancelling';
    publish();
    try { await cleanup(record); }
    catch { lastError = '语音资源释放未确认'; publish(); throw Error(lastError); }
    lastError = '';
    return {cancelled: true, voice: snapshot()};
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    let failure;
    if (active) { try { await cleanup(active, 'disposed'); } catch (error) { failure = error; } }
    try { await source.dispose?.(); } catch (error) { failure ??= error; }
    try { await ports.dispose(); } catch (error) { failure ??= error; }
    if (failure) throw failure;
  }

  return {snapshot, beginCapture, beginWakeCapture, finishCapture, playReply, stopSpeaking, cancelCapture, dispose,
    hasActive: () => Boolean(active)};
}
