import assert from 'node:assert/strict';
import {test} from 'node:test';
import {VoiceSessionManager, VOICE_AUDIO_FORMAT} from '../dist/index.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
};
const options = signal => ({deadline: new Date(Date.now() + 60_000).toISOString(),
  signal: signal ?? new AbortController().signal});
const clip = () => ({data: new Uint8Array(320), format: VOICE_AUDIO_FORMAT, durationMs: 10});

test('concurrent starts clean a newly installed session before replacing it', async t => {
  const releases = [deferred(), deferred()];
  const observed = [];
  const reads = [];
  let id = 0;
  const manager = new VoiceSessionManager({idFactory: kind => `${kind}-${++id}`, recognition: {
    recognize(request) {
      const index = observed.length;
      const result = deferred();
      const operation = {request, result, stops: 0};
      observed.push(operation);
      return {result: result.promise, stop() {
        operation.stops++;
        return releases[index]?.promise ?? Promise.resolve();
      }};
    },
  }});
  let unsubscribe = () => {};
  t.after(async () => {
    unsubscribe();
    for (const release of releases) release.resolve();
    for (const operation of observed) operation.result.resolve({text: 'fixture'});
    const current = manager.current();
    if (current) await manager.stop(current.sessionId);
  });
  const first = await manager.start(options());
  reads.push(manager.recognizeAudio(first.sessionId, clip()).catch(error => error.code));
  unsubscribe = manager.subscribe(snapshot => {
    if (snapshot.state === 'listening') {
      reads.push(manager.recognizeAudio(snapshot.sessionId, clip()).catch(error => error.code));
    }
  });
  const a = manager.start(options());
  let bFinished = false;
  const b = manager.start(options()).then(value => { bFinished = true; return value; });
  releases[0].resolve();
  const second = await a;
  await Promise.resolve();
  assert.equal(observed.length, 2);
  assert.equal(observed[1].request.sessionId, second.sessionId);
  assert.equal(observed[1].request.signal.aborted, true);
  assert.equal(bFinished, false, 'second replacement must wait for the first replacement cleanup');
  releases[1].resolve();
  const third = await b;
  assert.equal(manager.current().sessionId, third.sessionId);
  assert.equal(observed.length, 3);
  assert.equal(observed[2].request.signal.aborted, false);
  unsubscribe();
  await manager.stop(third.sessionId);
  await Promise.all(reads);
  assert.deepEqual(observed.map(operation => operation.stops), [1, 1, 1]);
  assert.ok(observed.every(operation => operation.request.signal.aborted));
});

test('a cancelled replacement does not publish a new session after delayed cleanup', async t => {
  const release = deferred();
  const manager = new VoiceSessionManager({recognition: {
    recognize() { return {result: new Promise(() => {}), stop: () => release.promise}; },
  }});
  t.after(async () => {
    release.resolve();
    const current = manager.current();
    if (current) await manager.stop(current.sessionId);
  });
  const first = await manager.start(options());
  const read = manager.recognizeAudio(first.sessionId, clip()).catch(error => error.code);
  const parent = new AbortController();
  const replacement = manager.start(options(parent.signal));
  const rejected = assert.rejects(replacement, {code: 'CANCELLED'});
  parent.abort();
  release.resolve();
  await rejected;
  await read;
  assert.equal(manager.current().sessionId, first.sessionId);
  assert.equal(manager.current().state, 'stopped');
});
