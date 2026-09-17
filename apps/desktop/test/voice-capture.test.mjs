import assert from 'node:assert/strict';
import test from 'node:test';

import {resampleMonoToPcm16} from '../src/features/voice/capture.js';

test('voice capture converts bounded mono samples to PCM16LE 16 kHz', () => {
  const source = new Float32Array(480).fill(0.5);
  const pcm = resampleMonoToPcm16([source], 48_000);
  assert.equal(pcm.byteLength, 320);
  assert.equal(new DataView(pcm.buffer).getInt16(0, true), 16_384);
});

test('voice capture rejects empty input', () => {
  assert.throws(() => resampleMonoToPcm16([], 48_000), /没有可用/);
});
