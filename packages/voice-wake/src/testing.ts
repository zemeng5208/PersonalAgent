import type {
  WakeAuthorizationCheck,
  WakeAuthorizationDecision,
  WakeAuthorizationPort,
  WakeClock,
  WakeSignalSource,
  WakeSourceContext,
  WakeSourceEvent,
  WakeSubscription,
  WakeTimer,
} from './index.js';

interface FakeTimer {
  at: number;
  callback: () => void;
  active: boolean;
}

/** Deterministic timer source for lifecycle tests; it has no wall-clock side effects. */
export class FakeWakeClock implements WakeClock {
  private readonly timers: FakeTimer[] = [];

  constructor(private currentMs = 0) {
    if (!Number.isSafeInteger(currentMs) || currentMs < 0) throw new Error('Invalid fake clock time');
  }

  now = (): number => this.currentMs;

  setTimeout(callback: () => void, delayMs: number): WakeTimer {
    if (!Number.isSafeInteger(delayMs) || delayMs < 0) throw new Error('Invalid fake timer delay');
    const timer: FakeTimer = {at: this.currentMs + delayMs, callback, active: true};
    this.timers.push(timer);
    return {cancel: () => { timer.active = false; }};
  }

  advance(ms: number): void {
    if (!Number.isSafeInteger(ms) || ms < 0) throw new Error('Invalid fake clock advance');
    const target = this.currentMs + ms;
    while (true) {
      const next = this.timers.filter(timer => timer.active && timer.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      next.active = false;
      this.currentMs = next.at;
      next.callback();
    }
    this.currentMs = target;
  }
}

interface SourceEntry {
  listener: (event: WakeSourceEvent) => void;
  active: boolean;
}

/** Source Fake exposes active and deliberately late delivery for epoch tests. */
export class FakeWakeSource implements WakeSignalSource {
  private readonly entries: SourceEntry[] = [];
  subscribeCount = 0;

  get activeSubscriptions(): number {
    return this.entries.filter(entry => entry.active).length;
  }

  subscribe(listener: (event: WakeSourceEvent) => void, context: WakeSourceContext): WakeSubscription {
    this.subscribeCount++;
    const entry: SourceEntry = {listener, active: !context.signal.aborted};
    this.entries.push(entry);
    context.signal.addEventListener('abort', () => { entry.active = false; }, {once: true});
    return {
      unsubscribe: () => { entry.active = false; },
    };
  }

  emit(event: WakeSourceEvent): void {
    for (const entry of this.entries) if (entry.active) entry.listener(event);
  }

  /** Simulates a broken source invoking a callback retained past unsubscribe. */
  emitLate(event: WakeSourceEvent): void {
    for (const entry of this.entries) entry.listener(event);
  }
}

export interface FakeWakeAuthorizationOptions {
  readonly expiresAtMs: number;
  readonly allowed?: boolean;
}

/** Host-permission Fake; it never grants beyond the configured expiry. */
export class FakeWakeAuthorization implements WakeAuthorizationPort {
  private allowed: boolean;
  private expiresAtMs: number;
  private revocation = new AbortController();
  checks = 0;

  constructor(options: FakeWakeAuthorizationOptions) {
    if (!Number.isSafeInteger(options.expiresAtMs) || options.expiresAtMs < 0) throw new Error('Invalid fake expiry');
    this.expiresAtMs = options.expiresAtMs;
    this.allowed = options.allowed ?? true;
  }

  setAllowed(allowed: boolean): void {
    this.allowed = allowed;
  }

  setExpiry(expiresAtMs: number): void {
    if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs < 0) throw new Error('Invalid fake expiry');
    this.expiresAtMs = expiresAtMs;
  }

  revoke(): void {
    this.revocation.abort();
  }

  restore(): void {
    this.revocation = new AbortController();
  }

  async check(input: WakeAuthorizationCheck): Promise<WakeAuthorizationDecision> {
    this.checks++;
    if (input.signal.aborted) throw new Error('cancelled');
    if (!this.allowed) return {kind: 'denied', reason: 'denied'};
    return {kind: 'allowed', expiresAtMs: this.expiresAtMs, revocationSignal: this.revocation.signal};
  }
}
