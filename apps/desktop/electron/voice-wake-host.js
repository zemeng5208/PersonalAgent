/**
 * Desktop voice wake host helper for Electron main process (MOD-11/MOD-15).
 *
 * Thin composition layer wiring:
 *   - Trusted host microphone capture / PCM frame source (sharing refcount/fanout with explicit ASR)
 *   - Bounded Chinese keyword detector (Windows System.Speech keyword detector via DI)
 *   - PCM keyword wake signal source (@personal-agent/voice-wake createPcmKeywordWakeSignalSource via DI)
 *   - Wake session lifecycle controller (@personal-agent/voice-wake createWakeLifecycleController via DI)
 *   - Explicit onWake callback for trusted host wake dispatch
 *
 * Security & Architecture constraints:
 *   1. Default OFF: helper cannot self-issue authorization or read Renderer parameters as authorization.
 *      Authorization must be explicitly injected by trusted main via a finite lease.
 *   2. Single physical capture source: KWS and explicit ASR share the same microphoneHost/binding refcount.
 *   3. Ready gate: enable() only resolves to 'listening' after both detector.ready and pcm.ready resolve.
 *   4. Self-wake suppression: setPlaybackActive(true) suppresses wake detection during speech playback
 *      without stopping capture or cancelling tasks.
 *   5. Release verification: disable(), revoke(), and dispose() await confirmation of both PCM subscription
 *      detachment and native detector child termination; unconfirmed release rejects rather than claiming success.
 *   6. No second state machine: delegates lifecycle to the injected wake lifecycle controller.
 *   7. onWake returns when the trusted ASR capture is ready. The helper then releases its wake
 *      reference; revoke and dispose never wait for the callback itself.
 *
 * Production wiring (main.js, not done here):
 *   main passes onWake: (event) => voiceInput.beginWakeCapture(senderId)
 *   main passes setPlaybackActive driven by voiceInput.snapshot().session?.playbackActive
 *
 * Dependencies not in #170 base (PR must list):
 *   - #131 createWakeLifecycleController / WakeLifecycleController
 *   - #131 createPcmKeywordWakeSignalSource
 *   - #169 createWindowsSystemSpeechKeywordDetector
 *   - #146 bindVoiceWake (NOT used by this helper; single onWake path only)
 */

function safeFailure(error) {
  if (error?.code === 'UNSUPPORTED_CAPABILITY') return '语音唤醒组件不可用';
  if (error?.code === 'PERMISSION_DENIED') return '麦克风权限已拒绝';
  if (error?.code === 'PERMISSION_UNAVAILABLE') return '未提供有效的语音唤醒授权';
  if (error?.code === 'CANCELLED') return '语音唤醒已取消';
  if (error?.code === 'EXPIRED') return '语音唤醒授权已过期';
  if (error?.code === 'TIMEOUT') return '语音唤醒启动超时';
  if (error?.code === 'SOURCE_UNAVAILABLE') return '语音唤醒源不可用';
  if (error?.code === 'DEVICE_UNAVAILABLE') return '麦克风设备不可用';
  if (error?.code === 'SOURCE_ERROR') return '语音唤醒源内部错误';
  if (error?.code === 'CALLBACK_FAILED') return '语音唤醒派发失败';
  return '语音唤醒操作失败';
}

export function createDesktopVoiceWakeHost({
  microphoneHost,
  source,
  createVoicePcmSource,
  detector,
  createKeywordDetector,
  keyword,
  createPcmKeywordWakeSignalSource,
  createWakeLifecycleController,
  authorization,
  onWake,
  onError = () => {},
  onUpdate = () => {},
  cooldownMs,
  enabled = false,
  now = Date.now,
} = {}) {
  // Keyword detector resolution via DI
  let keywordDetector = detector ?? null;
  if (!keywordDetector && typeof createKeywordDetector === 'function') {
    keywordDetector = keyword !== undefined
      ? createKeywordDetector({keyword})
      : createKeywordDetector();
  }

  // PCM source resolution: reuse host injected source or create from microphoneHost.binding
  let pcmSource = source ?? null;
  let ownsPcmSource = false;
  if (!pcmSource && microphoneHost?.binding) {
    if (typeof createVoicePcmSource === 'function') {
      pcmSource = createVoicePcmSource(microphoneHost.binding);
      ownsPcmSource = true;
    }
  }

  let isEnabled = Boolean(enabled);
  let disposed = false;
  let playbackActive = false;
  let lastError = '';
  let currentAuthPort = authorization ?? null;
  let currentLease = null;

  const publish = () => { try { onUpdate(); } catch {} };

  // Track attachments for release verification without clearing on .finally (preserve rejection evidence)
  let lastPcmSub = null;
  let lastDetectorSession = null;
  let releaseFailure = null;

  const wrappedPcmSource = pcmSource ? {
    subscribe(opts) {
      const sub = pcmSource.subscribe(opts);
      lastPcmSub = sub;
      return sub;
    },
    dispose() { return pcmSource.dispose?.(); },
  } : null;

  const wrappedDetector = keywordDetector ? {
    start(opts) {
      const session = keywordDetector.start(opts);
      lastDetectorSession = session;
      return session;
    },
  } : null;

  // Underlying wake signal source via DI factory
  const underlyingWakeSignalSource = (createPcmKeywordWakeSignalSource && wrappedPcmSource && wrappedDetector)
    ? createPcmKeywordWakeSignalSource(wrappedPcmSource, wrappedDetector)
    : null;

  let currentWakeSubscription = null;

  const wrappedWakeSignalSource = underlyingWakeSignalSource ? {
    async subscribe(listener, context) {
      const wrappedListener = (event) => {
        if (disposed || !isListening() || playbackActive) return;
        if (currentLease && now() >= currentLease.expiresAtMs) return;
        listener(event);
      };

      try {
        const sub = await underlyingWakeSignalSource.subscribe(wrappedListener, context);
        currentWakeSubscription = sub;
        return sub;
      } catch (startErr) {
        // Startup failed. Actively stop any partially-created resources, then await closure.
        const pending = [];
        let releaseCallFailed = false;
        if (lastDetectorSession) {
          try { const r = lastDetectorSession.stop?.(); if (r && typeof r.then === 'function') pending.push(r); }
          catch { releaseCallFailed = true; }
          if (lastDetectorSession.closed) pending.push(Promise.resolve(lastDetectorSession.closed));
        }
        if (lastPcmSub) {
          try { lastPcmSub.unsubscribe?.(); } catch { releaseCallFailed = true; }
          if (lastPcmSub.closed) pending.push(Promise.resolve(lastPcmSub.closed));
        }
        const results = await Promise.allSettled(pending);
        if (releaseCallFailed || results.some(result => result.status === 'rejected')) {
          releaseFailure = new Error('语音唤醒资源释放未确认');
          throw releaseFailure;
        }
        throw startErr;
      }
    },
  } : null;

  async function awaitResourceClosure() {
    if (releaseFailure) throw releaseFailure;
    const pending = [];
    if (currentWakeSubscription?.closed) pending.push(Promise.resolve(currentWakeSubscription.closed));
    if (lastPcmSub?.closed) pending.push(Promise.resolve(lastPcmSub.closed));
    if (lastDetectorSession?.closed) pending.push(Promise.resolve(lastDetectorSession.closed));
    if (pending.length > 0) {
      const results = await Promise.allSettled(pending);
      const rejected = results.find(r => r.status === 'rejected');
      if (rejected) throw rejected.reason;
    }
  }

  // Authorization checker: delegates to caller-provided auth port or finite lease
  const effectiveAuthPort = {
    async check(input) {
      if (currentAuthPort && typeof currentAuthPort.check === 'function') {
        return currentAuthPort.check(input);
      }
      if (currentLease) {
        if (now() >= currentLease.expiresAtMs) {
          return {kind: 'denied', reason: 'expired'};
        }
        return {kind: 'allowed', expiresAtMs: currentLease.expiresAtMs,
          revocationSignal: currentLease.revocationSignal};
      }
      return {kind: 'denied', reason: 'unavailable'};
    },
  };

  let handoffPending = null;

  function handleWakeEvent(event) {
    if (disposed || !isListening() || playbackActive) return;
    if (currentLease && now() >= currentLease.expiresAtMs) return;
    if (!onWake || handoffPending?.sessionId === event.sessionId) return;
    const handoff = {sessionId: event.sessionId};
    handoffPending = handoff;
    let captureReady;
    try { captureReady = onWake(event); }
    catch (error) { captureReady = Promise.reject(error); }
    // The trusted callback resolves when the ASR subscription is ready. Keep
    // wake's microphone reference until then, then detach only that reference.
    // Teardown never waits for this callback, so a stalled callback cannot block revoke.
    const finishHandoff = async (failed) => {
      if (handoffPending !== handoff) return;
      if (failed) handleControllerError({code: 'CALLBACK_FAILED'});
      // A late callback from an old session must not stop a newly enabled wake.
      if (controller?.snapshot?.()?.sessionId === handoff.sessionId) {
        try { await disable(); }
        catch { handleControllerError({code: 'SOURCE_ERROR'}); }
      }
      if (handoffPending === handoff) handoffPending = null;
    };
    void Promise.resolve(captureReady).then(
      () => finishHandoff(false),
      () => finishHandoff(true),
    ).catch(() => handleControllerError({code: 'CALLBACK_FAILED'}));
  }

  function handleControllerError(err) {
    lastError = err?.code ? safeFailure(err) : (err?.message || '语音唤醒发生异常');
    publish();
    try { onError(err); } catch {}
  }

  // Initialize wake lifecycle controller via DI
  let controller = null;
  if (createWakeLifecycleController && wrappedWakeSignalSource) {
    controller = createWakeLifecycleController({
      authorization: effectiveAuthPort,
      source: wrappedWakeSignalSource,
      onWake: handleWakeEvent,
      onError: handleControllerError,
      cooldownMs,
      clock: {
        now: () => now(),
        setTimeout: (cb, ms) => {
          const handle = setTimeout(cb, ms);
          return {cancel: () => clearTimeout(handle)};
        },
      },
    });
  }

  function isAvailable() {
    return !disposed && Boolean(controller && wrappedWakeSignalSource);
  }

  function isListening() {
    if (disposed || !isEnabled) return false;
    return controller?.snapshot?.()?.state === 'listening';
  }

  function snapshot() {
    const cs = controller?.snapshot?.();
    let status;
    if (disposed) status = 'disposed';
    else if (!isAvailable()) status = 'unavailable';
    else if (!isEnabled) status = 'disabled';
    else if (cs?.state === 'listening') status = 'listening';
    else if (lastError) status = 'error';
    else status = cs?.state ?? 'disabled';

    return {
      available: isAvailable(), enabled: isEnabled, status, playbackActive,
      sessionId: cs?.sessionId ?? null,
      expiresAtMs: cs?.expiresAtMs ?? currentLease?.expiresAtMs ?? null,
      reason: lastError || (!isAvailable() ? '语音唤醒组件尚未就绪' : (isEnabled ? '' : '语音唤醒未开启')),
      capture: microphoneHost?.snapshot?.(),
    };
  }

  async function enable({deadlineAtMs, signal, lease, authorization: callAuth} = {}) {
    if (disposed) throw new Error('语音唤醒已销毁');
    if (!isEnabled) throw new Error('语音唤醒未开启');
    if (!controller) throw new Error('语音唤醒组件不可用');

    if (callAuth) currentAuthPort = callAuth;
    if (lease) {
      if (!lease.expiresAtMs || !Number.isSafeInteger(lease.expiresAtMs) || !lease.revocationSignal) {
        throw new TypeError('Invalid authorization lease');
      }
      currentLease = lease;
    }
    if (!currentAuthPort && !currentLease) throw new Error('未提供有效的语音唤醒授权');

    const deadline = deadlineAtMs ?? (currentLease ? currentLease.expiresAtMs : undefined);
    if (!Number.isSafeInteger(deadline) || deadline <= now()) {
      throw new TypeError('Invalid enable deadline: must be a finite timestamp in the future');
    }

    await awaitResourceClosure();
    lastError = '';
    publish();

    try {
      const result = await controller.enable({deadlineAtMs: deadline, signal});
      if (releaseFailure) throw releaseFailure;
      if (result.kind === 'not_listening') {
        lastError = safeFailure({code: result.reason?.toUpperCase()});
        publish();
        return {kind: 'not_listening', reason: result.reason, snapshot: snapshot()};
      }
      publish();
      return {kind: 'listening', sessionId: result.sessionId, expiresAtMs: result.expiresAtMs, snapshot: snapshot()};
    } catch (err) {
      lastError = safeFailure(err);
      publish();
      throw err;
    }
  }

  async function disable() {
    controller?.disable?.();
    await awaitResourceClosure();
    publish();
    return snapshot();
  }

  async function revoke() {
    currentLease = null;
    currentAuthPort = null;
    let failure;
    try { controller?.disable?.(); } catch (error) { failure = error; }
    try { await awaitResourceClosure(); } catch (error) { failure ??= error; }
    // User revoke is global: still stop the physical capture when wake cleanup
    // cannot be confirmed, including any concurrent ASR subscriber.
    try { await microphoneHost?.revoke?.(); } catch (error) { failure ??= error; }
    publish();
    if (failure) throw failure;
    return snapshot();
  }

  function setPlaybackActive(active) {
    playbackActive = Boolean(active);
    controller?.setPlaybackActive?.(playbackActive);
    publish();
  }

  async function setEnabled(nextEnabled) {
    const next = Boolean(nextEnabled);
    if (isEnabled === next) return snapshot();
    isEnabled = next;
    if (!isEnabled) await disable();
    publish();
    return snapshot();
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    isEnabled = false;
    currentLease = null;
    let failure;
    try { controller?.dispose?.(); } catch (err) { failure ??= err; }
    try { await awaitResourceClosure(); } catch (err) { failure ??= err; }
    if (ownsPcmSource && pcmSource?.dispose) {
      try { await pcmSource.dispose(); } catch (err) { failure ??= err; }
    }
    publish();
    if (failure) throw failure;
  }

  return {
    snapshot, enable, disable, revoke, setPlaybackActive, setEnabled, dispose,
    isListening, isAvailable,
    get source() { return pcmSource; },
    get controller() { return controller; },
  };
}
