import assert from 'node:assert/strict';
import test from 'node:test';
import {createDesktopVoiceInputCore} from '../electron/voice-input-core.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

function fixture() {
  const calls = [];
  const fixedNow = Date.parse('2026-09-25T00:00:00.000Z');
  const ready = deferred();
  const closed = deferred();
  let options;
  const subscription = {ready: ready.promise, closed: closed.promise,
    unsubscribe: () => { calls.push('unsubscribe'); }};
  const source = {subscribe: value => { calls.push('subscribe'); options = value; return subscription; },
    dispose: async () => { calls.push('dispose-source'); }};
  const microphoneHost = {authorize: () => { calls.push('authorize'); },
    snapshot: () => ({subscriberCount: 0}), revoke: async () => { calls.push('revoke'); }};
  class Manager {
    async start(options) { calls.push(['session-start', options.deadline]); return {sessionId: 'session-1'}; }
    current() { return {sessionId: 'session-1', state: 'listening', revision: 1}; }
    async recognizeAudio(_id, clip) { calls.push(['recognize', [...clip.data]]); return {transcriptId: 'transcript-1'}; }
    async consumeTranscript(_id, receipt, consumer) { calls.push(['consume', receipt, consumer]); return {replyId: 'reply-1'}; }
    async speakReply(_id, receipt) { calls.push(['speak', receipt]); return {completed: true, interrupted: false}; }
    async stop() { calls.push('session-stop'); }
    async stopSpeaking() { calls.push('stop-speaking'); return {playbackStopped: true, resourcesReleased: true}; }
  }
  const input = createDesktopVoiceInputCore({source, microphoneHost, client: {call: () => {}},
    createBuffer: options => {
      calls.push(['buffer-deadline', options.deadline]);
      const data = [];
      return {append: chunk => { calls.push('append'); data.push(...chunk); },
        finish: () => { calls.push('finish-buffer'); return {data: Uint8Array.from(data),
          format: {encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1}, durationMs: data.length / 32}; },
        dispose: () => { calls.push('dispose-buffer'); }};
    },
    VoiceSessionManager: Manager, createConsumer: () => ({kind: 'consumer'}),
    createSpeechPorts: () => ({recognition: {}, output: {}, dispose: async () => { calls.push('dispose-ports'); }}),
    enabled: true, now: () => fixedNow});
  return {input, calls, ready, closed, get options() { return options; }};
}

test('explicit voice path waits for physical ready and release before ASR; playback stays explicit', async () => {
  const f = fixture();
  const pending = f.input.beginCapture(3);
  await Promise.resolve();
  assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === 'session-start'), false);
  f.ready.resolve();
  await pending;
  assert.equal(f.input.snapshot().status, 'listening');
  const captureDeadline = Date.parse(f.options.deadline);
  const sessionDeadline = Date.parse(f.calls.find(call => Array.isArray(call) && call[0] === 'session-start')[1]);
  assert.equal(captureDeadline - Date.parse('2026-09-25T00:00:00.000Z'), 60_000);
  assert.equal(sessionDeadline - captureDeadline, 9 * 60_000);
  assert.equal(f.calls.find(call => Array.isArray(call) && call[0] === 'buffer-deadline')[1], new Date(sessionDeadline).toISOString());
  f.options.onFrame({data: Uint8Array.of(1, 2)});
  const finishing = f.input.finishCapture(3);
  await Promise.resolve();
  assert.equal(f.calls.includes('unsubscribe'), true);
  assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === 'recognize'), false);
  f.closed.resolve();
  await finishing;
  assert.equal(f.input.snapshot().status, 'awaiting_speech');
  assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === 'speak'), false);
  await f.input.playReply(3);
  assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === 'speak'), true);
  assert.equal(f.calls.some(call => call === 'task.cancel'), false);
});

test('unconfirmed PCM release blocks recognition and reports failure', async () => {
  const f = fixture();
  const pending = f.input.beginCapture(4);
  f.ready.resolve();
  await pending;
  f.options.onFrame({data: Uint8Array.of(1, 2)});
  const finishing = f.input.finishCapture(4);
  f.closed.reject(Error('track stop failed'));
  await assert.rejects(finishing, /麦克风释放未确认/);
  assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === 'recognize'), false);
});

test('capture deadline finalizes audio while the session keeps time for ASR and Runtime', async () => {
  const f = fixture();
  const pending = f.input.beginCapture(5);
  f.ready.resolve();
  await pending;
  f.options.onFrame({data: Uint8Array.of(1, 2)});
  f.options.onEnd('deadline');
  f.closed.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === 'recognize'), true);
  assert.equal(f.input.snapshot().status, 'awaiting_speech');
});

test('beginWakeCapture reuses active authorized capture without re-authorizing', async () => {
  const f = fixture();
  // Override microphoneHost to simulate wake-active capture (authorized, active, subscriberCount > 0)
  f.input._microphoneHost = undefined; // no direct access needed; the fixture already has it
  const wakeFixture = fixture();
  // Create a new fixture with microphoneHost that reports authorized+active+subscriberCount>0
  const calls2 = [];
  const fixedNow2 = Date.parse('2026-09-25T00:00:00.000Z');
  const ready2 = deferred();
  const closed2 = deferred();
  let options2;
  const subscription2 = {ready: ready2.promise, closed: closed2.promise,
    unsubscribe: () => { calls2.push('unsubscribe'); }};
  const source2 = {subscribe: value => { calls2.push('subscribe'); options2 = value; return subscription2; },
    dispose: async () => { calls2.push('dispose-source'); }};
  const microphoneHost2 = {authorize: () => { calls2.push('authorize'); },
    snapshot: () => ({authorized: true, active: true, subscriberCount: 1}),
    revoke: async () => { calls2.push('revoke'); }};
  class Manager2 {
    async start(options) { calls2.push(['session-start', options.deadline]); return {sessionId: 'session-w1'}; }
    current() { return {sessionId: 'session-w1', state: 'listening', revision: 1}; }
    async stop() { calls2.push('session-stop'); }
  }
  const input2 = createDesktopVoiceInputCore({source: source2, microphoneHost: microphoneHost2, client: {call: () => {}},
    createBuffer: opts => {
      const data = [];
      return {append: chunk => data.push(...chunk),
        finish: () => ({data: Uint8Array.from(data), format: {encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1}, durationMs: 0}),
        dispose: () => {}};
    },
    VoiceSessionManager: Manager2, createConsumer: () => ({}),
    createSpeechPorts: () => ({recognition: {}, output: {}, dispose: async () => {}}),
    enabled: true, now: () => fixedNow2});

  const pending = input2.beginWakeCapture(7);
  // authorize must NOT be called — wake capture reuses existing authorization
  assert.equal(calls2.includes('authorize'), false, 'authorize must not be called for wake capture');
  assert.equal(calls2.includes('subscribe'), true, 'source.subscribe must be called');
  ready2.resolve();
  await pending;
  assert.equal(input2.snapshot().status, 'listening');

  // Cleanup: subscriberCount=1 means this is the wake subscriber, so revoke should not be called
  // (existing cleanup checks subscriberCount === 0 before revoking)
});

test('beginWakeCapture rejects when capture is not wake-authorized', async () => {
  const calls3 = [];
  const fixedNow3 = Date.parse('2026-09-25T00:00:00.000Z');
  const source3 = {subscribe: () => ({}), dispose: async () => {}};
  const microphoneHost3 = {authorize: () => {}, snapshot: () => ({authorized: false, active: false, subscriberCount: 0}),
    revoke: async () => {}};
  class Manager3 { async start() { return {}; } current() {} async stop() {} }
  const input3 = createDesktopVoiceInputCore({source: source3, microphoneHost: microphoneHost3, client: {call: () => {}},
    createBuffer: () => ({append: () => {}, finish: () => ({}), dispose: () => {}}),
    VoiceSessionManager: Manager3, createConsumer: () => ({}),
    createSpeechPorts: () => ({recognition: {}, output: {}, dispose: async () => {}}),
    enabled: true, now: () => fixedNow3});
  await assert.rejects(() => input3.beginWakeCapture(8), /语音唤醒采集未就绪/);
});
