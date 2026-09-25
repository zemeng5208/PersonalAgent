export {VoiceSessionError} from './errors.js';
export type {VoiceErrorCode} from './errors.js';
export {
  MAX_AUDIO_BYTES,
  MAX_AUDIO_DURATION_MS,
  MAX_FRAME_BYTES,
  MAX_QUEUE_BYTES,
  MAX_QUEUE_FRAMES,
  MAX_SPEECH_CHARACTERS,
  MAX_TRANSCRIPT_CHARACTERS,
  VOICE_AUDIO_FORMAT,
} from './ports.js';
export type {
  SpeechOutputPort,
  SpeechOutputRequest,
  SpeechRecognitionPort,
  SpeechRecognitionRequest,
  SpeechRecognitionResult,
  SpeechKeywordCloseReason,
  SpeechKeywordCloseResult,
  SpeechKeywordDetectorPort,
  SpeechKeywordSession,
  SpeechKeywordStartOptions,
  TranscriptConsumerPort,
  TranscriptConsumptionRequest,
  TranscriptConsumptionResult,
  VoiceAudioClip,
  VoiceAudioFormat,
  VoiceOperation,
  VoiceOperationStopReason,
  VoicePcmCaptureBinding,
  VoicePcmCaptureSink,
  VoicePcmCaptureSubscription,
  VoicePcmFrame,
  VoicePcmFrameSourcePort,
  VoicePcmFrameSubscribeOptions,
  VoicePcmFrameSubscription,
  VoicePcmTerminalReason,
  WindowsSystemSpeechKeywordDetectorOptions,
} from './ports.js';
export {createVoicePcmFrameSourcePort} from './pcm-frame-source.js';
export {
  UnavailableSpeechKeywordDetectorPort,
  UnavailableSpeechOutputPort,
  UnavailableSpeechRecognitionPort,
  UnavailableTranscriptConsumerPort,
} from './unavailable.js';
export {createWindowsSystemSpeechPorts} from './windows-system-speech.js';
export type {WindowsSystemSpeechPorts} from './windows-system-speech.js';
export {createWindowsSystemSpeechKeywordDetector} from './windows-system-speech-keyword.js';
export type {WindowsSpeechKeywordHostSpawner} from './windows-system-speech-keyword.js';
export {VoiceSessionManager} from './voice-session.js';
export type {
  ReplyReceipt,
  SpeechPlaybackResult,
  StartVoiceSessionOptions,
  StopSpeakingResult,
  StopVoiceSessionResult,
  TranscriptReceipt,
  VoiceIdKind,
  VoiceSessionManagerOptions,
  VoiceSessionListener,
  VoiceSessionSnapshot,
  VoiceSessionState,
  VoiceSessionTerminalReason,
} from './voice-session.js';
