export const VOICE_AUDIO_FORMAT = Object.freeze({
  encoding: 'pcm_s16le' as const,
  sampleRateHz: 16_000 as const,
  channels: 1 as const,
});

export const MAX_AUDIO_BYTES = 1_920_000;
export const MAX_AUDIO_DURATION_MS = 60_000;
export const MAX_TRANSCRIPT_CHARACTERS = 8_000;
export const MAX_SPEECH_CHARACTERS = 8_000;

export interface VoiceAudioFormat {
  readonly encoding: 'pcm_s16le';
  readonly sampleRateHz: 16_000;
  readonly channels: 1;
}

/** Caller-supplied push-to-talk audio. The voice package never opens a microphone. */
export interface VoiceAudioClip {
  readonly data: Uint8Array;
  readonly format: VoiceAudioFormat;
  readonly durationMs: number;
}

export type VoiceOperationStopReason =
  | 'completed'
  | 'user'
  | 'interrupted'
  | 'cancelled'
  | 'deadline'
  | 'replaced'
  | 'disposed';

/**
 * A provider operation must make stop idempotent and release operation-scoped resources.
 * The session also aborts request.signal before calling stop.
 */
export interface VoiceOperation<T> {
  readonly result: Promise<T>;
  stop(reason: VoiceOperationStopReason): Promise<void>;
}

export interface SpeechRecognitionRequest {
  readonly sessionId: string;
  readonly audio: Uint8Array;
  readonly format: VoiceAudioFormat;
  readonly durationMs: number;
  readonly locale: string;
  readonly deadline: string;
  readonly signal: AbortSignal;
}

export interface SpeechRecognitionResult {
  readonly text: string;
  readonly locale?: string;
}

/** Provider credentials, transport and any upload consent stay in the trusted adapter. */
export interface SpeechRecognitionPort {
  recognize(request: SpeechRecognitionRequest): VoiceOperation<SpeechRecognitionResult>;
}

export interface TranscriptConsumptionRequest {
  readonly sessionId: string;
  readonly transcriptId: string;
  readonly text: string;
  readonly locale: string;
  readonly deadline: string;
  readonly signal: AbortSignal;
}

export interface TranscriptConsumptionResult {
  readonly replyText: string;
  readonly locale?: string;
}

/**
 * Supplied only to the explicit consumeTranscript call. Its stop method cancels the local
 * wait; it must not translate voice interruption into task.cancel.
 */
export interface TranscriptConsumerPort {
  consume(request: TranscriptConsumptionRequest): VoiceOperation<TranscriptConsumptionResult>;
}

export interface SpeechOutputRequest {
  readonly sessionId: string;
  readonly replyId: string;
  readonly text: string;
  readonly locale: string;
  readonly deadline: string;
  readonly signal: AbortSignal;
}

/** Output adapters synthesize/play only after speakReply is called explicitly. */
export interface SpeechOutputPort {
  speak(request: SpeechOutputRequest): VoiceOperation<void>;
}
