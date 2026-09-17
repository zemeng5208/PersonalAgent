import {VoiceSessionError} from './errors.js';
import {MAX_AUDIO_BYTES, VOICE_AUDIO_FORMAT} from './ports.js';
import type {VoiceAudioClip} from './ports.js';

/** Container overhead is bounded separately from playable PCM bytes. */
export const MAX_VOICE_WAVE_BYTES = MAX_AUDIO_BYTES + 65_536;
export const MAX_VOICE_WAVE_CHUNKS = 64;
const byteLengthOf = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype), 'byteLength',
)!.get!;

function invalid(): never {
  throw new VoiceSessionError('INVALID_ARGUMENT', 'Unsupported or invalid voice WAVE audio');
}

/** Pure container decoding; no resampling, device, filesystem or provider calls. */
export function decodeVoiceWave(input: Uint8Array): VoiceAudioClip {
  try {
    if (!(input instanceof Uint8Array)) invalid();
    const length = byteLengthOf.call(input) as number;
    if (length < 44 || length > MAX_VOICE_WAVE_BYTES) invalid();
    // A private copy prevents later caller mutations from changing the parsed clip.
    const bytes = new Uint8Array(input);
    const view = new DataView(bytes.buffer);
    const idAt = (offset: number): string => String.fromCharCode(
      bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!,
    );
    if (idAt(0) !== 'RIFF' || idAt(8) !== 'WAVE'
      || view.getUint32(4, true) !== bytes.length - 8) invalid();

    let offset = 12;
    let chunks = 0;
    let formatSeen = false;
    let dataOffset: number | undefined;
    let dataLength = 0;
    while (offset < bytes.length) {
      if (++chunks > MAX_VOICE_WAVE_CHUNKS || bytes.length - offset < 8) invalid();
      const id = idAt(offset);
      const size = view.getUint32(offset + 4, true);
      const start = offset + 8;
      const end = start + size;
      const paddedEnd = end + (size % 2);
      if (paddedEnd > bytes.length) invalid();
      if (id === 'fmt ') {
        if (formatSeen || size !== 16 || dataOffset !== undefined) invalid();
        if (view.getUint16(start, true) !== 1
          || view.getUint16(start + 2, true) !== 1
          || view.getUint32(start + 4, true) !== 16_000
          || view.getUint32(start + 8, true) !== 32_000
          || view.getUint16(start + 12, true) !== 2
          || view.getUint16(start + 14, true) !== 16) invalid();
        formatSeen = true;
      } else if (id === 'data') {
        if (!formatSeen || dataOffset !== undefined || size === 0
          || size % 2 !== 0 || size > MAX_AUDIO_BYTES) invalid();
        dataOffset = start;
        dataLength = size;
      }
      offset = paddedEnd;
    }
    if (!formatSeen || dataOffset === undefined || bytes.length - dataLength > 65_536) invalid();
    return {
      data: bytes.slice(dataOffset, dataOffset + dataLength),
      format: VOICE_AUDIO_FORMAT,
      durationMs: Math.ceil(dataLength / 32),
    };
  } catch {
    // Never expose malformed payloads, metadata or implementation exceptions.
    return invalid();
  }
}
