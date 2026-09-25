import assert from 'node:assert/strict';
import test from 'node:test';
import {createDesktopVoiceWakeHost} from '../electron/voice-wake-host.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

function createFixture({enabled = true, onWake} = {}) {
  const calls = [];
  const fixedNow = Date.parse('2026-09-25T00:00:00.000Z');

  const pcmReady = deferred();
  const pcmClosed = deferred();
  const pcmSubscription = {
    ready: pcmReady.promise, closed: pcmClosed.promise,
    unsubscribe: () => { calls.push('pcm:unsubscribe'); pcmClosed.resolve(); },
  };
  const pcmSource = {
    subscribe: opts => { calls.push('pcm:subscribe'); return pcmSubscription; },
    dispose: async () => { calls.push('pcm:dispose'); },
  };

  const detectorReady = deferred();
  const detectorClosed = deferred();
  let detectorOpts;
  const detectorSession = {
    ready: detectorReady.promise, closed: detectorClosed.promise,
    accept: () => {},
    stop: async () => { calls.push('detector:stop'); detectorClosed.resolve(); },
  };
  const detector = {
    start: opts => { calls.push('detector:start'); detectorOpts = opts; return detectorSession; },
  };

  const wakeSourceClosed = deferred();
  const makeWakeSignalSource = (pcm, det) => ({
    async subscribe(listener, context) {
      calls.push('wake-source:subscribe');
      const d = det.start({signal: context.signal, deadline: new Date(context.deadlineAtMs).toISOString(),
        onDetected: () => listener({kind: 'wake'})});
      await d.ready;
      const p = pcm.subscribe({signal: context.signal, deadline: new Date(context.deadlineAtMs).toISOString(),
        onFrame: f => d.accept(f), onEnd: r => listener({kind: r === 'device_unavailable' ? 'device_unavailable' : 'error'})});
      await p.ready;
      return {
        unsubscribe: () => { calls.push('wake-sub:unsubscribe'); p.unsubscribe(); void d.stop(); wakeSourceClosed.resolve(); },
        closed: Promise.all([p.closed, d.closed, wakeSourceClosed.promise]).then(() => {}),
      };
    },
  });

  let ctrlState = 'disabled';
  let ctrlSub;
  const makeWakeController = options => ({
    snapshot: () => ({state: ctrlState, sessionId: ctrlState === 'listening' ? 1 : null, expiresAtMs: ctrlState === 'listening' ? fixedNow + 600_000 : null}),
    setPlaybackActive: active => { calls.push(['ctrl:setPlaybackActive', active]); },
    async enable(opts) {
      calls.push('ctrl:enable');
      const decision = await options.authorization.check({requestedAtMs: fixedNow, signal: new AbortController().signal, deadlineAtMs: opts.deadlineAtMs});
      if (decision.kind !== 'allowed') return {kind: 'not_listening', reason: decision.reason || 'permission_denied'};
      try {
        ctrlSub = await options.source.subscribe(
          event => { if (ctrlState === 'listening' && event.kind === 'wake') options.onWake({kind: 'wake', sessionId: 1, occurredAtMs: fixedNow}); },
          {signal: new AbortController().signal, deadlineAtMs: opts.deadlineAtMs});
        ctrlState = 'listening';
        return {kind: 'listening', sessionId: 1, expiresAtMs: decision.expiresAtMs};
      } catch { return {kind: 'not_listening', reason: 'source_unavailable'}; }
    },
    disable() { calls.push('ctrl:disable'); ctrlState = 'disabled'; ctrlSub?.unsubscribe(); ctrlSub = null; },
    dispose() { calls.push('ctrl:dispose'); ctrlState = 'disposed'; ctrlSub?.unsubscribe(); ctrlSub = null; },
  });

  const host = createDesktopVoiceWakeHost({
    source: pcmSource, detector, onWake,
    createPcmKeywordWakeSignalSource: makeWakeSignalSource,
    createWakeLifecycleController: makeWakeController,
    enabled, now: () => fixedNow,
  });

  const lease = {expiresAtMs: fixedNow + 600_000, revocationSignal: new AbortController().signal};

  return {host, calls, pcmReady, pcmClosed, detectorReady, detectorClosed, lease,
    emitDetected: () => detectorOpts?.onDetected?.()};
}

test('enable awaits detector.ready and pcm.ready; does not mock success', async () => {
  let woke = false;
  const f = createFixture({onWake: () => { woke = true; }});
  const pending = f.host.enable({deadlineAtMs: Date.parse('2026-09-25T00:05:00.000Z'), lease: f.lease});
  await new Promise(r => setImmediate(r));
  assert.equal(f.host.isListening(), false);
  f.detectorReady.resolve();
  await new Promise(r => setImmediate(r));
  assert.equal(f.host.isListening(), false);
  f.pcmReady.resolve();
  const result = await pending;
  assert.equal(result.kind, 'listening');
  assert.equal(f.host.isListening(), true);
  f.emitDetected();
  assert.equal(woke, true);
});

test('failed startup actively stops resources and does not hang', async () => {
  const f = createFixture({onWake: () => {}});
  const pending = f.host.enable({deadlineAtMs: Date.parse('2026-09-25T00:05:00.000Z'), lease: f.lease});
  await new Promise(r => setImmediate(r));
  // Detector ready rejects → source.subscribe throws → catch block must stop+await resources
  f.detectorReady.reject(new Error('binary missing'));
  const result = await pending;
  assert.equal(result.kind, 'not_listening');
  assert.equal(result.reason, 'source_unavailable');
  assert.equal(f.host.isListening(), false);
});

test('disable awaits resource closure', async () => {
  const f = createFixture({onWake: () => {}});
  f.detectorReady.resolve();
  f.pcmReady.resolve();
  await f.host.enable({deadlineAtMs: Date.parse('2026-09-25T00:05:00.000Z'), lease: f.lease});
  assert.equal(f.host.isListening(), true);
  await f.host.disable();
  assert.equal(f.calls.includes('ctrl:disable'), true);
  assert.equal(f.host.isListening(), false);
});

test('playback suppresses wake without stopping mic or cancelling tasks', async () => {
  const wakes = [];
  const f = createFixture({onWake: e => { wakes.push(e); }});
  f.detectorReady.resolve();
  f.pcmReady.resolve();
  await f.host.enable({deadlineAtMs: Date.parse('2026-09-25T00:05:00.000Z'), lease: f.lease});
  f.host.setPlaybackActive(true);
  assert.equal(f.host.snapshot().playbackActive, true);
  assert.equal(f.calls.some(c => c === 'pcm:unsubscribe'), false, 'mic must not be stopped');
  f.emitDetected();
  assert.equal(wakes.length, 0, 'wake suppressed during playback');
  f.host.setPlaybackActive(false);
  f.emitDetected();
  assert.equal(wakes.length, 1, 'wake fires after playback ends');
});

test('revoke calls microphoneHost.revoke', async () => {
  const calls = [];
  const fixedNow = Date.parse('2026-09-25T00:00:00.000Z');
  const host = createDesktopVoiceWakeHost({
    microphoneHost: {snapshot: () => ({}), revoke: async () => { calls.push('mic:revoke'); }},
    enabled: true, now: () => fixedNow,
  });
  await host.revoke();
  assert.equal(calls.includes('mic:revoke'), true);
});
