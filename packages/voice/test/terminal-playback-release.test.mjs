import assert from 'node:assert/strict';
import {test} from 'node:test';
import {VoiceSessionManager} from '../dist/voice-session.js';
import {VOICE_AUDIO_FORMAT} from '../dist/ports.js';

for (const releaseFails of [false, true]) {
  test(`terminal stopSpeaking waits for ${releaseFails ? 'failed' : 'confirmed'} release`, async () => {
    let release;
    const releaseGate = new Promise(resolve => { release = resolve; });
    const stopReasons = [];
    const manager = new VoiceSessionManager({
      recognition: {recognize: () => ({result: Promise.resolve({text: 'synthetic transcript'}),
        stop: async () => {}})},
      output: {speak: () => ({result: new Promise(() => {}), async stop(reason) {
        stopReasons.push(reason);
        await releaseGate;
        if (releaseFails) throw new Error('synthetic private release error');
      }})},
    });
    const session = await manager.start({deadline: new Date(Date.now() + 10_000).toISOString(),
      signal: new AbortController().signal});
    let speaking;
    let stopping;
    let terminalStop;
    try {
      const transcript = await manager.recognizeAudio(session.sessionId,
        {data: new Uint8Array(32), format: VOICE_AUDIO_FORMAT, durationMs: 1});
      const reply = await manager.consumeTranscript(session.sessionId, transcript.transcriptId,
        {consume: () => ({result: Promise.resolve({replyText: 'synthetic reply'}), stop: async () => {}})});
      speaking = manager.speakReply(session.sessionId, reply.replyId).catch(error => error.code);
      assert.equal(manager.current().state, 'speaking');
      stopping = manager.stop(session.sessionId);
      assert.equal(manager.current().state, 'stopped');
      let settled = false;
      terminalStop = manager.stopSpeaking(session.sessionId).then(result => { settled = true; return result; });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(settled, false, 'terminal state alone is not proof of resource release');
      assert.deepEqual(stopReasons, ['user']);
      release();
      const [stopped, result] = await Promise.all([stopping, terminalStop]);
      assert.equal(stopped.resourcesReleased, !releaseFails);
      assert.deepEqual(result, {sessionId: session.sessionId, playbackStopped: false,
        resourcesReleased: !releaseFails});
      assert.deepEqual(await manager.stopSpeaking(session.sessionId), result);
      assert.equal(await speaking, 'CANCELLED');
      assert.deepEqual(stopReasons, ['user']);
    } finally {
      release();
      await manager.stop(session.sessionId);
      await Promise.allSettled([speaking, stopping, terminalStop]);
    }
  });
}
