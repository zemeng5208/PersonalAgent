import assert from 'node:assert/strict';
import test from 'node:test';

import {FakeSpeechOutputPort, FakeSpeechRecognitionPort} from '@personal-agent/voice/testing';
import {createDesktopVoiceInput} from '../electron/voice-input.js';

test('Desktop voice host keeps permission and receipts in the trusted process', async () => {
  const submitted = [];
  const client = {
    async call(operation, input) {
      if (operation === 'task.submit') {
        submitted.push(input.goal);
        return {taskId: 'task-voice-1'};
      }
      if (operation === 'task.get') return {taskId: 'task-voice-1', state: 'succeeded', resultSummary: '你好，我在。'};
      throw Error('unexpected operation');
    },
  };
  const recognition = new FakeSpeechRecognitionPort(() => ({text: '你好', locale: 'zh-CN'}));
  const output = new FakeSpeechOutputPort();
  const host = createDesktopVoiceInput({client, recognition, output});

  assert.equal(host.snapshot().captureAvailable, true);
  await host.beginCapture(17);
  assert.equal(host.checkMediaPermission(17, {mediaTypes: ['audio']}), true);
  assert.equal(host.checkMediaPermission(17, {mediaTypes: ['audio', 'video']}), false);
  assert.equal(host.consumeMediaPermission(17, {mediaTypes: ['audio']}), true);
  assert.equal(host.checkMediaPermission(17, {mediaTypes: ['audio']}), false);

  const audio = new Uint8Array(3_200);
  await host.finishCapture(17, {audio});
  assert.ok(audio.every(value => value === 0));
  assert.deepEqual(submitted, ['你好']);
  assert.equal(host.snapshot().session.replyReady, true);
  assert.equal('sessionId' in host.snapshot().session, false);

  const played = await host.playReply(17);
  assert.equal(played.completed, true);
  assert.equal(output.calls.length, 1);
  await host.dispose();
});

test('Desktop voice host fails closed without an injected recognizer', async () => {
  const host = createDesktopVoiceInput({client: {call: async () => { throw Error('unused'); }}});
  assert.equal(host.snapshot().status, 'unavailable');
  await assert.rejects(host.beginCapture(4), /语音供应商尚未连接/);
  assert.equal(host.consumeMediaPermission(4, {mediaTypes: ['audio']}), false);
  await host.dispose();
});
