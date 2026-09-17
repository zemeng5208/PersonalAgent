import {VoiceSessionError} from './errors.js';
import {
  MAX_AUDIO_BYTES,
  MAX_AUDIO_DURATION_MS,
  VOICE_AUDIO_FORMAT,
  type VoiceAudioClip,
} from './ports.js';

const WAVE_HEADER_BYTES = 44;
const PCM_BYTES_PER_MILLISECOND = 32;
const byteLengthOf = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'byteLength',
)!.get!;
const setBytes = Uint8Array.prototype.set;

function invalid(): never {
  throw new VoiceSessionError('INVALID_ARGUMENT', 'Invalid voice WAVE input');
}

function exactDataRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return invalid();
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length
      || ownKeys.some(key => typeof key !== 'string' || !keys.includes(key))) return invalid();
    const captured: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return invalid();
      captured[key] = descriptor.value;
    }
    return captured;
  } catch (error) {
    if (error instanceof VoiceSessionError) throw error;
    return invalid();
  }
}

function captureClip(clip: VoiceAudioClip): {data: Uint8Array; byteLength: number} {
  const input = exactDataRecord(clip, ['data', 'format', 'durationMs']);
  const format = exactDataRecord(input.format, ['encoding', 'sampleRateHz', 'channels']);
  const data = input.data;
  const durationMs = input.durationMs;
  if (!(data instanceof Uint8Array)) return invalid();
  const byteLength = byteLengthOf.call(data) as number;
  if (byteLength === 0
    || byteLength % 2 !== 0
    || byteLength > MAX_AUDIO_BYTES
    || format.encoding !== VOICE_AUDIO_FORMAT.encoding
    || format.sampleRateHz !== VOICE_AUDIO_FORMAT.sampleRateHz
    || format.channels !== VOICE_AUDIO_FORMAT.channels
    || typeof durationMs !== 'number'
    || !Number.isSafeInteger(durationMs)
    || durationMs !== Math.ceil(byteLength / PCM_BYTES_PER_MILLISECOND)
    || durationMs > MAX_AUDIO_DURATION_MS) {
    return invalid();
  }
  const snapshot = new Uint8Array(byteLength);
  setBytes.call(snapshot, data);
  return {data: snapshot, byteLength};
}

/** Encode one bounded in-memory PCM clip as a canonical 44-byte-header RIFF WAVE. */
export function encodeVoiceWave(clip: VoiceAudioClip): Uint8Array {
  try {
    const {data, byteLength} = captureClip(clip);
    const wave = new Uint8Array(WAVE_HEADER_BYTES + byteLength);
    const view = new DataView(wave.buffer, wave.byteOffset, wave.byteLength);
    wave.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
    view.setUint32(4, 36 + byteLength, true);
    wave.set([0x57, 0x41, 0x56, 0x45], 8); // WAVE
    wave.set([0x66, 0x6d, 0x74, 0x20], 12); // fmt
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, VOICE_AUDIO_FORMAT.channels, true);
    view.setUint32(24, VOICE_AUDIO_FORMAT.sampleRateHz, true);
    view.setUint32(28, VOICE_AUDIO_FORMAT.sampleRateHz * VOICE_AUDIO_FORMAT.channels * 2, true);
    view.setUint16(32, VOICE_AUDIO_FORMAT.channels * 2, true);
    view.setUint16(34, 16, true);
    wave.set([0x64, 0x61, 0x74, 0x61], 36); // data
    view.setUint32(40, byteLength, true);
    wave.set(data, WAVE_HEADER_BYTES);
    return wave;
  } catch {
    return invalid();
  }
}
