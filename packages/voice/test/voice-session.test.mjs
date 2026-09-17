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

test('subscriptions deliver frozen isolated snapshots and contain listener failures', async () => {
  const manager = new VoiceSessionManager({idFactory: ids()});
  const first = [];
  const second = [];
  manager.subscribe(snapshot => {
    first.push(snapshot);
    assert.equal(Reflect.set(snapshot, 'state', 'corrupted'), false);
    throw Error('private-listener-message');
  });
  manager.subscribe(snapshot => { second.push(snapshot); });

  const session = await manager.start({deadline: futureDeadline(), signal: new AbortController().signal});
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.notEqual(first[0], second[0]);
  assert.equal(Object.isFrozen(first[0]), true);
  assert.equal(Object.isFrozen(second[0]), true);
  assert.equal(second[0].state, 'listening');
  assert.equal(manager.current().state, 'listening');
  await manager.stop(session.sessionId);
});

test('unsubscribe is idempotent and subscriptions added during delivery start on the next update', async () => {
  const recognition = new FakeSpeechRecognitionPort(() => ({text: 'next update'}));
  const manager = new VoiceSessionManager({recognition, idFactory: ids()});
  let firstCalls = 0;
  let lateCalls = 0;
  let unsubscribeFirst = () => {};
  let unsubscribeLate = () => {};
  unsubscribeFirst = manager.subscribe(() => {
    firstCalls++;
    unsubscribeFirst();
    unsubscribeLate = manager.subscribe(() => { lateCalls++; });
  });

  const session = await manager.start({deadline: futureDeadline(), signal: new AbortController().signal});
  assert.equal(firstCalls, 1);
  assert.equal(lateCalls, 0);
  await manager.recognizeAudio(session.sessionId, clip());
  assert.equal(firstCalls, 1);
  assert.equal(lateCalls, 2);
  unsubscribeFirst();
  unsubscribeLate();
  unsubscribeLate();
  await manager.stop(session.sessionId);
  assert.equal(lateCalls, 2);
});

test('subscriptions publish consistent playback and terminal snapshots exactly once per revision', async () => {
  let finishPlayback;
  let playbackStarted;
  const ready = new Promise(resolve => { playbackStarted = resolve; });
  const recognition = new FakeSpeechRecognitionPort(() => ({text: '播放回复'}));
  const consumer = new FakeTranscriptConsumerPort(() => ({replyText: '合成播报'}));
  const output = new FakeSpeechOutputPort(() => {
    playbackStarted();
    return new Promise(resolve => { finishPlayback = resolve; });
  });
  const manager = new VoiceSessionManager({recognition, output, idFactory: ids()});
  const snapshots = [];
  manager.subscribe(snapshot => { snapshots.push(snapshot); });

  const session = await manager.start({deadline: futureDeadline(), signal: new AbortController().signal});
  const transcript = await manager.recognizeAudio(session.sessionId, clip());
  const reply = await manager.consumeTranscript(session.sessionId, transcript.transcriptId, consumer);
  const speaking = manager.speakReply(session.sessionId, reply.replyId);
  await ready;
  assert.deepEqual(
    snapshots.map(snapshot => [snapshot.state, snapshot.playbackActive, snapshot.revision]),
    [
      ['listening', false, 0],
      ['recognizing', false, 1],
      ['awaiting_consume', false, 2],
      ['consuming', false, 3],
      ['awaiting_speech', false, 4],
      ['speaking', true, 5],
    ],
  );

  await manager.stopSpeaking(session.sessionId);
  assert.deepEqual(await speaking, {sessionId: session.sessionId, completed: false, interrupted: true});
  assert.deepEqual(
    [snapshots.at(-1).state, snapshots.at(-1).playbackActive, snapshots.at(-1).revision],
    ['listening', false, 6],
  );
  const stopped = await manager.stop(session.sessionId);
  assert.equal(stopped.resourcesReleased, true);
  assert.deepEqual(
    {
      state: snapshots.at(-1).state,
      playbackActive: snapshots.at(-1).playbackActive,
      revision: snapshots.at(-1).revision,
      terminalReason: snapshots.at(-1).terminalReason,
      transcriptReady: snapshots.at(-1).transcriptReady,
      replyReady: snapshots.at(-1).replyReady,
    },
    {
      state: 'stopped',
      playbackActive: false,
      revision: 7,
      terminalReason: 'user',
      transcriptReady: false,
      replyReady: false,
    },
  );
  finishPlayback();
});
