import {VoiceSessionError} from './errors.js';
import type {
  SpeechOutputPort,
  SpeechOutputRequest,
  SpeechRecognitionPort,
  SpeechRecognitionRequest,
  SpeechRecognitionResult,
  SpeechKeywordDetectorPort,
  SpeechKeywordSession,
  SpeechKeywordStartOptions,
  TranscriptConsumerPort,
  TranscriptConsumptionRequest,
  TranscriptConsumptionResult,
  VoiceOperation,
  VoicePcmFrame,
} from './ports.js';

function unavailableOperation<T>(message: string): VoiceOperation<T> {
  const error = new VoiceSessionError('UNSUPPORTED_CAPABILITY', message);
  return {
    result: Promise.reject(error),
    async stop(): Promise<void> {},
  };
}

/** Explicit default: no recognizer is selected or contacted. */
export class UnavailableSpeechRecognitionPort implements SpeechRecognitionPort {
  recognize(_request: SpeechRecognitionRequest): VoiceOperation<SpeechRecognitionResult> {
    return unavailableOperation('Speech recognition is unavailable');
  }
}

/** Explicit default: no synthesizer/player is selected or contacted. */
export class UnavailableSpeechOutputPort implements SpeechOutputPort {
  speak(_request: SpeechOutputRequest): VoiceOperation<void> {
    return unavailableOperation('Speech output is unavailable');
  }
}

/** Useful for a caller that has not wired the explicit transcript consumer yet. */
export class UnavailableTranscriptConsumerPort implements TranscriptConsumerPort {
  consume(_request: TranscriptConsumptionRequest): VoiceOperation<TranscriptConsumptionResult> {
    return unavailableOperation('Transcript consumption is unavailable');
  }
}

/** Explicit default: keyword detector is not selected or configured. */
export class UnavailableSpeechKeywordDetectorPort implements SpeechKeywordDetectorPort {
  start(_options: SpeechKeywordStartOptions): SpeechKeywordSession {
    const error = new VoiceSessionError('UNSUPPORTED_CAPABILITY', 'Speech keyword detection is unavailable');
    const ready = Promise.reject(error);
    ready.catch(() => {});
    return {
      accept(_frame: VoicePcmFrame): void {},
      ready,
      closed: Promise.resolve(Object.freeze({reason: 'unavailable', detections: 0})),
      async stop(): Promise<void> {},
    };
  }

  async dispose(): Promise<void> {}
}
