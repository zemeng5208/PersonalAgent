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

export const MAX_FRAME_BYTES = 3_200;
export const MAX_QUEUE_FRAMES = 4;
export const MAX_QUEUE_BYTES = 12_800;

export interface VoicePcmFrame {
  readonly sequence: number;
  readonly data: Uint8Array;
  readonly format: VoiceAudioFormat;
}

export type VoicePcmTerminalReason =
  | 'cancelled'
  | 'deadline'
  | 'revoked'
  | 'device_unavailable'
  | 'overflow'
  | 'disposed';

export interface VoicePcmFrameSubscribeOptions {
  readonly signal: AbortSignal;
  readonly deadline: string;
  readonly onFrame: (frame: VoicePcmFrame) => void | Promise<void>;
  /**
   * Terminal callback indicating delivery has stopped. The host must not
   * infer physical capture track release from onEnd alone; await closed for physical release.
   */
  readonly onEnd: (reason: VoicePcmTerminalReason) => void;
}

export interface VoicePcmFrameSubscription {
  /**
   * Resolves only after the host capture binding has successfully returned a valid release
   * handle and confirmed capture availability. Rejects with VoiceSessionError if start fails,
   * an invalid handle is returned, or the subscription terminates before ready.
   */
  readonly ready: Promise<void>;
  unsubscribe(): void;
  /**
   * Resolves only after successful host release of this subscription's attachment and rejects
   * with EXTERNAL_FAILURE if release fails or start failure prevents release proof.
   * The host must not infer track release from an onEnd callback alone. Proves only that this
   * attachment was detached; physical capture continues if other subscribers remain active.
   */
  readonly closed: Promise<void>;
}

export interface VoicePcmFrameSourcePort {
  subscribe(options: VoicePcmFrameSubscribeOptions): VoicePcmFrameSubscription;
  dispose?(): Promise<void> | void;
}

export interface VoicePcmCaptureSink {
  onFrame(frame: Uint8Array | { data: Uint8Array }): void;
  onRevoked?(): void;
  onDeviceUnavailable?(): void;
}

export interface VoicePcmCaptureSubscription {
  release(): Promise<void> | void;
}

export interface VoicePcmCaptureBinding {
  /**
   * Attaches a capture sink to the trusted host's authorized audio hardware.
   *
   * The host implementation must maintain ONE physical getUserMedia capture source
   * and implement start(sink) as a refcount/fanout attachment to that single physical source,
   * not create a new microphone per call. Multiple subscribers must be supported concurrently
   * (e.g. concurrent wake word detection and speech recognition).
   *
   * Each returned release handle detaches that subscription's attachment and, when the last
   * reference is detached, awaits actual physical track stop. A single subscription.closed
   * proves only its attachment was released; it must not claim the whole microphone is stopped
   * if other subscribers remain active. port.dispose() awaits all attachments and serves as
   * the whole-source release receipt under the host contract.
   *
   * If start throws, rejects, or returns an invalid handle without a release function,
   * delivery ends with device_unavailable and closed rejects with EXTERNAL_FAILURE
   * because physical track release cannot be proven. The host must clean up its own
   * partial capture resources on start failure.
   */
  start(sink: VoicePcmCaptureSink): Promise<VoicePcmCaptureSubscription> | VoicePcmCaptureSubscription;
}
