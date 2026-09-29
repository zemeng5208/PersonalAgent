import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createVoicePcmBuffer} from '../dist/pcm-buffer.js';

for (const chunk of [new Uint16Array([0x0201]), new Int8Array([1, 2]),
  new Float64Array([1]), new BigInt64Array([1n])]) {
  test(`PCM rejects ${chunk.constructor.name} without changing accumulated bytes`, () => {
    const buffer = createVoicePcmBuffer({signal: new AbortController().signal,
      deadline: new Date(Date.now() + 10_000).toISOString()});
    try {
      buffer.append(Uint8Array.of(7, 8));
      assert.throws(() => buffer.append(chunk), {
        code: 'INVALID_ARGUMENT', message: 'Invalid voice PCM chunk',
      });
      buffer.append(Buffer.from([9, 10]));
      assert.deepEqual([...buffer.finish().data], [7, 8, 9, 10]);
    } finally {
      buffer.dispose();
    }
  });
}
