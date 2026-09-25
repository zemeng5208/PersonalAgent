import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {existsSync, statSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {VoiceSessionError} from './errors.js';
import {
  MAX_FRAME_BYTES,
  MAX_QUEUE_BYTES,
  MAX_QUEUE_FRAMES,
  VOICE_AUDIO_FORMAT,
  type SpeechKeywordCloseReason,
  type SpeechKeywordCloseResult,
  type SpeechKeywordDetectorPort,
  type SpeechKeywordSession,
  type SpeechKeywordStartOptions,
  type VoicePcmFrame,
  type WindowsSystemSpeechKeywordDetectorOptions,
} from './ports.js';

const MAX_KEYWORD_CHARACTERS = 32;
const MAX_TIMER_MS = 2_147_483_647;
const MAX_HOST_ERROR_BYTES = 8_192;
const MAX_LINE_BUFFER_BYTES = 16_384;
const isoDeadline = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function invalid(message = 'Invalid Windows speech keyword input'): never {
  throw new VoiceSessionError('INVALID_ARGUMENT', message);
}

function fixedFailure(): VoiceSessionError {
  return new VoiceSessionError('EXTERNAL_FAILURE', 'Windows speech operation failed');
}

function fixedUnavailable(): VoiceSessionError {
  return new VoiceSessionError('UNSUPPORTED_CAPABILITY', 'Windows System.Speech is unavailable');
}

function fixedCancelled(): VoiceSessionError {
  return new VoiceSessionError('CANCELLED', 'Windows speech operation cancelled');
}

function fixedTimeout(): VoiceSessionError {
  return new VoiceSessionError('TIMEOUT', 'Windows speech operation deadline expired');
}

function exactDataRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid();
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length
      || ownKeys.some(key => typeof key !== 'string' || !keys.includes(key))) invalid();
    const captured: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid();
      captured[key] = descriptor.value;
    }
    return captured;
  } catch (error) {
    if (error instanceof VoiceSessionError) throw error;
    return invalid();
  }
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
  if (typeof value !== 'string' || !isoDeadline.test(value)) invalid('Invalid Windows speech deadline');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) invalid('Invalid Windows speech deadline');
  const canonical = value.includes('.') ? value : value.replace('Z', '.000Z');
  if (new Date(parsed).toISOString() !== canonical) invalid('Invalid Windows speech deadline');
  return parsed;
}

function validateKeyword(value: unknown): string {
  if (typeof value !== 'string') invalid('Invalid Windows speech keyword');
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_KEYWORD_CHARACTERS || trimmed !== value) {
    invalid('Invalid Windows speech keyword');
  }
  // Control-free zh-CN phrase: no ASCII control characters (\x00-\x1F, \x7F)
  // No XML/CLI injection characters (<, >, &, ", ', `, \, ;, |, \r, \n, \t, \0)
  if (/[\x00-\x1F\x7F<>&"'`\\;\r\n\t\0|]/.test(value)) {
    invalid('Invalid Windows speech keyword');
  }
  return value;
}

export interface SpeechHostProcess {
  readonly stdin: ChildProcessWithoutNullStreams['stdin'];
  readonly stdout: ChildProcessWithoutNullStreams['stdout'];
  readonly stderr: ChildProcessWithoutNullStreams['stderr'];
  once(event: 'error', listener: (error: Error) => void): this;
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type WindowsSpeechKeywordHostSpawner = () => SpeechHostProcess;

function isHostCurrent(executable: string, source: string): boolean {
  try {
    if (!existsSync(executable) || !existsSync(source)) return false;
    const exeStat = statSync(executable);
    if (!exeStat.isFile() || exeStat.size === 0) return false;
    const srcStat = statSync(source);
    if (srcStat.mtimeMs > exeStat.mtimeMs) return false;
    return true;
  } catch {
    return false;
  }
}

function createFixedKeywordHostSpawner(keyword: string): WindowsSpeechKeywordHostSpawner {
  if (process.platform !== 'win32') return () => { throw fixedUnavailable(); };
  const root = process.env.SystemRoot;
  if (typeof root !== 'string' || !path.win32.isAbsolute(root) || root.includes('\0')) {
    return () => { throw fixedUnavailable(); };
  }
  const systemRoot = path.win32.resolve(root);
  const executable = fileURLToPath(new URL('../host/windows-system-speech-host.exe', import.meta.url));
  const source = fileURLToPath(new URL('../host/WindowsSystemSpeechHost.cs', import.meta.url));
  if (!isHostCurrent(executable, source)) return () => { throw fixedUnavailable(); };
  const environment: NodeJS.ProcessEnv = {SystemRoot: systemRoot, WINDIR: systemRoot};
  for (const key of ['TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return () => {
    if (!isHostCurrent(executable, source)) throw fixedUnavailable();
    return spawn(executable, [
      '--mode', 'keyword',
      '--keyword', keyword,
    ], {
      shell: false,
      windowsHide: true,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  };
}

class KeywordSessionImpl implements SpeechKeywordSession {
  private settled = false;
  private isReady = false;
  private readySettled = false;
  private terminalReason: SpeechKeywordCloseReason | undefined;
  private detections = 0;
  private expectedSequence = 0;
  private queuedBytes = 0;
  private readonly queue: Uint8Array[] = [];
  private isPumping = false;
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  private child: SpeechHostProcess | undefined;

  private resolveReady!: () => void;
  private rejectReady!: (error: VoiceSessionError) => void;
  readonly ready: Promise<void>;

  private resolveClosed!: (result: SpeechKeywordCloseResult) => void;
  readonly closed: Promise<SpeechKeywordCloseResult>;

  private stopPromise: Promise<void> | undefined;

  constructor(
    private readonly options: SpeechKeywordStartOptions,
    private readonly deadlineMs: number,
    private readonly spawnHost: WindowsSpeechKeywordHostSpawner,
    private readonly onSessionClosed: () => void,
  ) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.ready.catch(() => {});

    this.closed = new Promise<SpeechKeywordCloseResult>(resolve => {
      this.resolveClosed = resolve;
    });

    if (this.options.signal.aborted) {
      this.terminateImmediately('cancelled', fixedCancelled());
      return;
    }

    if (this.deadlineMs <= Date.now()) {
      this.terminateImmediately('deadline', fixedTimeout());
      return;
    }

    this.initProcess();
  }

  private terminateImmediately(reason: SpeechKeywordCloseReason, readyError: VoiceSessionError): void {
    this.settled = true;
    this.terminalReason = reason;
    this.readySettled = true;
    this.rejectReady(readyError);
    this.resolveClosed(Object.freeze({reason, detections: 0}));
    this.onSessionClosed();
  }

  private initProcess(): void {
    try {
      this.child = this.spawnHost();
    } catch (error) {
      const sessionError = error instanceof VoiceSessionError ? error : fixedFailure();
      const reason = sessionError.code === 'UNSUPPORTED_CAPABILITY' ? 'unavailable' : 'external_failure';
      this.terminateImmediately(reason, sessionError);
      return;
    }

    const child = this.child;

    const onParentAbort = (): void => {
      this.terminate('cancelled');
    };

    try {
      this.options.signal.addEventListener('abort', onParentAbort, {once: true});
    } catch {
      this.terminate('external_failure');
      return;
    }

    const scheduleDeadline = (): void => {
      const remaining = this.deadlineMs - Date.now();
      if (remaining <= 0) {
        this.terminate('deadline');
        return;
      }
      this.deadlineTimer = setTimeout(scheduleDeadline, Math.min(remaining, MAX_TIMER_MS));
      this.deadlineTimer.unref?.();
    };
    scheduleDeadline();

    let lineBuffer = '';
    let stderrBytes = 0;

    child.stdout.on('data', chunk => {
      if (this.settled) return;
      const str = (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)).toString('utf8');
      lineBuffer += str;
      if (lineBuffer.length > MAX_LINE_BUFFER_BYTES) {
        this.terminate('external_failure');
        return;
      }
      let newlineIndex: number;
      while ((newlineIndex = lineBuffer.indexOf('\n')) !== -1) {
        const rawLine = lineBuffer.slice(0, newlineIndex).trim();
        lineBuffer = lineBuffer.slice(newlineIndex + 1);
        if (rawLine.length === 0) continue;
        this.handleChildLine(rawLine);
      }
    });

    child.stderr.on('data', chunk => {
      if (this.settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrBytes += bytes.byteLength;
      if (stderrBytes > MAX_HOST_ERROR_BYTES) {
        this.terminate('external_failure');
      }
    });

    child.once('error', () => {
      this.terminate('external_failure');
    });

    child.once('close', code => {
      if (this.settled) return;
      this.settled = true;
      this.cleanup(onParentAbort);

      if (this.terminalReason === undefined) {
        if (code === 2) {
          this.terminalReason = 'unavailable';
          if (!this.readySettled) {
            this.readySettled = true;
            this.rejectReady(fixedUnavailable());
          }
        } else if (code === 0 && this.isReady) {
          this.terminalReason = 'stopped';
        } else {
          this.terminalReason = 'external_failure';
          if (!this.readySettled) {
            this.readySettled = true;
            this.rejectReady(fixedFailure());
          }
        }
      }

      this.onSessionClosed();
      this.resolveClosed(Object.freeze({
        reason: this.terminalReason,
        detections: this.detections,
      }));
    });
  }

  private handleChildLine(line: string): void {
    if (this.settled) return;
    try {
      const envelope = JSON.parse(line) as unknown;
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
        this.terminate('external_failure');
        return;
      }
      const record = envelope as Record<string, unknown>;
      if (record.ok === false) {
        if (record.code === 'UNSUPPORTED_CAPABILITY') {
          this.terminate('unavailable');
        } else {
          this.terminate('external_failure');
        }
        return;
      }
      if (record.event === 'ready') {
        if (!this.isReady && !this.readySettled) {
          this.isReady = true;
          this.readySettled = true;
          this.resolveReady();
          this.pumpQueue();
        } else {
          this.terminate('external_failure');
        }
        return;
      }
      if (record.event === 'detected') {
        if (!this.isReady) {
          this.terminate('external_failure');
          return;
        }
        if (this.terminalReason === undefined && !this.settled) {
          this.detections += 1;
          try {
            this.options.onDetected();
          } catch {
            // Callback errors contained; never log or propagate raw speech
          }
        }
        return;
      }
      this.terminate('external_failure');
    } catch {
      this.terminate('external_failure');
    }
  }

  terminate(reason: SpeechKeywordCloseReason): void {
    if (this.terminalReason !== undefined) return;
    this.terminalReason = reason;

    if (!this.readySettled) {
      this.readySettled = true;
      if (reason === 'unavailable') {
        this.rejectReady(fixedUnavailable());
      } else if (reason === 'cancelled') {
        this.rejectReady(fixedCancelled());
      } else if (reason === 'deadline') {
        this.rejectReady(fixedTimeout());
      } else {
        this.rejectReady(fixedFailure());
      }
    }

    for (const chunk of this.queue) {
      chunk.fill(0);
    }
    this.queue.length = 0;
    this.queuedBytes = 0;

    if (this.child !== undefined) {
      try {
        this.child.kill();
      } catch {
        // Best-effort kill
      }
    }
  }

  private cleanup(onParentAbort: () => void): void {
    if (this.deadlineTimer !== undefined) {
      clearTimeout(this.deadlineTimer);
      this.deadlineTimer = undefined;
    }
    try {
      this.options.signal.removeEventListener('abort', onParentAbort);
    } catch {
      // Best-effort detach
    }
    for (const chunk of this.queue) {
      chunk.fill(0);
    }
    this.queue.length = 0;
    this.queuedBytes = 0;
  }

  accept(frame: VoicePcmFrame): void {
    if (!frame || typeof frame !== 'object') {
      invalid('Invalid voice PCM frame');
    }

    const format = frame.format;
    if (!format || typeof format !== 'object'
      || format.encoding !== VOICE_AUDIO_FORMAT.encoding
      || format.sampleRateHz !== VOICE_AUDIO_FORMAT.sampleRateHz
      || format.channels !== VOICE_AUDIO_FORMAT.channels) {
      invalid('Unsupported voice audio format');
    }

    if (typeof frame.sequence !== 'number'
      || !Number.isSafeInteger(frame.sequence)
      || frame.sequence !== this.expectedSequence) {
      invalid('Invalid voice PCM frame sequence');
    }

    const data = frame.data;
    if (!(data instanceof Uint8Array)) {
      invalid('Invalid voice PCM frame data');
    }
    const length = data.byteLength;
    if (length === 0 || (length % 2) !== 0 || length > MAX_FRAME_BYTES) {
      invalid('Invalid voice PCM frame data');
    }

    if (this.terminalReason !== undefined || this.settled) {
      return;
    }

    if (this.queue.length >= MAX_QUEUE_FRAMES || this.queuedBytes + length > MAX_QUEUE_BYTES) {
      this.terminate('overflow');
      return;
    }

    this.expectedSequence += 1;

    const copy = new Uint8Array(length);
    copy.set(data);
    this.queue.push(copy);
    this.queuedBytes += length;

    this.pumpQueue();
  }

  private pumpQueue(): void {
    if (this.isPumping || this.terminalReason !== undefined || this.settled) return;
    if (!this.isReady || this.child === undefined) return;
    this.isPumping = true;
    try {
      while (this.queue.length > 0 && this.terminalReason === undefined && !this.settled) {
        const chunk = this.queue.shift()!;
        this.queuedBytes -= chunk.byteLength;
        try {
          const packet = Buffer.allocUnsafe(4 + chunk.byteLength);
          packet[0] = 1; // PCM frame
          packet[1] = 0; // reserved
          packet.writeUInt16LE(chunk.byteLength, 2);
          packet.set(chunk, 4);
          this.child.stdin.write(packet);
        } catch {
          this.terminate('external_failure');
          break;
        } finally {
          chunk.fill(0);
        }
      }
    } finally {
      this.isPumping = false;
    }
  }

  stop(): Promise<void> {
    if (this.stopPromise !== undefined) return this.stopPromise;
    this.terminate('stopped');
    this.stopPromise = (async () => {
      await this.closed;
    })();
    return this.stopPromise;
  }
}

class WindowsSystemSpeechKeywordDetector implements SpeechKeywordDetectorPort {
  private disposed = false;
  private readonly activeSessions = new Set<KeywordSessionImpl>();
  private disposePromise: Promise<void> | undefined;

  constructor(private readonly spawnHost: WindowsSpeechKeywordHostSpawner) {}

  start(options: SpeechKeywordStartOptions): SpeechKeywordSession {
    if (this.disposed) {
      throw new VoiceSessionError('INVALID_STATE', 'Windows speech keyword detector is disposed');
    }
    const record = exactDataRecord(options, ['signal', 'deadline', 'onDetected']);
    if (!isAbortSignal(record.signal)) {
      invalid('Invalid voice keyword session signal');
    }
    if (typeof record.onDetected !== 'function') {
      invalid('Invalid voice keyword session onDetected callback');
    }
    const deadlineMs = parseDeadline(record.deadline);

    const session = new KeywordSessionImpl(
      {
        signal: record.signal,
        deadline: record.deadline as string,
        onDetected: record.onDetected as () => void,
      },
      deadlineMs,
      this.spawnHost,
      () => {
        this.activeSessions.delete(session);
      },
    );

    this.activeSessions.add(session);
    return session;
  }

  dispose(): Promise<void> {
    if (this.disposePromise !== undefined) return this.disposePromise;
    this.disposed = true;
    this.disposePromise = (async () => {
      const running = Array.from(this.activeSessions);
      for (const session of running) {
        session.terminate('disposed');
      }
      await Promise.all(running.map(session => session.closed));
    })();
    return this.disposePromise;
  }
}

export function createWindowsSystemSpeechKeywordDetector(
  options: WindowsSystemSpeechKeywordDetectorOptions,
): SpeechKeywordDetectorPort {
  const record = exactDataRecord(options, ['keyword']);
  const keyword = validateKeyword(record.keyword);
  const spawner = createFixedKeywordHostSpawner(keyword);
  return new WindowsSystemSpeechKeywordDetector(spawner);
}

/** Internal deterministic test seam; not exported from the package entrypoint. */
export function createWindowsSystemSpeechKeywordDetectorForTesting(
  options: WindowsSystemSpeechKeywordDetectorOptions,
  spawner: WindowsSpeechKeywordHostSpawner,
): SpeechKeywordDetectorPort {
  const record = exactDataRecord(options, ['keyword']);
  const keyword = validateKeyword(record.keyword);
  if (typeof spawner !== 'function') {
    throw new VoiceSessionError('INVALID_ARGUMENT', 'Invalid speech host spawner');
  }
  return new WindowsSystemSpeechKeywordDetector(spawner);
}
