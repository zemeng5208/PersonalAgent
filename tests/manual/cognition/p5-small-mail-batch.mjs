import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {messageToItem} from '@personal-agent/mail';

const fixture = JSON.parse(readFileSync(new URL('./mail-batch-small.json', import.meta.url), 'utf8'));
const copy = value => structuredClone(value);

/** No model/process/storage/authorization factory. Inject the existing production ports and isolated lease. */
export async function runSmallMailBatchAcceptance({createPipeline, storage, reopenStorage,
  layaHost, getClassifierFingerprint, labels, meetingLabels, namespace, authorizeRead,
  pauseRead, resumeRead, signal, deadline, onProgress = () => {}}) {
  for (const port of [createPipeline, reopenStorage, getClassifierFingerprint, authorizeRead, pauseRead, resumeRead]) {
    assert.equal(typeof port, 'function', 'Existing production ports and lease lifecycle callbacks are required');
  }
  assert.ok(signal instanceof AbortSignal && Number.isFinite(Date.parse(deadline)));
  const active = () => {signal.throwIfAborted(); assert.ok(Date.now() < Date.parse(deadline), 'Acceptance deadline expired');};
  const started = performance.now();
  const identity = layaHost.readClassifierIdentity();
  const fingerprint = getClassifierFingerprint();
  assert.ok(layaHost.snapshot().ready && layaHost.snapshot().localOnly === true
    && /^[a-f0-9]{64}$/.test(identity ?? ''), 'Owned real local Laya must already be ready');
  assert.ok(typeof fingerprint === 'string' && fingerprint.length > 0, 'Current loaded classifier fingerprint is required');
  const calls = [];
  const sameModel = () => {
    active(); assert.ok(layaHost.snapshot().ready);
    assert.equal(layaHost.readClassifierIdentity(), identity, 'Loaded model changed');
    assert.equal(getClassifierFingerprint(), fingerprint, 'Classification policy changed');
  };
  const triage = {async classify(request) {
    sameModel();
    const call = {inputCount: request.messages.length,
      inputs: request.messages.map(({messageId, sourceRevision, text}) => ({messageId, sourceRevision, nonblank: Boolean(text.trim())})),
      resultCount: 0, durationMs: 0};
    calls.push(call);
    const before = performance.now();
    try {
      const results = await layaHost.classify(request);
      sameModel();
      call.results = copy(results); call.resultCount = results.length;
      return results; // Exact host result, never a synthetic answer or altered threshold.
    } catch (error) {call.errorCode = error?.code ?? 'unavailable'; throw error;}
    finally {call.durationMs = performance.now() - before;}
  }};
  const options = {namespace, triage, labels, meetingLabels, getClassifierFingerprint, authorizeRead};
  let pipeline = createPipeline({...options, storage});
  const context = () => {active(); return {signal, deadline};};
  const scope = () => ({accountRef: fixture.accountRef, folder: fixture.folder, ...context()});
  const items = fixture.messages.map(message => messageToItem(message, fixture.accountRef, new Date().toISOString()));
  assert.equal(items.length, 8); assert.equal(new Set(items.map(item => item.externalId)).size, 8);
  assert.ok(items.every(item => item.contentRef.trim()));
  assert.equal(pipeline.snapshot().total, 0, 'Use an isolated empty namespace, never the user inbox');
  assert.equal(pipeline.readCursor(scope()), undefined);
  const page1 = {accountRef: fixture.accountRef, folder: fixture.folder, nextCursor: '1:4', hasMore: true, items: items.slice(0, 4)};
  const page2 = {accountRef: fixture.accountRef, folder: fixture.folder, cursor: '1:4', nextCursor: '1:8', hasMore: false, items: items.slice(4)};
  const report = {profile: 'huawei_ict_agentarts', dataClass: 'public_synthetic_headers', identity, fingerprint,
    sourceAccountVerified: false, cloudCalls: 0, cancelledAtPageBoundary: false, inFlightTorchCancellationVerified: false, pages: [], calls};
  const runPage = async (name, page) => {
    sameModel(); const before = performance.now();
    const result = await pipeline.processPage({...page, ...context()});
    const receipt = {name, durationMs: performance.now() - before, ...copy(result), cursor: pipeline.readCursor(scope())};
    report.pages.push(receipt); onProgress(copy(report)); return result;
  };
  const first = await runPage('first', page1);
  if (!first.complete) return finish('classification_incomplete');
  assert.equal(first.classified, 4); assert.equal(first.reused, 0);
  assert.equal(pipeline.readCursor(scope()), '1:4');
  const original = copy(pipeline.snapshot().records);
  assert.equal(original.length, 4); assert.ok(original.every(row => row.receiptId));
  const beforePause = calls.length;
  await pauseRead();
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(pipeline.processPage({...page2, deadline, signal: cancelled.signal}), error => error.code === 'CANCELLED');
  assert.equal(calls.length, beforePause, 'Page-boundary cancellation must not infer');
  // Existing local lease is renewed explicitly by its owner; no authorization is created here.
  await resumeRead(); sameModel();
  assert.equal(pipeline.readCursor(scope()), '1:4');
  report.cancelledAtPageBoundary = true;
  storage = await reopenStorage(storage); // Caller releases/reopens the same durable storage, not a fresh cache.
  pipeline = createPipeline({...options, storage});
  assert.deepEqual(pipeline.snapshot().records, original);
  const replay = await runPage('replay_after_reopen', page1);
  assert.equal(replay.classified, 0); assert.equal(replay.reused, 4); assert.ok(replay.complete);
  assert.deepEqual(pipeline.snapshot().records, original);
  assert.equal(calls.length, beforePause, 'Rebuilt pipeline must reuse original receipts without inference');
  const second = await runPage('second', page2);
  if (!second.complete) return finish('classification_incomplete');
  assert.equal(second.classified, 4); assert.equal(second.reused, 0);
  const snapshot = pipeline.snapshot();
  assert.equal(snapshot.total, 8); assert.equal(pipeline.readCursor(scope()), '1:8');
  for (const prior of original) assert.deepEqual(snapshot.records.find(row => row.messageId === prior.messageId), prior);
  assert.equal(new Set(snapshot.records.map(row => row.receiptId)).size, 8);
  return finish('completed');

  function finish(outcome) {
    const results = calls.flatMap(call => call.results ?? []);
    const unfinished = new Set(['unavailable', 'invalid_response', 'cancelled', 'deadline', 'insufficient_input']);
    const completedCalls = calls.filter(call => !call.errorCode && call.results?.every(result => !unfinished.has(result.reason)));
    const inferenceWallMs = completedCalls.reduce((sum, call) => sum + call.durationMs, 0);
    const effectiveInputs = completedCalls.reduce((sum, call) => sum + call.inputs.filter(input => input.nonblank).length, 0);
    const snapshot = pipeline.snapshot();
    return {...copy(report), outcome, finalSnapshot: snapshot, cursor: pipeline.readCursor(scope()),
      totalDurationMs: performance.now() - started, classifyWallMs: inferenceWallMs,
      classifyTimingIncludesHttpAndValidation: true, torchForwardMs: null,
      attemptedInputs: calls.reduce((sum, call) => sum + call.inputCount, 0), effectiveNewInputs: effectiveInputs,
      effectiveResults: results.filter(result => !unfinished.has(result.reason)).length,
      classified: results.filter(result => !result.abstained && result.route === 'group').length,
      automaticSafeClassifications: snapshot.records.filter(row => !row.needsReview).length,
      uncertain: results.filter(result => result.reason === 'uncertain').length,
      needsReview: snapshot.needsReview, highImpactCandidates: snapshot.highImpactCandidates,
      calibrated: false, messagesPerSecond: inferenceWallMs > 0 ? effectiveInputs * 1000 / inferenceWallMs : null};
  }
}
