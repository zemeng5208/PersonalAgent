import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {test} from 'node:test';

import {VOICE_AUDIO_FORMAT, VoiceSessionError} from '../dist/index.js';
import {createWindowsSystemSpeechKeywordDetectorForTesting} from '../dist/windows-system-speech-keyword.js';

const deadline = (offsetMs = 2_000) => new Date(Date.now() + offsetMs).toISOString();

class FakeKeywordProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  frames = [];
  controls = [];
  killed = false;
  closed = false;

  constructor() {
    super();
    let buffer = Buffer.alloc(0);
    this.stdin.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const msgType = buffer[0];
        const ctrlCode = buffer[1];
        const payloadLen = buffer[2] | (buffer[3] << 8);
        if (msgType === 2) {
          this.controls.push(ctrlCode);
          this.emit('control', ctrlCode);
          buffer = buffer.subarray(4);
          continue;
        }
        if (buffer.length < 4 + payloadLen) break;
        const payload = buffer.subarray(4, 4 + payloadLen);
        this.frames.push(Buffer.from(payload));
        this.emit('frame', Buffer.from(payload));
        buffer = buffer.subarray(4 + payloadLen);
      }
    });
  }

  emitReady() {
    this.stdout.write(JSON.stringify({event: 'ready'}) + '\n');
  }

  emitDetected() {
    this.stdout.write(JSON.stringify({event: 'detected'}) + '\n');
  }

  emitEnvelope(obj) {
    this.stdout.write(JSON.stringify(obj) + '\n');
  }

  close(code = 0, signal = null) {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit('close', code, signal));
  }

  kill() {
    if (this.closed) return false;
    this.killed = true;
    setTimeout(() => this.close(null, 'SIGTERM'), 5);
    return true;
  }
}

function createTestDetector(keyword, fakeChild) {
  return createWindowsSystemSpeechKeywordDetectorForTesting(
    {keyword},
    () => fakeChild,
  );
}

const sampleFrame = (sequence = 0, bytes = 3200) => ({
  sequence,
  data: new Uint8Array(bytes),
  format: VOICE_AUDIO_FORMAT,
});

test('ready and detected: verified child envelope, PCM frame stream, empty onDetected callback, and stop release', async () => {
  const fakeChild = new FakeKeywordProcess();
  const detector = createTestDetector('你好小派', fakeChild);

  let detectionsCount = 0;
  const session = detector.start({
    signal: new AbortController().signal,
    deadline: deadline(),
    onDetected: () => {
      detectionsCount += 1;
    },
  });

  fakeChild.emitReady();
  await session.ready;

  session.accept(sampleFrame(0, 3200));

  await new Promise(resolve => {
    if (fakeChild.frames.length > 0) resolve();
    else fakeChild.once('frame', () => resolve());
  });

  assert.equal(fakeChild.frames.length, 1);
  assert.equal(fakeChild.frames[0].byteLength, 3200);

  fakeChild.emitDetected();
  assert.equal(detectionsCount, 1);

  await session.stop();
  assert.equal(fakeChild.killed, true);

  const result = await session.closed;
  assert.deepEqual(result, {reason: 'stopped', detections: 1});

  await detector.dispose();
});

test('no matching phrase: ready succeeds, eventual closed has detections 0', async () => {
  const fakeChild = new FakeKeywordProcess();
  const detector = createTestDetector('你好小派', fakeChild);

  let detectionsCount = 0;
  const session = detector.start({
    signal: new AbortController().signal,
    deadline: deadline(),
    onDetected: () => {
      detectionsCount += 1;
    },
  });

  fakeChild.emitReady();
  await session.ready;

  session.accept(sampleFrame(0, 1600));
  session.accept(sampleFrame(1, 1600));

  await session.stop();
  const result = await session.closed;
  assert.deepEqual(result, {reason: 'stopped', detections: 0});
  assert.equal(detectionsCount, 0);

  await detector.dispose();
});

test('missing zh-CN recognizer: ready rejects UNSUPPORTED_CAPABILITY, closed is unavailable', async () => {
  const fakeChild = new FakeKeywordProcess();
  const detector = createTestDetector('你好小派', fakeChild);

  const session = detector.start({
    signal: new AbortController().signal,
    deadline: deadline(),
    onDetected: () => {},
  });

  fakeChild.emitEnvelope({ok: false, code: 'UNSUPPORTED_CAPABILITY'});
  fakeChild.close(2);

  await assert.rejects(session.ready, err => {
    return err instanceof VoiceSessionError && err.code === 'UNSUPPORTED_CAPABILITY';
  });

  const result = await session.closed;
  assert.deepEqual(result, {reason: 'unavailable', detections: 0});

  await detector.dispose();
});

test('malformed child envelope: ready rejects EXTERNAL_FAILURE, closed is external_failure', async () => {
  const fakeChild = new FakeKeywordProcess();
  const detector = createTestDetector('你好小派', fakeChild);

  const session = detector.start({
    signal: new AbortController().signal,
    deadline: deadline(),
    onDetected: () => {},
  });

  fakeChild.stdout.write('invalid json line\n');
  fakeChild.close(1);

  await assert.rejects(session.ready, err => {
    return err instanceof VoiceSessionError && err.code === 'EXTERNAL_FAILURE';
  });

  const result = await session.closed;
  assert.deepEqual(result, {reason: 'external_failure', detections: 0});

  await detector.dispose();
});

test('parent abort signal: kills exact child, awaits close, closed is cancelled', async () => {
  const fakeChild = new FakeKeywordProcess();
  const detector = createTestDetector('你好小派', fakeChild);
  const controller = new AbortController();

  const session = detector.start({
    signal: controller.signal,
    deadline: deadline(),
    onDetected: () => {},
  });

  fakeChild.emitReady();
  await session.ready;

  controller.abort();

  const result = await session.closed;
  assert.deepEqual(result, {reason: 'cancelled', detections: 0});
  assert.equal(fakeChild.killed, true);

  await detector.dispose();
});

test('queue overflow: exceeding 4 frames terminates session with overflow terminal', async () => {
  const fakeChild = new FakeKeywordProcess();
  const detector = createTestDetector('你好小派', fakeChild);

  const session = detector.start({
    signal: new AbortController().signal,
    deadline: deadline(),
    onDetected: () => {},
  });

  // Frames queued before ready (not pumped yet)
  session.accept(sampleFrame(0, 1000));
  session.accept(sampleFrame(1, 1000));
  session.accept(sampleFrame(2, 1000));
  session.accept(sampleFrame(3, 1000));

  // 5th frame triggers overflow
  session.accept(sampleFrame(4, 1000));

  const result = await session.closed;
  assert.deepEqual(result, {reason: 'overflow', detections: 0});
  assert.equal(fakeChild.killed, true);

  await detector.dispose();
});

test('strict frame validation: sequence monotonic from 0, format, and even nonempty length <= 3200', async () => {
  const fakeChild = new FakeKeywordProcess();
  const detector = createTestDetector('你好小派', fakeChild);

  const session = detector.start({
    signal: new AbortController().signal,
    deadline: deadline(),
    onDetected: () => {},
  });

  // Sequence must start at 0
  assert.throws(
    () => session.accept({sequence: 1, data: new Uint8Array(100), format: VOICE_AUDIO_FORMAT}),
    err => err instanceof VoiceSessionError && err.code === 'INVALID_ARGUMENT',
  );

  // Correct sequence 0
  session.accept({sequence: 0, data: new Uint8Array(100), format: VOICE_AUDIO_FORMAT});

  // Out of order: next must be 1, not 2
  assert.throws(
    () => session.accept({sequence: 2, data: new Uint8Array(100), format: VOICE_AUDIO_FORMAT}),
    err => err instanceof VoiceSessionError && err.code === 'INVALID_ARGUMENT',
  );

  // Wrong format
  assert.throws(
    () => session.accept({sequence: 1, data: new Uint8Array(100), format: {encoding: 'pcm_s16le', sampleRateHz: 8000, channels: 1}}),
    err => err instanceof VoiceSessionError && err.code === 'INVALID_ARGUMENT',
  );

  // Odd length
  assert.throws(
    () => session.accept({sequence: 1, data: new Uint8Array(101), format: VOICE_AUDIO_FORMAT}),
    err => err instanceof VoiceSessionError && err.code === 'INVALID_ARGUMENT',
  );

  // Empty data
  assert.throws(
    () => session.accept({sequence: 1, data: new Uint8Array(0), format: VOICE_AUDIO_FORMAT}),
    err => err instanceof VoiceSessionError && err.code === 'INVALID_ARGUMENT',
  );

  // Over 3200 bytes
  assert.throws(
    () => session.accept({sequence: 1, data: new Uint8Array(3202), format: VOICE_AUDIO_FORMAT}),
    err => err instanceof VoiceSessionError && err.code === 'INVALID_ARGUMENT',
  );

  await session.stop();
  await detector.dispose();
});

test('strict keyword validation: control-free, bounded, non-empty', () => {
  // Empty or whitespace
  assert.throws(
    () => createWindowsSystemSpeechKeywordDetectorForTesting({keyword: ''}, () => {}),
    err => err instanceof VoiceSessionError && err.code === 'INVALID_ARGUMENT',
  );
  assert.throws(
    () => createWindowsSystemSpeechKeywordDetectorForTesting({keyword: '   '}, () => {}),
    err => err instanceof VoiceSessionError && err.code === 'INVALID_ARGUMENT',
  );

  // Control / injection characters
  assert.throws(
    () => createWindowsSystemSpeechKeywordDetectorForTesting({keyword: '你好\n小派'}, () => {}),
    err => err instanceof VoiceSessionError && err.code === 'INVALID_ARGUMENT',
  );
  assert.throws(
    () => createWindowsSystemSpeechKeywordDetectorForTesting({keyword: '<grammar>'}, () => {}),
    err => err instanceof VoiceSessionError && err.code === 'INVALID_ARGUMENT',
  );
  assert.throws(
    () => createWindowsSystemSpeechKeywordDetectorForTesting({keyword: 'hello; rm -rf'}, () => {}),
    err => err instanceof VoiceSessionError && err.code === 'INVALID_ARGUMENT',
  );

  // Bounded length (max 32 characters)
  const tooLong = '一'.repeat(33);
  assert.throws(
    () => createWindowsSystemSpeechKeywordDetectorForTesting({keyword: tooLong}, () => {}),
    err => err instanceof VoiceSessionError && err.code === 'INVALID_ARGUMENT',
  );

  // Valid Chinese phrase
  assert.doesNotThrow(() => {
    createWindowsSystemSpeechKeywordDetectorForTesting({keyword: '你好小派'}, () => {});
  });
});

test('stop idempotency and disposal', async () => {
  const fakeChild = new FakeKeywordProcess();
  const detector = createTestDetector('你好小派', fakeChild);

  const session = detector.start({
    signal: new AbortController().signal,
    deadline: deadline(),
    onDetected: () => {},
  });

  fakeChild.emitReady();
  await session.ready;

  // Multiple stop calls return the same promise
  const stop1 = session.stop();
  const stop2 = session.stop();
  assert.equal(stop1, stop2);
  await stop1;

  // Disposal stops running sessions and marks detector disposed
  await detector.dispose();
  assert.throws(
    () => detector.start({signal: new AbortController().signal, deadline: deadline(), onDetected: () => {}}),
    err => err instanceof VoiceSessionError && err.code === 'INVALID_STATE',
  );
});
