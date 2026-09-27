export type VoiceErrorCode =
  | 'INVALID_ARGUMENT'
  | 'INVALID_STATE'
  | 'UNSUPPORTED_CAPABILITY'
  | 'CANCELLED'
  | 'TIMEOUT'
  | 'STALE_SESSION'
  | 'EXTERNAL_FAILURE';

/** Public errors use fixed messages and never echo audio, transcripts, replies or provider errors. */
export class VoiceSessionError extends Error {
  readonly code: VoiceErrorCode;

  constructor(code: VoiceErrorCode, message: string) {
    super(message);
    this.name = 'VoiceSessionError';
    this.code = code;
  }
}
