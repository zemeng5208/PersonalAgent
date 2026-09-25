import type {
  WakeDetectedEvent,
  WakeLifecycleController,
  WakeLifecycleStateSnapshot,
} from '@personal-agent/voice-wake';

import {VoiceSessionError} from './errors.js';
import type {
  VoiceSessionManager,
  VoiceSessionSnapshot,
} from './voice-session.js';

export interface VoiceWakeBindingOptions {
  readonly wake: WakeLifecycleController;
  readonly voice: VoiceSessionManager;
}

/**
 * Explicit trusted-host composition. The binding never enables a wake source,
 * grants authorization, submits a task, or owns either supplied controller.
 */
export interface VoiceWakeBinding {
  handleWake(event: WakeDetectedEvent): void;
  dispose(): void;
}

interface BoundVoiceStart {
  readonly epoch: number;
  readonly wakeSessionId: number;
  readonly parent: AbortController;
  voiceSessionId?: string;
}

const INITIAL_WAKE_LIFECYCLE: WakeLifecycleStateSnapshot = Object.freeze({
  state: 'disabled',
  sessionId: null,
  expiresAtMs: null,
});

function invalidBinding(): never {
  throw new VoiceSessionError('INVALID_ARGUMENT', 'Invalid voice wake binding');
}

function terminalVoiceState(snapshot: VoiceSessionSnapshot): boolean {
  return snapshot.state === 'stopped'
    || snapshot.state === 'cancelled'
    || snapshot.state === 'expired';
}

function deadlineFrom(expiresAtMs: number): string | undefined {
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs < 0) return undefined;
  try {
    return new Date(expiresAtMs).toISOString();
  } catch {
    return undefined;
  }
}

class VoiceWakeBindingImpl implements VoiceWakeBinding {
  private wakeLifecycle = INITIAL_WAKE_LIFECYCLE;
  private active: BoundVoiceStart | undefined;
  private epoch = 0;
  private disposed = false;
  private unsubscribeWake: () => void = () => {};
  private unsubscribeVoice: () => void = () => {};

  constructor(
    private readonly wake: WakeLifecycleController,
    private readonly voice: VoiceSessionManager,
  ) {
    try {
      const unsubscribeWake = wake.subscribeLifecycle(snapshot => this.onWakeLifecycle(snapshot));
      if (typeof unsubscribeWake !== 'function') invalidBinding();
      this.unsubscribeWake = unsubscribeWake;

      const unsubscribeVoice = voice.subscribe(snapshot => this.onVoiceSnapshot(snapshot));
      if (typeof unsubscribeVoice !== 'function') invalidBinding();
      this.unsubscribeVoice = unsubscribeVoice;

      wake.setPlaybackActive(voice.current()?.playbackActive ?? false);
    } catch {
      this.unsubscribeVoice();
      this.unsubscribeWake();
      invalidBinding();
    }
  }

  handleWake(event: WakeDetectedEvent): void {
    if (this.disposed || !event || event.kind !== 'wake') return;
    const lifecycle = this.wakeLifecycle;
    if (lifecycle.state !== 'listening'
      || lifecycle.sessionId === null
      || lifecycle.expiresAtMs === null
      || event.sessionId !== lifecycle.sessionId) return;

    const deadline = deadlineFrom(lifecycle.expiresAtMs);
    if (deadline === undefined) return;

    if (Date.now() >= lifecycle.expiresAtMs) return;
    if (!Number.isSafeInteger(event.occurredAtMs)
      || event.occurredAtMs < 0
      || event.occurredAtMs >= lifecycle.expiresAtMs) return;

    const existing = this.active;
    if (existing && !existing.parent.signal.aborted) return;

    const record: BoundVoiceStart = {
      epoch: ++this.epoch,
      wakeSessionId: lifecycle.sessionId,
      parent: new AbortController(),
    };
    // Store before crossing the async start boundary so synchronous lifecycle
    // deactivation can always abort the parent passed to MOD-14.
    this.active = record;

    let pending: Promise<VoiceSessionSnapshot>;
    try {
      pending = this.voice.start({deadline, signal: record.parent.signal});
    } catch {
      this.finishRejectedStart(record);
      return;
    }
    void Promise.resolve(pending).then(
      snapshot => this.finishStarted(record, snapshot),
      () => this.finishRejectedStart(record),
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.epoch++;
    this.unsubscribeVoice();
    this.unsubscribeWake();
    const active = this.active;
    this.active = undefined;
    active?.parent.abort();
    try { this.wake.setPlaybackActive(false); } catch { /* Caller objects remain owned by the host. */ }
  }

  private onWakeLifecycle(snapshot: WakeLifecycleStateSnapshot): void {
    if (this.disposed) return;
    this.wakeLifecycle = snapshot;
    const active = this.active;
    if (!active) return;
    if (snapshot.state !== 'listening' || snapshot.sessionId !== active.wakeSessionId) {
      this.abortActive(active);
    }
  }

  private onVoiceSnapshot(snapshot: VoiceSessionSnapshot): void {
    if (this.disposed) return;
    try { this.wake.setPlaybackActive(snapshot.playbackActive); } catch { /* Subscription must not escape. */ }
    const active = this.active;
    if (!active || active.voiceSessionId !== snapshot.sessionId || !terminalVoiceState(snapshot)) return;
    this.active = undefined;
    this.epoch++;
  }

  private finishStarted(record: BoundVoiceStart, snapshot: VoiceSessionSnapshot): void {
    if (!this.isCurrent(record) || record.parent.signal.aborted) {
      record.parent.abort();
      return;
    }
    if (!this.lifecycleMatches(record)) {
      this.abortActive(record);
      return;
    }
    if (!snapshot || typeof snapshot.sessionId !== 'string' || snapshot.sessionId.length === 0) {
      this.abortActive(record);
      return;
    }
    const current = this.voice.current();
    if (terminalVoiceState(snapshot)
      || current === undefined
      || current.sessionId !== snapshot.sessionId
      || terminalVoiceState(current)) {
      this.abortActive(record);
      return;
    }
    record.voiceSessionId = current.sessionId;
  }

  private finishRejectedStart(record: BoundVoiceStart): void {
    if (!this.isCurrent(record)) return;
    this.active = undefined;
    this.epoch++;
  }

  private abortActive(record: BoundVoiceStart): void {
    if (!this.isCurrent(record)) return;
    this.active = undefined;
    this.epoch++;
    record.parent.abort();
  }

  private lifecycleMatches(record: BoundVoiceStart): boolean {
    return this.wakeLifecycle.state === 'listening'
      && this.wakeLifecycle.sessionId === record.wakeSessionId
      && this.wakeLifecycle.expiresAtMs !== null
      && Date.now() < this.wakeLifecycle.expiresAtMs;
  }

  private isCurrent(record: BoundVoiceStart): boolean {
    return !this.disposed && this.active === record && this.epoch === record.epoch;
  }
}

export function bindVoiceWake(options: VoiceWakeBindingOptions): VoiceWakeBinding {
  if (!options || typeof options !== 'object'
    || !options.wake
    || typeof options.wake.subscribeLifecycle !== 'function'
    || typeof options.wake.setPlaybackActive !== 'function'
    || !options.voice
    || typeof options.voice.start !== 'function'
    || typeof options.voice.current !== 'function'
    || typeof options.voice.subscribe !== 'function') {
    invalidBinding();
  }
  return new VoiceWakeBindingImpl(options.wake, options.voice);
}
