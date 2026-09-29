import assert from 'node:assert/strict';
import {test} from 'node:test';
import {VoiceSessionManager} from '../dist/voice-session.js';
import {VOICE_AUDIO_FORMAT} from '../dist/ports.js';

const options = () => ({deadline: new Date(Date.now() + 5000).toISOString(), signal: new AbortController().signal});
const clip = () => ({data: new Uint8Array(320), format: VOICE_AUDIO_FORMAT, durationMs: 10});
const done = value => ({result: Promise.resolve(value), async stop() {}});
const failure = () => Promise.reject(Error('private provider release details'));
const isReleaseFailure = error => error.code === 'EXTERNAL_FAILURE'
  && error.message === 'Voice operation resource release failed';
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
};

for (const kind of ['recognition', 'consumption', 'playback']) {
  test(`a failed ${kind} release rejects completion and prevents a new session`, async t => {
    let releases = 0;
    let consumerCalls = 0;
    const operation = (operationKind, value) => ({result: Promise.resolve(value), stop() {
      if (operationKind === kind) { releases++; return failure(); }
      return Promise.resolve();
    }});
    const manager = new VoiceSessionManager({
      recognition: {recognize: () => operation('recognition', {text: 'synthetic transcript'})},
      output: {speak: () => operation('playback', undefined)},
    });
    t.after(async () => { const current = manager.current(); if(current) await manager.stop(current.sessionId); });
    const first = await manager.start(options());
    const consumer = {consume() { consumerCalls++; return operation('consumption', {replyText: 'synthetic reply'}); }};
    let transcript;
    let reply;
    if (kind !== 'recognition') transcript = await manager.recognizeAudio(first.sessionId, clip());
    if (kind === 'playback') reply = await manager.consumeTranscript(first.sessionId, transcript.transcriptId, consumer);
    const work = kind === 'recognition' ? manager.recognizeAudio(first.sessionId, clip())
      : kind === 'consumption' ? manager.consumeTranscript(first.sessionId, transcript.transcriptId, consumer)
      : manager.speakReply(first.sessionId, reply.replyId);
    await assert.rejects(work, isReleaseFailure);
    assert.equal(releases, 1);
    assert.equal(consumerCalls, kind === 'recognition' ? 0 : 1);
    const stopped = await manager.stop(first.sessionId);
    assert.equal(stopped.resourcesReleased, false);
    assert.equal((await manager.stopSpeaking(first.sessionId)).resourcesReleased, false);
    await assert.rejects(manager.start(options()), isReleaseFailure);
    assert.equal(manager.current().sessionId, first.sessionId);
    assert.equal(releases, 1);
  });
}

test('replacement does not publish a new session when previous cleanup fails', async t => {
  let releases = 0;
  const manager = new VoiceSessionManager({recognition: {recognize() {
    return {result: new Promise(() => {}), stop() { releases++; return failure(); }};
  }}});
  t.after(async () => { const current = manager.current(); if(current) await manager.stop(current.sessionId); });
  const first = await manager.start(options());
  const reading = manager.recognizeAudio(first.sessionId, clip()).catch(error => error);
  await assert.rejects(manager.start(options()), isReleaseFailure);
  await reading;
  assert.equal(manager.current().sessionId, first.sessionId);
  assert.equal((await manager.stop(first.sessionId)).resourcesReleased, false);
  assert.equal(releases, 1);
});

test('successful cleanup retains the normal explicit recognition/consumption/playback flow', async () => {
  const manager = new VoiceSessionManager({recognition: {recognize: () => done({text: 'synthetic transcript'})},
    output: {speak: () => done(undefined)}});
  const first = await manager.start(options());
  const transcript = await manager.recognizeAudio(first.sessionId, clip());
  const reply = await manager.consumeTranscript(first.sessionId, transcript.transcriptId,
    {consume: () => done({replyText: 'synthetic reply'})});
  assert.equal((await manager.speakReply(first.sessionId, reply.replyId)).completed, true);
  const next = await manager.start(options());
  assert.notEqual(next.sessionId, first.sessionId);
  assert.equal((await manager.stop(next.sessionId)).resourcesReleased, true);
});

test('a ready-state listener cannot consume before recognition release is confirmed', async t => {
  const release = deferred();
  let consumptionCalls = 0;
  let readyNotifications = 0;
  const manager = new VoiceSessionManager({recognition: {recognize: () => ({
    result: Promise.resolve({text: 'synthetic transcript'}), stop: () => release.promise,
  })}});
  t.after(async () => {
    release.resolve();
    const current = manager.current();
    if (current) await manager.stop(current.sessionId);
  });
  manager.subscribe(snapshot => {
    if (snapshot.state === 'awaiting_consume') readyNotifications++;
  });
  const first = await manager.start(options());
  const reading = manager.recognizeAudio(first.sessionId, clip());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(readyNotifications, 0);
  assert.equal(manager.current().state, 'recognizing');
  release.resolve();
  const transcript = await reading;
  assert.equal(readyNotifications, 1);
  await manager.consumeTranscript(first.sessionId, transcript.transcriptId,
    {consume() { consumptionCalls++; return done({replyText: 'synthetic reply'}); }});
  assert.equal(consumptionCalls, 1);
});

test('interrupt and operation finally continue to share one stop and its first reason', async t => {
  const release = deferred();
  const playback = deferred();
  const reasons = [];
  const manager = new VoiceSessionManager({recognition: {recognize: () => done({text: 'synthetic transcript'})},
    output: {speak: () => ({result: playback.promise,
      stop(reason) { reasons.push(reason); return release.promise; }})}});
  t.after(async () => {
    release.resolve();
    playback.resolve();
    const current = manager.current();
    if (current) await manager.stop(current.sessionId);
  });
  const first = await manager.start(options());
  const transcript = await manager.recognizeAudio(first.sessionId, clip());
  const reply = await manager.consumeTranscript(first.sessionId, transcript.transcriptId,
    {consume: () => done({replyText: 'synthetic reply'})});
  const speaking = manager.speakReply(first.sessionId, reply.replyId);
  const interrupting = manager.stopSpeaking(first.sessionId);
  // Let speakReply observe the interruption before the independent full-session
  // stop; it must still be awaiting the same delayed release at that point.
  await new Promise(resolve => setImmediate(resolve));
  const duplicate = manager.stopSpeaking(first.sessionId);
  const stopping = manager.stop(first.sessionId);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(reasons, ['interrupted']);
  release.resolve();
  assert.equal((await interrupting).resourcesReleased, true);
  assert.equal((await duplicate).resourcesReleased, true);
  assert.equal((await stopping).resourcesReleased, true);
  assert.deepEqual(await speaking, {sessionId: first.sessionId, completed: false, interrupted: true});
  assert.deepEqual(reasons, ['interrupted']);
});
