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
