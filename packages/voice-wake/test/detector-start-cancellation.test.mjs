import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createPcmKeywordWakeSignalSource} from '../dist/pcm-keyword-source.js';

for (const readyImmediately of [false, true]) {
  test(`cancellation within detector.start releases its returned handle (ready=${readyImmediately})`, async () => {
    const controller = new AbortController();
    let stops = 0;
    let captureStarts = 0;
    let notifyDetected;
    let finishReady;
    let finishClosed;
    const closed = new Promise(resolve => { finishClosed = resolve; });
    const ready = readyImmediately ? Promise.resolve() : new Promise(resolve => { finishReady = resolve; });
    const events = [];
    const source = createPcmKeywordWakeSignalSource({
      subscribe() { captureStarts++; throw new Error('capture must not start'); },
    }, {
      start({onDetected}) {
        notifyDetected = onDetected;
        // Host revocation can occur before the synchronous start call returns.
        controller.abort();
        return {ready, closed, accept() {}, stop() { stops++; finishClosed(); }};
      },
    });
    try {
      await assert.rejects(source.subscribe(event => events.push(event), {
        signal: controller.signal, deadlineAtMs: Date.now() + 10_000,
      }), {message: 'Wake PCM source unavailable'});
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(stops, 1, 'the late detector handle must be stopped exactly once');
      assert.equal(captureStarts, 0);
      finishReady?.();
      notifyDetected();
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(events, []);
      assert.equal(stops, 1);
    } finally {
      finishReady?.();
      finishClosed();
    }
  });
}
