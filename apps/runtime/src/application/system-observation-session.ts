import {randomUUID} from 'node:crypto';
import {ProtocolError} from '@personal-agent/contracts';

export const SYSTEM_OBSERVATION_SESSION_CHECKPOINT = 'system-observation-session';
export const SYSTEM_OBSERVATION_NAME = 'computer.system.observe';
export const SYSTEM_OBSERVATION_VERSION = '1.0.0';
export const SYSTEM_OBSERVATION_SCOPE = 'computer:system:read';

export interface StartSystemObservationSessionRequest {
  expiresAt: string;
  intervalMs: number;
}
export interface SystemObservationSession {
  sessionId: string;
  expiresAt: string;
  intervalMs: number;
}
interface Lease extends SystemObservationSession {
  lastSampleAt?: number;
  taskId?: string;
  sampleTaskIds: Set<string>;
  sequence: number;
}

/** Process-local explicit consent. Persisted sample checkpoints cannot recreate it. */
export class SystemObservationSessions {
  private readonly leases = new Map<string, Lease>();
  constructor(private readonly now: () => number, private readonly cancel: (taskId: string) => void) {}

  start(request: StartSystemObservationSessionRequest): SystemObservationSession {
    const expires = Date.parse(request?.expiresAt);
    if (!request || Object.keys(request).some(key => !['expiresAt', 'intervalMs'].includes(key))
      || typeof request.expiresAt !== 'string' || !Number.isFinite(expires)
      || new Date(expires).toISOString() !== request.expiresAt || expires <= this.now()
      || !Number.isSafeInteger(request.intervalMs) || request.intervalMs < 1000
      || request.intervalMs > expires - this.now()) {
      throw new ProtocolError('INVALID_ARGUMENT', 'Observation consent requires a future expiry and interval of at least 1000 ms');
    }
    // One observation lease per trusted host; enabling again cannot silently
    // refresh an existing consent deadline or leave an old sampler running.
    for (const lease of this.leases.values()) {
      if (Date.parse(lease.expiresAt) <= this.now()) this.stop(lease.sessionId);
      else throw new ProtocolError('REVISION_CONFLICT', 'Observation session is already active');
    }
    const lease: Lease = {sessionId: randomUUID(), expiresAt: request.expiresAt,
      intervalMs: request.intervalMs, sampleTaskIds: new Set(), sequence: 0};
    this.leases.set(lease.sessionId, lease);
    return {sessionId: lease.sessionId, expiresAt: lease.expiresAt, intervalMs: lease.intervalMs};
  }

  require(sessionId: string): Lease {
    const lease = this.leases.get(sessionId);
    if (!lease) throw new ProtocolError('UNAUTHORIZED', 'Observation session is absent or revoked');
    if (this.now() >= Date.parse(lease.expiresAt)) {
      this.stop(sessionId);
      throw new ProtocolError('TIMEOUT', 'Observation session expired');
    }
    return lease;
  }

  next(sessionId: string, unfinished: (taskId: string) => boolean):
    {state: 'busy' | 'not_due'; taskId?: string} | {state: 'ready'; commandId: string; deadline: string} {
    const lease = this.require(sessionId);
    if (lease.taskId && unfinished(lease.taskId)) return {state: 'busy', taskId: lease.taskId};
    if (lease.lastSampleAt !== undefined && this.now() - lease.lastSampleAt < lease.intervalMs) return {state: 'not_due'};
    lease.lastSampleAt = this.now();
    lease.sequence++;
    return {state: 'ready', commandId: `observation:${sessionId}:${lease.sequence}`,
      deadline: new Date(Math.min(Date.parse(lease.expiresAt), this.now() + 30_000)).toISOString()};
  }

  bind(sessionId: string, taskId: string): void {
    const lease = this.require(sessionId);
    lease.taskId = taskId;
    lease.sampleTaskIds.add(taskId);
  }
  assertSample(sessionId: string, taskId: string): void {
    if (this.require(sessionId).taskId !== taskId) throw new ProtocolError('UNAUTHORIZED', 'Observation sample is not bound to this session');
  }
  sampleIntervalMs(sessionId: string, taskId: string): number {
    const lease = this.require(sessionId);
    if (!lease.sampleTaskIds.has(taskId)) throw new ProtocolError('UNAUTHORIZED', 'Observation sample is not bound to this session');
    return lease.intervalMs;
  }
  stop(sessionId: string): {stopped: boolean} {
    const lease = this.leases.get(sessionId);
    if (!lease) return {stopped: false};
    this.leases.delete(sessionId);
    if (lease.taskId) this.cancel(lease.taskId);
    return {stopped: true};
  }
  stopAll(): void { for (const id of [...this.leases.keys()]) this.stop(id); }
}
