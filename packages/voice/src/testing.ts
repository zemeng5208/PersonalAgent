import type {
  SpeechOutputPort,
  SpeechOutputRequest,
  SpeechRecognitionPort,
  SpeechRecognitionRequest,
  SpeechRecognitionResult,
  TranscriptConsumerPort,
  TranscriptConsumptionRequest,
  TranscriptConsumptionResult,
  VoiceOperation,
  VoiceOperationStopReason,
  VoicePcmCaptureBinding,
  VoicePcmCaptureSink,
  VoicePcmCaptureSubscription,
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
