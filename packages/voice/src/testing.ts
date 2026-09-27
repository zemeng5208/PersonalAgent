import {VoiceSessionError} from './errors.js';
import {
  MAX_FRAME_BYTES,
  MAX_QUEUE_BYTES,
  MAX_QUEUE_FRAMES,
  type SpeechKeywordCloseReason,
  type SpeechKeywordCloseResult,
  type SpeechKeywordDetectorPort,
  type SpeechKeywordSession,
  type SpeechKeywordStartOptions,
  type SpeechOutputPort,
  type SpeechOutputRequest,
  type SpeechRecognitionPort,
  type SpeechRecognitionRequest,
  type SpeechRecognitionResult,
  type TranscriptConsumerPort,
  type TranscriptConsumptionRequest,
  type TranscriptConsumptionResult,
  type VoiceOperation,
  type VoiceOperationStopReason,
  type VoicePcmCaptureBinding,
  type VoicePcmCaptureSink,
  type VoicePcmCaptureSubscription,
  type VoicePcmFrame,
} from './ports.js';

export interface FakeVoiceCall {
  readonly sessionId: string;
  readonly deadline: string;
  readonly locale: string;
  readonly signal: AbortSignal;
  readonly characterCount?: number;
  readonly byteLength?: number;
  readonly durationMs?: number;
}

class FakeOperation<T> implements VoiceOperation<T> {
  readonly result: Promise<T>;
  private released = false;

  constructor(
    result: Promise<T>,
    private readonly release: (reason: VoiceOperationStopReason) => void,
  ) {
    this.result = result;
  }

  async stop(reason: VoiceOperationStopReason): Promise<void> {
    if (this.released) return;
    this.released = true;
    this.release(reason);
  }
}

abstract class FakePortBase {
  readonly calls: FakeVoiceCall[] = [];
  readonly stopReasons: VoiceOperationStopReason[] = [];
  activeOperations = 0;
  releasedOperations = 0;

  protected operation<T>(call: FakeVoiceCall, result: Promise<T>): VoiceOperation<T> {
    this.calls.push(Object.freeze(call));
    this.activeOperations += 1;
    return new FakeOperation(result, reason => {
      this.stopReasons.push(reason);
      this.activeOperations -= 1;
      this.releasedOperations += 1;
    });
  }
}

/** Synthetic adapter. It retains metadata only, never audio bytes or text. */
export class FakeSpeechRecognitionPort extends FakePortBase implements SpeechRecognitionPort {
  constructor(
    private readonly responder: (request: SpeechRecognitionRequest) => SpeechRecognitionResult | Promise<SpeechRecognitionResult>,
  ) {
    super();
  }

  recognize(request: SpeechRecognitionRequest): VoiceOperation<SpeechRecognitionResult> {
    const result = Promise.resolve().then(() => this.responder(request));
    return this.operation({
      sessionId: request.sessionId,
      deadline: request.deadline,
      locale: request.locale,
      signal: request.signal,
      byteLength: request.audio.byteLength,
      durationMs: request.durationMs,
    }, result);
  }
}

/** Synthetic explicit consumer. It retains only transcript character counts. */
export class FakeTranscriptConsumerPort extends FakePortBase implements TranscriptConsumerPort {
  constructor(
    private readonly responder: (
      request: TranscriptConsumptionRequest,
    ) => TranscriptConsumptionResult | Promise<TranscriptConsumptionResult>,
  ) {
    super();
  }

  consume(request: TranscriptConsumptionRequest): VoiceOperation<TranscriptConsumptionResult> {
    const result = Promise.resolve().then(() => this.responder(request));
    return this.operation({
      sessionId: request.sessionId,
      deadline: request.deadline,
      locale: request.locale,
      signal: request.signal,
      characterCount: request.text.length,
    }, result);
  }
}

/** Synthetic speaker. It retains only reply character counts. */
export class FakeSpeechOutputPort extends FakePortBase implements SpeechOutputPort {
  constructor(private readonly responder: (request: SpeechOutputRequest) => void | Promise<void> = () => {}) {
    super();
  }

  speak(request: SpeechOutputRequest): VoiceOperation<void> {
    const result = Promise.resolve().then(() => this.responder(request));
    return this.operation({
      sessionId: request.sessionId,
      deadline: request.deadline,
      locale: request.locale,
      signal: request.signal,
      characterCount: request.text.length,
    }, result);
  }
}

export interface FakeVoicePcmCaptureBindingOptions {
  readonly releaseDelayMs?: number;
}

/** Synthetic capture binding. Simulates authorized host audio hardware. */
export class FakeVoicePcmCaptureBinding implements VoicePcmCaptureBinding {
  readonly sinks = new Set<VoicePcmCaptureSink>();
  startCount = 0;
  releaseCount = 0;
  activeSubscriptions = 0;

  constructor(private readonly options: FakeVoicePcmCaptureBindingOptions = {}) {}

  start(sink: VoicePcmCaptureSink): VoicePcmCaptureSubscription {
    this.startCount += 1;
    this.activeSubscriptions += 1;
    this.sinks.add(sink);

    return {
      release: async (): Promise<void> => {
        if (!this.sinks.has(sink)) return;
        this.sinks.delete(sink);
        this.activeSubscriptions -= 1;
        this.releaseCount += 1;
        if (this.options.releaseDelayMs && this.options.releaseDelayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, this.options.releaseDelayMs));
        }
      },
    };
  }

  emitFrame(data: Uint8Array): void {
    for (const sink of this.sinks) {
      sink.onFrame(data);
    }
  }

  emitRevoked(): void {
    for (const sink of this.sinks) {
      sink.onRevoked?.();
    }
  }

  emitDeviceUnavailable(): void {
    for (const sink of this.sinks) {
      sink.onDeviceUnavailable?.();
    }
  }
}

export interface FakeSpeechKeywordSessionOptions {
  readonly readyDelayMs?: number;
  readonly simulateUnsupported?: boolean;
}

export class FakeSpeechKeywordSession implements SpeechKeywordSession {
  private settled = false;
  private terminalReason: SpeechKeywordCloseReason | undefined;
  private detections = 0;
  private expectedSequence = 0;
  private queuedBytes = 0;
  private readonly queue: Uint8Array[] = [];
  private resolveReady!: () => void;
  private rejectReady!: (error: VoiceSessionError) => void;
  readonly ready: Promise<void>;
  private resolveClosed!: (result: SpeechKeywordCloseResult) => void;
  readonly closed: Promise<SpeechKeywordCloseResult>;

  constructor(
    private readonly options: SpeechKeywordStartOptions,
    sessionOptions: FakeSpeechKeywordSessionOptions = {},
  ) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.ready.catch(() => {});
    this.closed = new Promise<SpeechKeywordCloseResult>(resolve => {
      this.resolveClosed = resolve;
    });

    if (options.signal.aborted) {
      this.close('cancelled', new VoiceSessionError('CANCELLED', 'Voice keyword session cancelled'));
      return;
    }

    if (sessionOptions.simulateUnsupported) {
      this.close('unavailable', new VoiceSessionError('UNSUPPORTED_CAPABILITY', 'Windows System.Speech is unavailable'));
      return;
    }

    if (sessionOptions.readyDelayMs && sessionOptions.readyDelayMs > 0) {
      setTimeout(() => {
        if (!this.settled) this.resolveReady();
      }, sessionOptions.readyDelayMs);
    } else {
      queueMicrotask(() => {
        if (!this.settled) this.resolveReady();
      });
    }

    try {
      options.signal.addEventListener('abort', () => {
        this.close('cancelled', new VoiceSessionError('CANCELLED', 'Voice keyword session cancelled'));
      }, {once: true});
    } catch {
      // Best-effort
    }
  }

  accept(frame: VoicePcmFrame): void {
    if (!frame || typeof frame !== 'object') {
      throw new VoiceSessionError('INVALID_ARGUMENT', 'Invalid voice PCM frame');
    }
    if (frame.sequence !== this.expectedSequence) {
      throw new VoiceSessionError('INVALID_ARGUMENT', 'Invalid voice PCM frame sequence');
    }
    const length = frame.data?.byteLength ?? 0;
    if (length === 0 || length % 2 !== 0 || length > MAX_FRAME_BYTES) {
      throw new VoiceSessionError('INVALID_ARGUMENT', 'Invalid voice PCM frame data');
    }
    if (this.queue.length >= MAX_QUEUE_FRAMES || this.queuedBytes + length > MAX_QUEUE_BYTES) {
      this.close('overflow');
      return;
    }
    this.expectedSequence += 1;
    const copy = new Uint8Array(length);
    copy.set(frame.data);
    this.queue.push(copy);
    this.queuedBytes += length;
  }

  emitDetected(): void {
    if (this.settled) return;
    this.detections += 1;
    try {
      this.options.onDetected();
    } catch {
      // Callback errors contained
    }
  }

  private stopPromise: Promise<void> | undefined;

  stop(): Promise<void> {
    if (this.stopPromise !== undefined) return this.stopPromise;
    this.close('stopped');
    this.stopPromise = (async () => {
      await this.closed;
    })();
    return this.stopPromise;
  }

  private close(reason: SpeechKeywordCloseReason, readyError?: VoiceSessionError): void {
    if (this.settled) return;
    this.settled = true;
    this.terminalReason = reason;
    if (readyError) this.rejectReady(readyError);
    for (const chunk of this.queue) chunk.fill(0);
    this.queue.length = 0;
    this.resolveClosed(Object.freeze({reason, detections: this.detections}));
  }
}

export class FakeSpeechKeywordDetectorPort implements SpeechKeywordDetectorPort {
  readonly sessions: FakeSpeechKeywordSession[] = [];
  disposed = false;
  private disposePromise: Promise<void> | undefined;

  constructor(private readonly sessionOptions: FakeSpeechKeywordSessionOptions = {}) {}

  start(options: SpeechKeywordStartOptions): SpeechKeywordSession {
    if (this.disposed) {
      throw new VoiceSessionError('INVALID_STATE', 'Fake speech keyword detector is disposed');
    }
    const session = new FakeSpeechKeywordSession(options, this.sessionOptions);
    this.sessions.push(session);
    return session;
  }

  dispose(): Promise<void> {
    if (this.disposePromise !== undefined) return this.disposePromise;
    this.disposed = true;
    this.disposePromise = (async () => {
      await Promise.all(this.sessions.map(s => s.stop()));
    })();
    return this.disposePromise;
  }
}
