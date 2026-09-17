import {
  VoiceSessionError,
  VoiceSessionManager,
  createRuntimeClientTranscriptConsumer,
  createVoicePcmBuffer,
} from '@personal-agent/voice';

const SESSION_LIFETIME_MS = 10 * 60 * 1_000;
const CAPTURE_LIMIT_MS = 60_000;
const PERMISSION_LIFETIME_MS = 8_000;
const TERMINAL_STATES = new Set(['stopped', 'cancelled', 'expired']);

function exactAudioRequest(details) {
  if (!details || typeof details !== 'object') return false;
  let mediaTypes;
  let mediaType;
  try {
    mediaTypes = Object.getOwnPropertyDescriptor(details, 'mediaTypes')?.value;
    mediaType = Object.getOwnPropertyDescriptor(details, 'mediaType')?.value;
  } catch {
    return false;
  }
  if (mediaTypes !== undefined) {
    return Array.isArray(mediaTypes) && mediaTypes.length === 1 && mediaTypes[0] === 'audio';
  }
  return mediaType === 'audio';
}

function capturedAudio(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw Error('语音音频无效');
  let audio;
  try { audio = Object.getOwnPropertyDescriptor(payload, 'audio')?.value; } catch { /* Reject below. */ }
  if (!(audio instanceof Uint8Array)) throw Error('语音音频无效');
  return audio;
}

function safeFailure(error) {
  if (error instanceof VoiceSessionError) {
    if (error.code === 'UNSUPPORTED_CAPABILITY') return '语音能力当前不可用';
    if (error.code === 'CANCELLED' || error.code === 'STALE_SESSION') return '语音操作已取消';
    if (error.code === 'TIMEOUT') return '语音操作已超时';
    if (error.code === 'INVALID_ARGUMENT' || error.code === 'INVALID_STATE') return '语音输入无效';
  }
  return '语音处理失败';
}

function publicSession(snapshot) {
  if (!snapshot) return undefined;
  return {
    state: snapshot.state,
    revision: snapshot.revision,
    transcriptReady: snapshot.transcriptReady,
    replyReady: snapshot.replyReady,
    playbackActive: snapshot.playbackActive,
    ...(snapshot.terminalReason ? {terminalReason: snapshot.terminalReason} : {}),
  };
}

/**
 * Trusted Desktop composition for explicit push-to-talk. Provider credentials,
 * receipt identifiers, transcript text and reply text never cross into Renderer.
 */
export function createDesktopVoiceInput({
  client,
  recognition,
  output,
  disposePorts,
  onUpdate = () => {},
  now = () => Date.now(),
  unavailableReason = '语音供应商尚未连接',
} = {}) {
  const runtimeReady = Boolean(client && typeof client.call === 'function');
  const captureAvailable = Boolean(recognition && runtimeReady);
  const playbackAvailable = Boolean(output);
  const manager = new VoiceSessionManager({recognition, output});
  const consumer = runtimeReady
    ? createRuntimeClientTranscriptConsumer({client, conversationId: 'desktop-panel'})
    : undefined;
  let activeSenderId;
  let rootController;
  let pcmBuffer;
  let replyReceipt;
  let permissionGrant;
  let lastError = '';
  let disposed = false;
  let portsDisposed = false;

  const publish = () => {
    try { onUpdate(); } catch { /* UI notification cannot change voice state. */ }
  };
  const unsubscribe = manager.subscribe(() => publish());

  function snapshot() {
    const session = manager.current();
    const status = session?.state ?? (lastError ? 'error' : captureAvailable ? 'ready' : 'unavailable');
    return {
      available: captureAvailable,
      captureAvailable,
      playbackAvailable,
      status,
      reason: lastError || (captureAvailable ? '按住语音按钮说话，松开发送' : unavailableReason),
      session: publicSession(session),
    };
  }

  function assertSender(senderId) {
    if (!Number.isSafeInteger(senderId) || senderId <= 0) throw Error('语音操作来源不受信任');
    if (activeSenderId !== senderId) throw Error('语音操作来源不受信任');
  }

  function clearCaptureStorage() {
    permissionGrant = undefined;
    pcmBuffer?.dispose();
    pcmBuffer = undefined;
  }

  async function stopCurrent(reason = 'user') {
    clearCaptureStorage();
    const session = manager.current();
    if (session && !TERMINAL_STATES.has(session.state)) {
      try { await manager.stop(session.sessionId, reason); } catch { /* Best-effort trusted cleanup. */ }
    }
    rootController?.abort();
    rootController = undefined;
    replyReceipt = undefined;
    activeSenderId = undefined;
  }

  async function beginCapture(senderId) {
    if (disposed) throw Error('语音能力已关闭');
    if (!captureAvailable || !consumer) throw Error(unavailableReason);
    if (!Number.isSafeInteger(senderId) || senderId <= 0) throw Error('语音操作来源不受信任');
    await stopCurrent('user');
    lastError = '';
    activeSenderId = senderId;
    rootController = new AbortController();
    const deadline = new Date(Date.now() + SESSION_LIFETIME_MS).toISOString();
    try {
      await manager.start({deadline, signal: rootController.signal, locale: 'zh-CN'});
      pcmBuffer = createVoicePcmBuffer({signal: rootController.signal, deadline, maxDurationMs: CAPTURE_LIMIT_MS});
      permissionGrant = {senderId, expiresAt: now() + PERMISSION_LIFETIME_MS};
      publish();
      return snapshot();
    } catch (error) {
      await stopCurrent('user');
      lastError = safeFailure(error);
      publish();
      throw Error(lastError);
    }
  }

  function checkMediaPermission(senderId, details) {
    const grant = permissionGrant;
    return Boolean(
      grant
      && grant.senderId === senderId
      && grant.expiresAt > now()
      && activeSenderId === senderId
      && exactAudioRequest(details),
    );
  }

  function consumeMediaPermission(senderId, details) {
    if (!checkMediaPermission(senderId, details)) {
      permissionGrant = undefined;
      return false;
    }
    permissionGrant = undefined;
    return true;
  }

  async function finishCapture(senderId, payload) {
    assertSender(senderId);
    if (!captureAvailable || !consumer) throw Error(unavailableReason);
    const session = manager.current();
    if (!session || session.state !== 'listening' || !pcmBuffer) throw Error('当前没有可提交的语音采集');
    permissionGrant = undefined;
    const audio = capturedAudio(payload);
    let clip;
    try {
      pcmBuffer.append(audio);
      audio.fill(0);
      clip = pcmBuffer.finish();
      pcmBuffer = undefined;
      const transcript = await manager.recognizeAudio(session.sessionId, clip);
      clip.data.fill(0);
      replyReceipt = await manager.consumeTranscript(session.sessionId, transcript.transcriptId, consumer);
      lastError = '';
      publish();
      return snapshot();
    } catch (error) {
      try { audio.fill(0); } catch { /* Best-effort wipe of the IPC copy. */ }
      try { clip?.data.fill(0); } catch { /* VoiceSessionManager normally owns this wipe. */ }
      lastError = safeFailure(error);
      await stopCurrent('user');
      publish();
      throw Error(lastError);
    }
  }

  async function cancelCapture(senderId) {
    assertSender(senderId);
    await stopCurrent('user');
    lastError = '';
    publish();
    return {cancelled: true, voice: snapshot()};
  }

  async function playReply(senderId) {
    assertSender(senderId);
    if (!playbackAvailable) throw Error('语音播报当前不可用');
    const receipt = replyReceipt;
    const session = manager.current();
    if (!receipt || !session || !session.replyReady) throw Error('当前没有可播报的回答');
    replyReceipt = undefined;
    try {
      const result = await manager.speakReply(receipt.sessionId, receipt.replyId);
      lastError = '';
      publish();
      return result;
    } catch (error) {
      lastError = safeFailure(error);
      publish();
      throw Error(lastError);
    }
  }

  async function stopPlayback(senderId) {
    assertSender(senderId);
    const session = manager.current();
    if (!session || !session.playbackActive) {
      return {stopped: false, reason: '当前没有正在播报的回答'};
    }
    const result = await manager.stopSpeaking(session.sessionId);
    publish();
    return {stopped: result.playbackStopped, resourcesReleased: result.resourcesReleased};
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    await stopCurrent('disposed');
    if (!portsDisposed && typeof disposePorts === 'function') {
      portsDisposed = true;
      await disposePorts();
    }
  }

  return Object.freeze({
    snapshot,
    beginCapture,
    checkMediaPermission,
    consumeMediaPermission,
    finishCapture,
    cancelCapture,
    playReply,
    stopPlayback,
    dispose,
  });
}
