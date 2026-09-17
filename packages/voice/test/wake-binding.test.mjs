import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
  VOICE_AUDIO_FORMAT,
  VoiceSessionManager,
  bindVoiceWake,
} from '../dist/index.js';
import {
  FakeSpeechOutputPort,
  FakeSpeechRecognitionPort,
  FakeTranscriptConsumerPort,
} from '../dist/testing.js';
import {
  WakeLifecycleController,
} from '@personal-agent/voice-wake';
import {
  FakeWakeAuthorization,
  FakeWakeClock,
  FakeWakeSource,
} from '@personal-agent/voice-wake/testing';

const flush = () => new Promise(resolve => setImmediate(resolve));
const clip = () => ({
  data: new Uint8Array([1, 2, 3]),
  format: VOICE_AUDIO_FORMAT,
  durationMs: 1,
});

function createComposition(options = {}) {
  const now = Date.now();
  const expiresAtMs = now + (options.durationMs ?? 10_000);
  const clock = new FakeWakeClock(now);
  const source = new FakeWakeSource();
  const authorization = new FakeWakeAuthorization({expiresAtMs});
  let voiceIdCount = 0;
  const voice = options.voice ?? new VoiceSessionManager({
    ...(options.voiceOptions ?? {}),
    idFactory: kind => `${kind}-${++voiceIdCount}`,
  });
  let binding;
  let wakeCallbacks = 0;
  const wake = new WakeLifecycleController({
    authorization,
    source,
    clock,
    onWake: event => {
      wakeCallbacks++;
      binding.handleWake(event);
    },
  });
  binding = bindVoiceWake({wake, voice});
  return {
    authorization,
    binding,
    clock,
    expiresAtMs,
    get voiceIdCount() { return voiceIdCount; },
    get wakeCallbacks() { return wakeCallbacks; },
    source,
    voice,
    wake,
  };
}

test('an authorized wake starts one voice session with a finite mapped deadline and separate IDs', async () => {
  const context = createComposition();
  const enabled = await context.wake.enable({deadlineAtMs: context.expiresAtMs});
  assert.equal(enabled.kind, 'listening');

  context.source.emit({kind: 'wake'});
  await flush();
  const voice = context.voice.current();
  assert.equal(voice.state, 'listening');
  assert.equal(voice.deadline, new Date(context.expiresAtMs).toISOString());
  assert.equal(typeof enabled.sessionId, 'number');
  assert.equal(typeof voice.sessionId, 'string');
  assert.notEqual(voice.sessionId, String(enabled.sessionId));

  context.source.emit({kind: 'wake'});
  await flush();
  assert.equal(context.wakeCallbacks, 2);
  assert.equal(context.voiceIdCount, 1);
  assert.equal(context.voice.current().sessionId, voice.sessionId);

  context.binding.dispose();
  context.wake.dispose();
});

test('an externally stopped voice before start settlement does not leave the binding busy', async () => {
  const context = createComposition();
  await context.wake.enable({deadlineAtMs: context.expiresAtMs});
  context.source.emit({kind: 'wake'});
  const first = context.voice.current();
  assert.equal(first.state, 'listening');

  await context.voice.stop(first.sessionId);
  await flush();
  context.source.emit({kind: 'wake'});
  await flush();

  assert.equal(context.voiceIdCount, 2);
  assert.equal(context.voice.current().state, 'listening');
  assert.notEqual(context.voice.current().sessionId, first.sessionId);
  context.binding.dispose();
  context.wake.dispose();
});

test('authorization revocation and wake expiry abort the corresponding voice parent', async () => {
  for (const reason of ['revocation', 'expiry']) {
    const context = createComposition({durationMs: 5_000});
    await context.wake.enable({deadlineAtMs: context.expiresAtMs});
    context.source.emit({kind: 'wake'});
    await flush();
    assert.equal(context.voice.current().state, 'listening', reason);

    if (reason === 'revocation') context.authorization.revoke();
    else context.clock.advance(5_000);
    await flush();

    assert.equal(context.wake.snapshot().state, 'disabled', reason);
    assert.equal(context.voice.current().state, 'cancelled', reason);
    assert.equal(context.voice.current().terminalReason, 'cancelled', reason);
    context.binding.dispose();
    context.wake.dispose();
  }
});

test('voice playback is synchronized into wake suppression', async () => {
  let releasePlayback;
  const recognition = new FakeSpeechRecognitionPort(() => ({text: '唤醒后的指令'}));
  const consumer = new FakeTranscriptConsumerPort(() => ({replyText: '正在播报'}));
  const output = new FakeSpeechOutputPort(() => new Promise(resolve => { releasePlayback = resolve; }));
  const context = createComposition({voiceOptions: {recognition, output}});
  await context.wake.enable({deadlineAtMs: context.expiresAtMs});
  context.source.emit({kind: 'wake'});
  await flush();

  const session = context.voice.current();
  const transcript = await context.voice.recognizeAudio(session.sessionId, clip());
  const reply = await context.voice.consumeTranscript(session.sessionId, transcript.transcriptId, consumer);
  const speaking = context.voice.speakReply(session.sessionId, reply.replyId);
  await flush();
  assert.equal(context.wake.snapshot().playbackActive, true);

  context.source.emit({kind: 'wake'});
  assert.equal(context.wakeCallbacks, 1);

  await context.voice.stopSpeaking(session.sessionId);
  assert.deepEqual(await speaking, {sessionId: session.sessionId, completed: false, interrupted: true});
  assert.equal(context.wake.snapshot().playbackActive, false);
  releasePlayback();
  context.binding.dispose();
  context.wake.dispose();
});

class DeferredVoiceManager {
  listeners = new Set();
  starts = [];
  currentSnapshot = undefined;
  onStart = undefined;

  start(input) {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const call = {input, promise, resolve, reject};
    this.starts.push(call);
    this.onStart?.(call);
    return promise;
  }

  current() {
    return this.currentSnapshot;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.listeners.delete(listener);
    };
  }

  resolveStart(index, sessionId) {
    const call = this.starts[index];
    const snapshot = Object.freeze({
      sessionId,
      state: 'listening',
      revision: 0,
      startedAt: new Date().toISOString(),
      deadline: call.input.deadline,
      locale: 'zh-CN',
      transcriptReady: false,
      replyReady: false,
      playbackActive: false,
    });
    this.currentSnapshot = snapshot;
    for (const listener of [...this.listeners]) listener(snapshot);
    call.resolve(snapshot);
  }

  emit(snapshot) {
    this.currentSnapshot = snapshot;
    for (const listener of [...this.listeners]) listener(snapshot);
  }
}

test('synchronous disable and a late async start result cannot revive an old wake epoch', async () => {
  const voice = new DeferredVoiceManager();
  const context = createComposition({voice});
  voice.onStart = () => context.wake.disable();

  await context.wake.enable({deadlineAtMs: context.expiresAtMs});
  context.source.emit({kind: 'wake'});
  assert.equal(voice.starts.length, 1);
  assert.equal(voice.starts[0].input.signal.aborted, true);
  assert.equal(context.wake.snapshot().state, 'disabled');

  voice.resolveStart(0, 'late-old-voice');
  await flush();
  voice.onStart = undefined;
  await context.wake.enable({deadlineAtMs: context.expiresAtMs});
  context.source.emit({kind: 'wake'});
  assert.equal(voice.starts.length, 2);
  assert.equal(voice.starts[1].input.signal.aborted, false);
  voice.resolveStart(1, 'current-voice');
  await flush();

  context.wake.disable();
  assert.equal(voice.starts[1].input.signal.aborted, true);
  context.binding.dispose();
  context.wake.dispose();
});

test('dispose is idempotent, unbinds both feeds, and does not dispose caller-owned controllers', async () => {
  const voice = new DeferredVoiceManager();
  const context = createComposition({voice});
  await context.wake.enable({deadlineAtMs: context.expiresAtMs});
  context.source.emit({kind: 'wake'});
  assert.equal(voice.starts.length, 1);
  assert.equal(voice.listeners.size, 1);

  context.binding.dispose();
  context.binding.dispose();
  assert.equal(voice.starts[0].input.signal.aborted, true);
  assert.equal(voice.listeners.size, 0);
  assert.equal(context.wake.snapshot().state, 'listening');
  assert.equal(context.source.activeSubscriptions, 1);

  voice.emit({
    sessionId: 'unowned-voice', state: 'speaking', revision: 1,
    startedAt: new Date().toISOString(), deadline: new Date(context.expiresAtMs).toISOString(),
    locale: 'zh-CN', transcriptReady: false, replyReady: false, playbackActive: true,
  });
  assert.equal(context.wake.snapshot().playbackActive, false);
  context.source.emit({kind: 'wake'});
  assert.equal(voice.starts.length, 1);

  context.wake.dispose();
});
