import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  MAX_AUDIO_BYTES,
  MAX_VOICE_WAVE_BYTES,
  MAX_VOICE_WAVE_CHUNKS,
  VOICE_AUDIO_FORMAT,
  decodeVoiceWave,
  encodeVoiceWave,
} from '../dist/index.js';

const clip = data => ({
  data,
  format: {...VOICE_AUDIO_FORMAT},
  durationMs: Math.ceil(data.byteLength / 32),
});

const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const ascii = (bytes, start, length) => String.fromCharCode(...bytes.subarray(start, start + length));

function insertChunk(wave, offset, id, payload, includePadding = true) {
  const padding = includePadding && payload.byteLength % 2 === 1 ? 1 : 0;
  const chunk = new Uint8Array(8 + payload.byteLength + padding);
  chunk.set([...id].map(character => character.charCodeAt(0)), 0);
  new DataView(chunk.buffer).setUint32(4, payload.byteLength, true);
  chunk.set(payload, 8);
  const result = new Uint8Array(wave.byteLength + chunk.byteLength);
  result.set(wave.subarray(0, offset), 0);
  result.set(chunk, offset);
  result.set(wave.subarray(offset), offset + chunk.byteLength);
  view(result).setUint32(4, result.byteLength - 8, true);
  return result;
}

test('canonical WAVE round-trips non-ASCII-independent PCM snapshots without aliasing', () => {
  const source = Uint8Array.from({length: 64}, (_, index) => index);
  const expected = new Uint8Array(source);
  const wave = encodeVoiceWave(clip(source));
  source.fill(0xff);

  assert.equal(wave.byteLength, 44 + expected.byteLength);
  assert.equal(ascii(wave, 0, 4), 'RIFF');
  assert.equal(view(wave).getUint32(4, true), wave.byteLength - 8);
  assert.equal(ascii(wave, 8, 4), 'WAVE');
  assert.equal(ascii(wave, 12, 4), 'fmt ');
  assert.equal(view(wave).getUint32(16, true), 16);
  assert.equal(view(wave).getUint16(20, true), 1);
  assert.equal(view(wave).getUint16(22, true), 1);
  assert.equal(view(wave).getUint32(24, true), 16_000);
  assert.equal(view(wave).getUint32(28, true), 32_000);
  assert.equal(view(wave).getUint16(32, true), 2);
  assert.equal(view(wave).getUint16(34, true), 16);
  assert.equal(ascii(wave, 36, 4), 'data');
  assert.equal(view(wave).getUint32(40, true), expected.byteLength);
  assert.deepEqual(wave.subarray(44), expected);

  const decoded = decodeVoiceWave(wave);
  assert.deepEqual(decoded, {data: expected, format: VOICE_AUDIO_FORMAT, durationMs: 2});
  wave[44] = 0xee;
  assert.equal(decoded.data[0], expected[0]);
  decoded.data[1] = 0xdd;
  assert.equal(wave[45], expected[1]);
});

test('decoder skips one ordinary odd-sized unknown chunk with complete padding', () => {
  const pcm = Uint8Array.from([0x10, 0x00, 0x20, 0x00]);
  const canonical = encodeVoiceWave(clip(pcm));
  const withUnknown = insertChunk(canonical, 36, 'JUNK', Uint8Array.from([1, 2, 3]));

  assert.deepEqual(decodeVoiceWave(withUnknown), {
    data: pcm,
    format: VOICE_AUDIO_FORMAT,
    durationMs: 1,
  });
  assert.equal(view(withUnknown).getUint32(4, true), withUnknown.byteLength - 8);
});

test('decoder rejects malformed headers, sizes, duplicate chunks, truncation and wrong format', () => {
  const pcm = Uint8Array.from([0x10, 0x00, 0x20, 0x00]);
  const canonical = encodeVoiceWave(clip(pcm));
  const invalid = [];
  const wrongRiff = new Uint8Array(canonical);
  wrongRiff[3] = 0x58;
  invalid.push(wrongRiff);
  const wrongSize = new Uint8Array(canonical);
  view(wrongSize).setUint32(4, wrongSize.byteLength - 9, true);
  invalid.push(wrongSize);
  const wrongFormat = new Uint8Array(canonical);
  view(wrongFormat).setUint16(20, 3, true);
  invalid.push(wrongFormat);
  invalid.push(canonical.subarray(0, canonical.byteLength - 1));
  invalid.push(insertChunk(canonical, 36, 'fmt ', canonical.subarray(20, 36)));
  invalid.push(insertChunk(canonical, canonical.byteLength, 'data', pcm));
  invalid.push(insertChunk(canonical, 36, 'JUNK', Uint8Array.from([1]), false));

  for (const value of invalid) {
    assert.throws(() => decodeVoiceWave(value), {code: 'INVALID_ARGUMENT'});
  }
});

test('encoder and decoder enforce PCM bounds, exact duration and copied byte inputs', () => {
  const validMaximum = new Uint8Array(MAX_AUDIO_BYTES);
  const maximumWave = encodeVoiceWave({data: validMaximum, format: VOICE_AUDIO_FORMAT, durationMs: 60_000});
  assert.equal(maximumWave.byteLength, MAX_AUDIO_BYTES + 44);
  assert.equal(decodeVoiceWave(maximumWave).durationMs, 60_000);

  const invalidClips = [
    clip(new Uint8Array()),
    clip(new Uint8Array(3)),
    clip(new Uint8Array(MAX_AUDIO_BYTES + 2)),
    {...clip(new Uint8Array(32)), durationMs: 2},
    {...clip(new Uint8Array(32)), format: {...VOICE_AUDIO_FORMAT, encoding: 'pcm_f32le'}},
    {...clip(new Uint8Array(32)), format: {...VOICE_AUDIO_FORMAT, sampleRateHz: 48_000}},
    {...clip(new Uint8Array(32)), format: {...VOICE_AUDIO_FORMAT, channels: 2}},
    {data: new Uint8Array(32), format: VOICE_AUDIO_FORMAT, durationMs: 60_001},
    {data: new Proxy(new Uint8Array(32), {}), format: VOICE_AUDIO_FORMAT, durationMs: 1},
  ];
  for (const value of invalidClips) {
    assert.throws(() => encodeVoiceWave(value), {
      code: 'INVALID_ARGUMENT',
      message: 'Invalid voice WAVE input',
    });
  }

  const spoofedLength = new Uint8Array(32);
  Object.defineProperty(spoofedLength, 'byteLength', {
    get() {
      throw new Error('external byteLength getter must not run');
    },
  });
  assert.equal(encodeVoiceWave({
    data: spoofedLength,
    format: VOICE_AUDIO_FORMAT,
    durationMs: 1,
  }).byteLength, 76);

  assert.throws(
    () => decodeVoiceWave(new Uint8Array(MAX_VOICE_WAVE_BYTES + 1)),
    {code: 'INVALID_ARGUMENT'},
  );
  const excessiveOverhead = insertChunk(
    encodeVoiceWave(clip(new Uint8Array(2))),
    36,
    'JUNK',
    new Uint8Array(65_536),
  );
  assert.throws(() => decodeVoiceWave(excessiveOverhead), {code: 'INVALID_ARGUMENT'});

  let excessiveChunks = encodeVoiceWave(clip(new Uint8Array(2)));
  for (let index = 0; index < MAX_VOICE_WAVE_CHUNKS; index += 1) {
    excessiveChunks = insertChunk(excessiveChunks, 36, 'JUNK', new Uint8Array());
  }
  assert.throws(() => decodeVoiceWave(excessiveChunks), {code: 'INVALID_ARGUMENT'});

  const oddData = encodeVoiceWave(clip(new Uint8Array(2)));
  view(oddData).setUint32(40, 1, true);
  assert.throws(() => decodeVoiceWave(oddData), {code: 'INVALID_ARGUMENT'});
});
