import assert from 'node:assert/strict';
import test from 'node:test';
import {createDesktopVoiceWakeHost} from '../electron/voice-wake-host.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

for (const closureFails of [false, true]) {
  test(`revoke reaches the microphone before ${closureFails ? 'failed' : 'delayed'} wake closure`, async () => {
    const wakeClosed = deferred();
    const microphoneClosed = deferred();
    const releaseError = Error('synthetic wake release failure');
    let microphoneRevokes = 0;
    let captureAuthorized = true;
    let state = 'disabled';
    const expiresAtMs = Date.now() + 60_000;
    const host = createDesktopVoiceWakeHost({
      source: {}, detector: {}, enabled: true,
      microphoneHost: {
        snapshot: () => ({authorized: captureAuthorized}),
        revoke() {
          microphoneRevokes++;
          captureAuthorized = false;
          return microphoneClosed.promise;
        },
      },
      createPcmKeywordWakeSignalSource: () => ({
        subscribe: async () => ({unsubscribe() {}, closed: wakeClosed.promise}),
      }),
      createWakeLifecycleController: ({source, authorization}) => ({
        snapshot: () => ({state, sessionId: 1, expiresAtMs}),
        async enable(options) {
          assert.equal((await authorization.check(options)).kind, 'allowed');
          await source.subscribe(() => {}, options);
          state = 'listening';
          return {kind: 'listening', sessionId: 1, expiresAtMs};
        },
        disable() { state = 'disabled'; },
      }),
    });
    await host.enable({deadlineAtMs: expiresAtMs,
      lease: {expiresAtMs, revocationSignal: new AbortController().signal}});

    let settled = false;
    const outcome = host.revoke().then(
      value => { settled = true; return {value}; },
      error => { settled = true; return {error}; },
    );
    try {
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(microphoneRevokes, 1,
        'a pending wake close must not delay physical microphone revocation');
      assert.equal(captureAuthorized, false);
      assert.equal(settled, false, 'revocation must still await release confirmation');

      if (closureFails) wakeClosed.reject(releaseError);
      else wakeClosed.resolve();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(settled, false, 'microphone release confirmation remains required');
      microphoneClosed.resolve();
      const result = await outcome;
      if (closureFails) assert.equal(result.error, releaseError);
      else {
        assert.equal(result.error, undefined);
        assert.equal(result.value.capture.authorized, false);
      }
      assert.equal(microphoneRevokes, 1);
    } finally {
      // Complete only this test's deferred releases, including on a red assertion.
      wakeClosed.resolve();
      microphoneClosed.resolve();
      await outcome;
    }
  });
}
