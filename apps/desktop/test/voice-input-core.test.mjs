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
    async start() { calls.push('session-start'); return {sessionId: 'session-1'}; }
    current() { return {sessionId: 'session-1', state: 'listening', revision: 1}; }
    async recognizeAudio(_id, clip) { calls.push(['recognize', [...clip.data]]); return {transcriptId: 'transcript-1'}; }
    async consumeTranscript(_id, receipt, consumer) { calls.push(['consume', receipt, consumer]); return {replyId: 'reply-1'}; }
    async speakReply(_id, receipt) { calls.push(['speak', receipt]); return {completed: true, interrupted: false}; }
    async stop() { calls.push('session-stop'); }
    async stopSpeaking() { calls.push('stop-speaking'); return {playbackStopped: true, resourcesReleased: true}; }
  }
  const input = createDesktopVoiceInputCore({source, microphoneHost, client: {call: () => {}},
    createBuffer: () => {
      const data = [];
      return {append: chunk => { calls.push('append'); data.push(...chunk); },
        finish: () => { calls.push('finish-buffer'); return {data: Uint8Array.from(data),
          format: {encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1}, durationMs: data.length / 32}; },
        dispose: () => { calls.push('dispose-buffer'); }};
    },
    VoiceSessionManager: Manager, createConsumer: () => ({kind: 'consumer'}),
    createSpeechPorts: () => ({recognition: {}, output: {}, dispose: async () => { calls.push('dispose-ports'); }}),
    enabled: true});
  return {input, calls, ready, closed, get options() { return options; }};
}

test('explicit voice path waits for physical ready and release before ASR; playback stays explicit', async () => {
  const f = fixture();
  const pending = f.input.beginCapture(3);
  await Promise.resolve();
  assert.equal(f.calls.includes('session-start'), false);
  f.ready.resolve();
  await pending;
  assert.equal(f.input.snapshot().status, 'listening');
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
