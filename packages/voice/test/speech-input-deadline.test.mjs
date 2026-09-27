import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {runInNewContext} from 'node:vm';
import {test} from 'node:test';
import {VOICE_AUDIO_FORMAT} from '../dist/ports.js';
import {createWindowsSystemSpeechPortsForTesting} from '../dist/windows-system-speech.js';

class Child extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough();
  inputs = []; closed = false;
  constructor() { super(); this.stdin.on('data', bytes => this.inputs.push(Buffer.from(bytes))); }
  close() { if (!this.closed) { this.closed = true; this.emit('close', 0, null); } }
  kill() { queueMicrotask(() => this.close()); return true; }
  reply() { this.stdout.write(JSON.stringify({ok: true, text: 'synthetic transcript', locale: 'zh-CN'})); this.close(); }
}
const request = audio => ({sessionId: 'synthetic-session', audio, format: VOICE_AUDIO_FORMAT,
  durationMs: 1, locale: 'zh-CN', deadline: new Date(Date.now() + 10_000).toISOString(),
  signal: new AbortController().signal});

test('recognition rejects non-byte typed arrays before starting the child', async () => {
  const children = [];
  const ports = createWindowsSystemSpeechPortsForTesting(() => {
    const child = new Child(); children.push(child); return child;
  });
  try {
    assert.throws(() => {
      const operation = ports.recognition.recognize(request(new Uint16Array([0x0201, 0x0403])));
      void operation.result.catch(() => {});
    }, {code: 'INVALID_ARGUMENT', message: 'Invalid Windows speech audio'});
    assert.equal(children.length, 0);
  } finally { await ports.dispose(); }
});

test('valid Buffer and cross-realm byte views preserve the exact PCM bytes', async () => {
  const children = [];
  const ports = createWindowsSystemSpeechPortsForTesting(() => {
    const child = new Child(); children.push(child); return child;
  });
  try {
    for (const input of [Buffer.from([1, 2, 3, 4]), runInNewContext('Uint8Array.of(1, 2, 3, 4)')]) {
      const operation = ports.recognition.recognize(request(input));
      assert.deepEqual([...Buffer.concat(children.at(-1).inputs)], [1, 2, 3, 4]);
      children.at(-1).reply();
      assert.equal((await operation.result).text, 'synthetic transcript');
    }
  } finally { await ports.dispose(); }
});

test('a successful close after the deadline cannot publish a transcript before the timer runs', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const child = new Child();
  const ports = createWindowsSystemSpeechPortsForTesting(() => child);
  try {
    const input = request(Uint8Array.of(1, 2, 3, 4));
    const operation = ports.recognition.recognize(input);
    now = Date.parse(input.deadline);
    child.reply();
    await assert.rejects(operation.result, {code: 'TIMEOUT', message: 'Windows speech operation deadline expired'});
    await operation.stop('disposed');
    assert.equal(child.closed, true);
  } finally { await ports.dispose(); }
});
