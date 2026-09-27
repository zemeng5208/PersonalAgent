import {VoiceSessionError} from './errors.js';
import {
  MAX_AUDIO_BYTES,
  MAX_AUDIO_DURATION_MS,
  VOICE_AUDIO_FORMAT,
  type VoiceAudioClip,
} from './ports.js';

const BYTES_PER_MILLISECOND = 32;
const MAX_TIMER_MS = 2_147_483_647;
const isoDeadline = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype) as object,
  'byteLength',
)?.get;

type BufferState = 'open' | 'finished' | 'disposed' | 'cancelled' | 'expired';

export interface VoicePcmBufferOptions {
  readonly signal: AbortSignal;
  readonly deadline: string;
  readonly maxDurationMs?: number;
}

export interface VoicePcmBuffer {
  append(chunk: Uint8Array): void;
  finish(): VoiceAudioClip;
  dispose(): void;
}

function invalid(message = 'Invalid voice PCM buffer input'): never {
  throw new VoiceSessionError('INVALID_ARGUMENT', message);
}

function isAbortSignal(value: unknown): value is AbortSignal {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
  try {
    const signal = value as AbortSignal;
    return typeof signal.aborted === 'boolean'
      && typeof signal.addEventListener === 'function'
      && typeof signal.removeEventListener === 'function';
  } catch {
    return false;
  }
}

function parseDeadline(value: unknown): number {
  if (typeof value !== 'string' || !isoDeadline.test(value)) invalid('Invalid voice PCM buffer deadline');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) invalid('Invalid voice PCM buffer deadline');
  const canonical = value.includes('.') ? value : value.replace('Z', '.000Z');
  if (new Date(parsed).toISOString() !== canonical) invalid('Invalid voice PCM buffer deadline');
  return parsed;
}

function chunkByteLength(value: unknown): number {
  if (typedArrayByteLength === undefined) invalid('Invalid voice PCM chunk');
  try {
    return typedArrayByteLength.call(value) as number;
  } catch {
    invalid('Invalid voice PCM chunk');
  }
}

class InMemoryVoicePcmBuffer implements VoicePcmBuffer {
  private readonly signal: AbortSignal;
  private readonly deadlineMs: number;
  private readonly maximumBytes: number;
  private storage: Uint8Array | undefined;
  private byteLength = 0;
  private state: BufferState = 'open';
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly onAbort = (): void => {
    this.close('cancelled');
  };

  constructor(signal: AbortSignal, deadlineMs: number, maximumBytes: number) {
    this.signal = signal;
    this.deadlineMs = deadlineMs;
    this.maximumBytes = maximumBytes;
    try {
      signal.addEventListener('abort', this.onAbort, {once: true});
    } catch {
      invalid();
    }
    if (signal.aborted) {
      this.close('cancelled');
      throw new VoiceSessionError('CANCELLED', 'Voice PCM buffer cancelled');
    }
    if (deadlineMs <= Date.now()) {
      this.close('expired');
      throw new VoiceSessionError('TIMEOUT', 'Voice PCM buffer deadline expired');
    }
    this.scheduleDeadline();
  }

  append(chunk: Uint8Array): void {
    this.assertOpen();
    const length = chunkByteLength(chunk);
    if (length === 0 || length % 2 !== 0) {
      invalid('Invalid voice PCM chunk');
    }
    if (length > this.maximumBytes - this.byteLength) {
      invalid('Voice PCM buffer capacity exceeded');
    }
    this.storage ??= new Uint8Array(this.maximumBytes);
    this.storage.set(chunk, this.byteLength);
    this.byteLength += length;
  }

  finish(): VoiceAudioClip {
    this.assertOpen();
    if (this.byteLength === 0) {
      throw new VoiceSessionError('INVALID_STATE', 'Voice PCM buffer is empty');
    }
    const data = new Uint8Array(this.byteLength);
    data.set(this.storage!.subarray(0, this.byteLength));
    const durationMs = Math.ceil(this.byteLength / BYTES_PER_MILLISECOND);
    this.close('finished');
    return Object.freeze({data, format: VOICE_AUDIO_FORMAT, durationMs});
  }

  dispose(): void {
    if (this.state !== 'open') return;
    this.close('disposed');
  }

  private assertOpen(): void {
    if (this.state === 'cancelled') throw new VoiceSessionError('CANCELLED', 'Voice PCM buffer cancelled');
    if (this.state === 'expired') throw new VoiceSessionError('TIMEOUT', 'Voice PCM buffer deadline expired');
    if (this.state !== 'open') throw new VoiceSessionError('INVALID_STATE', 'Voice PCM buffer is closed');
    if (this.signal.aborted) {
      this.close('cancelled');
      throw new VoiceSessionError('CANCELLED', 'Voice PCM buffer cancelled');
    }
    if (this.deadlineMs <= Date.now()) {
      this.close('expired');
      throw new VoiceSessionError('TIMEOUT', 'Voice PCM buffer deadline expired');
    }
  }

  private scheduleDeadline(): void {
    const remaining = this.deadlineMs - Date.now();
    if (remaining <= 0) {
      this.close('expired');
      return;
    }
    this.deadlineTimer = setTimeout(() => this.scheduleDeadline(), Math.min(remaining, MAX_TIMER_MS));
    this.deadlineTimer.unref?.();
  }

  private close(next: Exclude<BufferState, 'open'>): void {
    if (this.state !== 'open') return;
    this.state = next;
    if (this.deadlineTimer !== undefined) {
      clearTimeout(this.deadlineTimer);
      this.deadlineTimer = undefined;
    }
    try {
      this.signal.removeEventListener('abort', this.onAbort);
    } catch {
      // Best-effort detach after all retained audio has already been wiped.
    }
    this.storage?.fill(0);
    this.storage = undefined;
    this.byteLength = 0;
  }
}

export function createVoicePcmBuffer(options: VoicePcmBufferOptions): VoicePcmBuffer {
  if (!options || typeof options !== 'object' || Array.isArray(options)) invalid();
  let signal: unknown;
  let deadline: unknown;
  let maxDurationMs: unknown;
  try {
    ({signal, deadline, maxDurationMs} = options);
  } catch {
    invalid();
  }
  if (!isAbortSignal(signal)) invalid();
  const deadlineMs = parseDeadline(deadline);
  const duration = maxDurationMs ?? MAX_AUDIO_DURATION_MS;
  if (!Number.isSafeInteger(duration) || (duration as number) <= 0 || (duration as number) > MAX_AUDIO_DURATION_MS) {
    invalid('Invalid voice PCM buffer duration');
  }
  const maximumBytes = Math.min(MAX_AUDIO_BYTES, (duration as number) * BYTES_PER_MILLISECOND);
  return new InMemoryVoicePcmBuffer(signal, deadlineMs, maximumBytes);
}
