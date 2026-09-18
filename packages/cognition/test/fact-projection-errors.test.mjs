import assert from 'node:assert/strict';
import {test} from 'node:test';
import {getEventListeners} from 'node:events';
import {createGraph} from '@personal-agent/goals';
import {MemoryQueryError} from '@personal-agent/memory';
import {previewFactProjection} from '../dist/index.js';

const at = '2026-09-17T12:00:00.000Z';
const batch = {mode: 'changes', batchToken: 'batch', baseCheckpoint: 'checkpoint',
  watermark: 'watermark', entries: [{eventId: 'event', fact: {id: 'meeting', revision: 1}}],
  atWatermark: true};
const canary = 'synthetic-private-error-canary';

async function rejectsWithoutLeaking(getVersion, expected) {
  const graph = createGraph('person');
  const before = structuredClone(graph);
  const signal = new AbortController().signal;
  await assert.rejects(previewFactProjection(graph, batch, {getVersion}, {
    deadline: new Date(Date.now() + 10_000).toISOString(), signal,
  }, at), error => {
    assert.equal(error.code, expected.code);
    assert.equal(error.message, expected.message);
    assert.doesNotMatch(String(error.stack), /synthetic-private-error-canary/);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    return true;
  });
  assert.deepEqual(graph, before);
  assert.equal(getEventListeners(signal, 'abort').length, 0);
}

test('sync and async provider failures are fixed errors without private details', async () => {
  const expected = {code: 'INTEGRITY_ERROR', message: 'Fact projection integrity mismatch'};
  await rejectsWithoutLeaking(() => { throw new Error(canary); }, expected);
  await rejectsWithoutLeaking(() => Promise.reject(new Error(canary)), expected);
  const hostile = new Proxy({}, {getPrototypeOf() { throw new Error(canary); }});
  await rejectsWithoutLeaking(() => Promise.reject(hostile), expected);
});

test('recognized query codes survive but provider-controlled error objects do not', async () => {
  for (const code of ['INVALID_ARGUMENT', 'NOT_FOUND', 'SCOPE_DENIED', 'TIMEOUT', 'CANCELLED']) {
    const expected = new MemoryQueryError(code);
    const unsafe = new MemoryQueryError(code);
    unsafe.message = canary;
    unsafe.cause = new Error(canary);
    await rejectsWithoutLeaking(() => Promise.reject(unsafe), expected);
  }
  const unsafe = new MemoryQueryError('SCOPE_DENIED');
  Object.defineProperty(unsafe, 'code', {get() { throw new Error(canary); }});
  await rejectsWithoutLeaking(() => { throw unsafe; },
    {code: 'INTEGRITY_ERROR', message: 'Fact projection integrity mismatch'});
});
