import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  VOICE_AUDIO_FORMAT,
  VoiceSessionManager,
} from '../dist/index.js';
import {
  FakeSpeechOutputPort,
  FakeSpeechRecognitionPort,
  FakeTranscriptConsumerPort,
} from '../dist/testing.js';

const futureDeadline = (offsetMs = 10_000) => new Date(Date.now() + offsetMs).toISOString();
const clip = () => ({
  data: new Uint8Array([1, 2, 3, 4]),
  format: VOICE_AUDIO_FORMAT,
  durationMs: 1,
});
const ids = () => {
  let value = 0;
  return kind => `${kind}-${++value}`;
};

test('Fake recognition requires explicit consumption before a reply can be spoken', async () => {
  const recognition = new FakeSpeechRecognitionPort(() => ({text: '查询明天天气', locale: 'zh-CN'}));
  const consumer = new FakeTranscriptConsumerPort(request => ({replyText: `已收到${request.text.length}个字符`}));
  const output = new FakeSpeechOutputPort();
  const manager = new VoiceSessionManager({recognition, output, idFactory: ids()});
  const session = await manager.start({deadline: futureDeadline(), signal: new AbortController().signal});

  const transcript = await manager.recognizeAudio(session.sessionId, clip());
  assert.equal(manager.current().state, 'awaiting_consume');
  assert.equal(consumer.calls.length, 0);
  assert.equal(output.calls.length, 0);

  const reply = await manager.consumeTranscript(session.sessionId, transcript.transcriptId, consumer);
  assert.equal(consumer.calls.length, 1);
  assert.equal(manager.current().state, 'awaiting_speech');
  assert.equal(output.calls.length, 0);

  assert.deepEqual(await manager.speakReply(session.sessionId, reply.replyId), {
    sessionId: session.sessionId,
    completed: true,
    interrupted: false,
  });
  assert.equal(output.calls.length, 1);
  assert.equal(manager.current().state, 'listening');
  const stopped = await manager.stop(session.sessionId);
  assert.equal(stopped.resourcesReleased, true);
  assert.equal(recognition.activeOperations + consumer.activeOperations + output.activeOperations, 0);
});

test('stopSpeaking interrupts playback without cancelling or aborting the transcript consumer', async () => {
  let finishPlayback;
  let playbackStarted;
  const ready = new Promise(resolve => { playbackStarted = resolve; });
  const recognition = new FakeSpeechRecognitionPort(() => ({text: '继续任务'}));
  let consumerSignal;
  const consumer = new FakeTranscriptConsumerPort(request => {
    consumerSignal = request.signal;
    return {replyText: '正在继续'};
  });
  const output = new FakeSpeechOutputPort(() => {
    playbackStarted();
    return new Promise(resolve => { finishPlayback = resolve; });
  });
  const manager = new VoiceSessionManager({recognition, output, idFactory: ids()});
  const session = await manager.start({deadline: futureDeadline(), signal: new AbortController().signal});
  const transcript = await manager.recognizeAudio(session.sessionId, clip());
  const reply = await manager.consumeTranscript(session.sessionId, transcript.transcriptId, consumer);
  const speaking = manager.speakReply(session.sessionId, reply.replyId);
  await ready;

  assert.deepEqual(await manager.stopSpeaking(session.sessionId), {
    sessionId: session.sessionId,
    playbackStopped: true,
    resourcesReleased: true,
  });
  assert.deepEqual(await speaking, {sessionId: session.sessionId, completed: false, interrupted: true});
  assert.equal(consumer.calls.length, 1);
  assert.equal(consumerSignal.aborted, false);
  assert.equal(manager.current().state, 'listening');
  finishPlayback();
  await manager.stop(session.sessionId);
});

test('cancellation stops recognition, prevents downstream calls and makes repeated stop idempotent', async () => {
  let recognitionStarted;
  const ready = new Promise(resolve => { recognitionStarted = resolve; });
  const recognition = new FakeSpeechRecognitionPort(() => {
    recognitionStarted();
    return new Promise(() => {});
  });
  const consumer = new FakeTranscriptConsumerPort(() => ({replyText: 'unused'}));
  const output = new FakeSpeechOutputPort();
  const parent = new AbortController();
  const manager = new VoiceSessionManager({recognition, output, idFactory: ids()});
  const session = await manager.start({deadline: futureDeadline(), signal: parent.signal});
  const pending = manager.recognizeAudio(session.sessionId, clip());
  await ready;
  parent.abort();

  await assert.rejects(pending, {code: 'CANCELLED'});
  const first = await manager.stop(session.sessionId);
  const second = await manager.stop(session.sessionId);
  assert.deepEqual(second, first);
  assert.equal(first.state, 'cancelled');
  assert.equal(first.resourcesReleased, true);
  assert.equal(recognition.activeOperations, 0);
  assert.equal(consumer.calls.length, 0);
  assert.equal(output.calls.length, 0);
});

test('deadline aborts transcript consumption, prevents speech and releases the operation', async () => {
  let consumptionStarted;
  const ready = new Promise(resolve => { consumptionStarted = resolve; });
  const recognition = new FakeSpeechRecognitionPort(() => ({text: '私密识别文本'}));
  const consumer = new FakeTranscriptConsumerPort(() => {
    consumptionStarted();
    return new Promise(() => {});
  });
  const output = new FakeSpeechOutputPort();
  const manager = new VoiceSessionManager({recognition, output, idFactory: ids()});
  const session = await manager.start({deadline: futureDeadline(120), signal: new AbortController().signal});
  const transcript = await manager.recognizeAudio(session.sessionId, clip());
  const pending = manager.consumeTranscript(session.sessionId, transcript.transcriptId, consumer);
  await ready;

  await assert.rejects(pending, {code: 'TIMEOUT'});
  assert.equal(manager.current().state, 'expired');
  assert.equal(consumer.activeOperations, 0);
  assert.equal(output.calls.length, 0);
});

test('a late callback from a replaced session cannot publish a transcript into the new session', async () => {
  let finishFirst;
  let firstStarted;
  const ready = new Promise(resolve => { firstStarted = resolve; });
  const recognition = new FakeSpeechRecognitionPort(request => {
    if (request.sessionId === 'session-1') {
      firstStarted();
      return new Promise(resolve => { finishFirst = resolve; });
    }
    return {text: 'new'};
  });
  const manager = new VoiceSessionManager({recognition, idFactory: ids()});
  const first = await manager.start({deadline: futureDeadline(), signal: new AbortController().signal});
  const pending = manager.recognizeAudio(first.sessionId, clip());
  await ready;
  const second = await manager.start({deadline: futureDeadline(), signal: new AbortController().signal});
  finishFirst({text: 'late private text'});

  await assert.rejects(pending, {code: 'STALE_SESSION'});
  assert.equal(manager.current().sessionId, second.sessionId);
  assert.equal(manager.current().state, 'listening');
  assert.equal(manager.current().transcriptReady, false);
  assert.equal(recognition.activeOperations, 0);
  await manager.stop(second.sessionId);
});

test('missing providers remain explicitly unavailable and provider errors are sanitized', async () => {
  const manager = new VoiceSessionManager({idFactory: ids()});
  const session = await manager.start({deadline: futureDeadline(), signal: new AbortController().signal});
  await assert.rejects(manager.recognizeAudio(session.sessionId, clip()), error => {
    assert.equal(error.code, 'UNSUPPORTED_CAPABILITY');
    assert.equal(error.message, 'Speech recognition is unavailable');
    return true;
  });
  await manager.stop(session.sessionId);

  const failing = new VoiceSessionManager({
    recognition: new FakeSpeechRecognitionPort(() => { throw Error('raw-private-audio-and-transcript'); }),
    idFactory: ids(),
  });
  const failingSession = await failing.start({deadline: futureDeadline(), signal: new AbortController().signal});
  await assert.rejects(failing.recognizeAudio(failingSession.sessionId, clip()), error => {
    assert.equal(error.code, 'EXTERNAL_FAILURE');
    assert.equal(error.message, 'Speech recognition failed');
    assert.equal(error.message.includes('raw-private'), false);
    return true;
  });
  await failing.stop(failingSession.sessionId);
});
