import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
  MAX_AUDIO_BYTES,
  MAX_AUDIO_DURATION_MS,
  VOICE_AUDIO_FORMAT,
  createVoicePcmBuffer,
} from '../dist/index.js';

const futureDeadline = (offsetMs = 2_000) => new Date(Date.now() + offsetMs).toISOString();
const create = (overrides = {}) => createVoicePcmBuffer({
  signal: new AbortController().signal,
  deadline: futureDeadline(),
  ...overrides,
});

test('segmented PCM is copied on append and finished as one independent clip', () => {
  const first = Uint8Array.from([1, 2, 3, 4]);
  const second = Uint8Array.from([5, 6]);
  const buffer = create();
  buffer.append(first);
  buffer.append(second);
  first.fill(99);
  second.fill(88);

  const clip = buffer.finish();
  assert.deepEqual([...clip.data], [1, 2, 3, 4, 5, 6]);
  assert.equal(clip.data.buffer === first.buffer, false);
  assert.equal(clip.data.buffer === second.buffer, false);
  assert.equal(clip.format, VOICE_AUDIO_FORMAT);
  assert.equal(clip.durationMs, 1);

  const many = create({maxDurationMs: 625});
  for (let index = 0; index < 10_000; index++) many.append(Uint8Array.of(index & 255, index >>> 8 & 255));
  const manyClip = many.finish();
  assert.equal(manyClip.data.byteLength, 20_000);
  assert.deepEqual([...manyClip.data.subarray(0, 4)], [0, 0, 1, 0]);
});

test('chunks and accumulated PCM obey frame, duration, and global byte limits without truncation', () => {
  const buffer = create({maxDurationMs: 1});
  assert.throws(() => buffer.append(new Uint8Array()), error => error.code === 'INVALID_ARGUMENT');
  assert.throws(() => buffer.append(Uint8Array.of(1)), error => error.code === 'INVALID_ARGUMENT');
  buffer.append(new Uint8Array(32).fill(7));
  assert.throws(
    () => buffer.append(Uint8Array.of(8, 9)),
    error => error.code === 'INVALID_ARGUMENT' && error.message === 'Voice PCM buffer capacity exceeded',
  );
  const clip = buffer.finish();
  assert.equal(clip.data.byteLength, 32);
  assert.equal(clip.data.every(value => value === 7), true);
  assert.equal(clip.durationMs, 1);
  assert.equal(MAX_AUDIO_BYTES, MAX_AUDIO_DURATION_MS * 32);
  assert.throws(() => create({maxDurationMs: MAX_AUDIO_DURATION_MS + 1}), error => error.code === 'INVALID_ARGUMENT');

  const guarded = create();
  guarded.append(Uint8Array.of(1, 2));
  const ownGetter = Uint8Array.of(3, 4);
  Object.defineProperty(ownGetter, 'byteLength', {get() { throw new Error('private getter text'); }});
  assert.doesNotThrow(() => guarded.append(ownGetter));
  const proxy = new Proxy(Uint8Array.of(5, 6), {get() { throw new Error('private proxy text'); }});
  assert.throws(
    () => guarded.append(proxy),
    error => error.code === 'INVALID_ARGUMENT'
      && error.message === 'Invalid voice PCM chunk'
      && !error.message.includes('private'),
  );
  assert.deepEqual([...guarded.finish().data], [1, 2, 3, 4]);
  assert.throws(
    () => create({deadline: '2026-02-31T00:00:00Z'}),
    error => error.code === 'INVALID_ARGUMENT' && error.message === 'Invalid voice PCM buffer deadline',
  );
});

test('abort and deadline release idle buffers and reject all later access with fixed errors', async () => {
  const parent = new AbortController();
  const cancelled = createVoicePcmBuffer({signal: parent.signal, deadline: futureDeadline()});
  cancelled.append(Uint8Array.of(1, 2));
  parent.abort();
  assert.throws(() => cancelled.append(Uint8Array.of(3, 4)), error => error.code === 'CANCELLED');
  assert.throws(() => cancelled.finish(), error => error.code === 'CANCELLED');
  assert.doesNotThrow(() => cancelled.dispose());

  const expired = create({deadline: futureDeadline(30)});
  expired.append(Uint8Array.of(5, 6));
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.throws(() => expired.append(Uint8Array.of(7, 8)), error => error.code === 'TIMEOUT');
  assert.throws(() => expired.finish(), error => error.code === 'TIMEOUT');
  assert.doesNotThrow(() => expired.dispose());
});

test('finish and dispose close the buffer idempotently and reject later mutations', () => {
  const empty = create();
  assert.throws(() => empty.finish(), error => error.code === 'INVALID_STATE');
  empty.append(Uint8Array.of(1, 2));
  empty.finish();
  assert.throws(() => empty.finish(), error => error.code === 'INVALID_STATE');
  assert.throws(() => empty.append(Uint8Array.of(3, 4)), error => error.code === 'INVALID_STATE');
  assert.doesNotThrow(() => empty.dispose());
  assert.doesNotThrow(() => empty.dispose());

  const disposed = create();
  disposed.append(Uint8Array.of(9, 10));
  disposed.dispose();
  disposed.dispose();
  assert.throws(() => disposed.finish(), error => error.code === 'INVALID_STATE');
  assert.throws(() => disposed.append(Uint8Array.of(11, 12)), error => error.code === 'INVALID_STATE');

  const aborted = new AbortController();
  aborted.abort();
  assert.throws(
    () => createVoicePcmBuffer({signal: aborted.signal, deadline: futureDeadline()}),
    error => error.code === 'CANCELLED',
  );
  assert.throws(
    () => createVoicePcmBuffer({signal: new AbortController().signal, deadline: new Date(Date.now() - 1).toISOString()}),
    error => error.code === 'TIMEOUT',
  );
});
