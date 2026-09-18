import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {test} from 'node:test';
import {VOICE_AUDIO_FORMAT} from '../dist/index.js';
import {createWindowsSystemSpeechPortsForTesting} from '../dist/windows-system-speech.js';

const cleanupFailure = {code: 'EXTERNAL_FAILURE', message: 'Windows speech helper cleanup was not confirmed'};

for (const mode of ['cancel-return-false', 'deadline-throw']) {
  test(`helper cleanup is bounded and fail closed: ${mode}`, async t => {
    t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: Date.parse('2026-09-18T00:00:00.000Z')});
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let kills = 0;
    let spawns = 0;
    child.kill = () => {
      kills++;
      if (mode === 'deadline-throw') throw new Error('synthetic-private-kill-error');
      return false;
    };
    const ports = createWindowsSystemSpeechPortsForTesting(() => { spawns++; return child; });
    const parent = new AbortController();
    const request = () => ({sessionId: 'fixture', audio: Uint8Array.of(1, 2, 3, 4),
      format: VOICE_AUDIO_FORMAT, durationMs: 1, locale: 'zh-CN',
      deadline: new Date(Date.now() + 100).toISOString(), signal: parent.signal});
    const operation = ports.recognition.recognize(request());
    const resultCheck = assert.rejects(operation.result, {
      code: mode === 'deadline-throw' ? 'TIMEOUT' : 'CANCELLED',
    });
    if (mode === 'deadline-throw') t.mock.timers.tick(100);
    else parent.abort();
    await resultCheck;
    assert.equal(kills, 1);
    const stop = operation.stop('user');
    assert.strictEqual(operation.stop('user'), stop, 'stop must share its release result');
    const stopCheck = assert.rejects(stop, cleanupFailure);
    t.mock.timers.tick(2_000);
    await stopCheck;

    const fresh = {...request(), signal: new AbortController().signal};
    await assert.rejects(ports.recognition.recognize(fresh).result, cleanupFailure);
    assert.equal(spawns, 1, 'no replacement process while cleanup is unconfirmed');
    const disposed = ports.dispose();
    await assert.rejects(disposed, cleanupFailure);
    assert.strictEqual(ports.dispose(), disposed, 'dispose must not turn prior cleanup failure into success');

    // Late output/close may release the tracked child, never revive its result.
    child.stdout.write(JSON.stringify({ok: true, text: 'late synthetic text', locale: 'zh-CN'}));
    child.emit('close', 0, null);
    await assert.rejects(operation.result, {code: mode === 'deadline-throw' ? 'TIMEOUT' : 'CANCELLED'});
    await assert.rejects(ports.dispose(), cleanupFailure);
    assert.equal(kills, 1);
    assert.equal(spawns, 1);
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
  });
}
