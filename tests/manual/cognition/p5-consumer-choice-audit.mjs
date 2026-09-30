import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {isDeepStrictEqual} from 'node:util';
import {actionArgumentsDigest} from '@personal-agent/cognition';

/** Inject .chooser into a trusted meeting/device consumer. No source collection, process, timer or grant. */
export function createP5ConsumerChoiceAudit(layaHost) {
  const calls = [];
  const chooser = {async choose(request) {
    const identity = layaHost.readClassifierIdentity();
    assert.ok(layaHost.snapshot().ready && layaHost.snapshot().localOnly === true
      && /^[a-f0-9]{64}$/.test(identity ?? ''), 'Existing real local Laya must be ready');
    assert.ok(request.candidates.length >= 2, 'Selection requires multiple offered candidates');
    const contextDigest = createHash('sha256').update(request.context).digest('hex');
    const candidates = request.candidates.map(candidate => ({candidate: {id: candidate.id, revision: candidate.revision},
      digest: actionArgumentsDigest(candidate), risk: candidate.risk, kind: candidate.kind}));
    const started = performance.now();
    const result = await layaHost.choose(request);
    assert.equal(layaHost.readClassifierIdentity(), identity, 'Loaded model changed during selection');
    assert.equal(result.receipt.contextDigest, contextDigest);
    assert.equal(result.receipt.candidates.length, candidates.length);
    for (const entry of result.receipt.candidates) {
      const offered = candidates.find(candidate => isDeepStrictEqual(candidate.candidate, entry.candidate));
      assert.ok(offered && offered.digest === entry.digest, 'Receipt must refer to the exact offered candidate');
    }
    calls.push({identity, contextDigest, candidates, durationMs: performance.now() - started, selection: structuredClone(result)});
    return result; // Caller consumes the exact real result, including uncertain/abstain.
  }};
  return Object.freeze({chooser, count: () => calls.length, snapshot: () => structuredClone(calls),
    verify(selection) {
      const matching = calls.filter(call => isDeepStrictEqual(call.selection, selection));
      assert.equal(matching.length, 1, 'Persistent receipt must match one actual unchanged host choice');
      return structuredClone(matching[0]);
    },
  });
}
