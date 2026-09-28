import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {test} from 'node:test';
import {createWindowsSystemSpeechKeywordDetectorForTesting} from '../dist/windows-system-speech-keyword.js';
import {VOICE_AUDIO_FORMAT} from '../dist/ports.js';

class Child extends EventEmitter {
  stdout = new EventEmitter(); stderr = new EventEmitter(); stdin = new EventEmitter();
  writes = []; callbacks = []; kills = 0; closed = false;
  constructor() {
    super();
    this.stdin.write = (packet, callback) => {
      this.writes.push(Buffer.from(packet)); this.callbacks.push(callback); return true;
    };
    this.stdin.destroy = () => {};
  }
  kill() { this.kills++; return true; }
  line(event) { this.stdout.emit('data', Buffer.from(JSON.stringify({event}) + '\n')); }
  close() { if (!this.closed) { this.closed = true; this.emit('close', 0, null); } }
}
const turn = () => new Promise(resolve => setImmediate(resolve));
const frame = sequence => ({sequence, data: Uint8Array.of(1, 2), format: VOICE_AUDIO_FORMAT});

for (const boundary of ['ready', 'detected', 'queued']) {
  test(`expired keyword ${boundary} is rejected before its timer runs`, async t => {
    let now = Date.now();
    const expires = now + 10_000;
    t.mock.method(Date, 'now', () => now);
    const child = new Child();
    const detector = createWindowsSystemSpeechKeywordDetectorForTesting({keyword: 'synthetic'}, () => child);
    let detections = 0;
    const session = detector.start({signal: new AbortController().signal,
      deadline: new Date(expires).toISOString(), onDetected() { detections++; }});
    try {
      if (boundary !== 'ready') { child.line('ready'); await session.ready; }
      if (boundary === 'queued') { session.accept(frame(0)); session.accept(frame(1)); }
      now = expires;
      if (boundary === 'ready') {
        child.line('ready');
        await assert.rejects(session.ready, {code: 'TIMEOUT'});
      } else if (boundary === 'detected') child.line('detected');
      else child.callbacks[0]();
      await turn();
      assert.equal(detections, 0);
      assert.equal(child.writes.length, boundary === 'queued' ? 1 : 0);
      assert.equal(child.kills, 1);
      child.close();
      assert.equal((await session.closed).reason, 'deadline');
    } finally { child.close(); await detector.dispose(); }
  });
}

test('parent cancellation within spawn is rechecked after listener installation', async () => {
  const parent = new AbortController();
  const child = new Child();
  const detector = createWindowsSystemSpeechKeywordDetectorForTesting({keyword: 'synthetic'}, () => {
    parent.abort(); return child;
  });
  const session = detector.start({signal: parent.signal,
    deadline: new Date(Date.now() + 10_000).toISOString(), onDetected() { assert.fail('late wake'); }});
  try {
    child.line('ready');
    await assert.rejects(session.ready, {code: 'CANCELLED'});
    assert.equal(child.kills, 1);
    child.close();
    assert.equal((await session.closed).reason, 'cancelled');
  } finally { child.close(); await detector.dispose(); }
});

test('reentrant dispose during spawn awaits the returned child close', async () => {
  const child = new Child();
  let disposal;
  let settled = false;
  const detector = createWindowsSystemSpeechKeywordDetectorForTesting({keyword: 'synthetic'}, () => {
    disposal = detector.dispose().then(() => { settled = true; }); return child;
  });
  const session = detector.start({signal: new AbortController().signal,
    deadline: new Date(Date.now() + 10_000).toISOString(), onDetected() { assert.fail('late wake'); }});
  try {
    await turn();
    assert.equal(settled, false, 'disposal cannot claim release before the child closes');
    assert.equal(child.kills, 1);
    child.line('ready');
    await assert.rejects(session.ready, {code: 'EXTERNAL_FAILURE'});
    child.close();
    await disposal;
    assert.equal((await session.closed).reason, 'disposed');
    assert.equal(child.kills, 1);
  } finally { child.close(); await detector.dispose(); }
});
