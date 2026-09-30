import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildInterestOptions, LayaInterestDecisionService} from '../dist/interest-options.js';
import {LayaActionChoiceService} from '../dist/index.js';

const minute = 60_000;
const iso = ms => new Date(ms).toISOString();
function evidence(id, kind, now, extra = {}) {
  return {id, topicId: 'typescript', sourceId: 'conversation', sourceRevision: 'r1',
    occurredAt: iso(now - 20 * minute), interactionId: id, kind, match: 'semantic', ...extra};
}
function fixture(now = Date.now()) {
  return {topicId: 'typescript', at: iso(now), evidenceMaxAgeMs: 2 * 60 * minute,
    watchDurationMs: 60 * minute,
    evidence: [evidence('q1', 'question', now),
      evidence('follow', 'followup', now, {relatedEvidenceId: 'q1'})],
    source: {id: 'official-docs', revision: 'source-v1', visibility: 'public', risk: 'low',
      transportVerified: true, verificationExpiresAt: iso(now + 60 * minute)},
    scope: {state: 'granted', id: 'public-tracking', revision: 3,
      publicLowRiskTracking: true, expiresAt: iso(now + 60 * minute)}};
}
function chooser(pick, onInfer = () => {}) {
  return new LayaActionChoiceService({async infer(payload) {
    onInfer(payload);
    const criteria = payload.questions.action.criteria;
    const keys = Object.keys(criteria);
    const selected = keys.find(key => JSON.parse(criteria[key]).description.includes(pick));
    assert.ok(selected, `missing choice: ${pick}`);
    const probabilities = Object.fromEntries(keys.map(key =>
      [key, key === selected ? 0.9 : 0.1 / (keys.length - 1)]));
    return {answers: {action: {choice: selected, probabilities,
      answer_confidence: 0.9, confidence: 0.5}}};
  }});
}
const request = () => ({deadline: iso(Date.now() + 60 * minute),
  signal: new AbortController().signal});

test('a single inquiry stays candidate; sustained public scope offers three bound approaches', () => {
  const input = fixture();
  const candidate = buildInterestOptions({...input, evidence: [input.evidence[0]]});
  assert.equal(candidate.policy.state, 'candidate');
  assert.deepEqual(candidate.options.map(option => option.id), ['retain_candidate', 'defer']);
  assert.ok(candidate.options.every(option => option.kind === 'escalate' && option.source === undefined));

  const watch = buildInterestOptions(input);
  assert.equal(watch.policy.state, 'watch_public');
  assert.deepEqual(watch.options.map(option => option.id),
    ['track_public', 'review_public', 'defer']);
  assert.deepEqual(watch.options[0].source,
    {id: input.source.id, revision: input.source.revision, validUntil: watch.policy.expiresAt});
  assert.deepEqual(watch.options[0].evidence, watch.policy.evidence);
  assert.deepEqual(watch.options[0].scope,
    {id: input.scope.id, revision: input.scope.revision});
  assert.ok(watch.options.every(option => option.kind === 'escalate'));
});

test('Laya choice service with fake inference binds source, evidence and scope without starting tracking', async () => {
  let clock = Date.now();
  const input = fixture(clock);
  const service = new LayaInterestDecisionService(chooser('plan tracking'), () => clock);
  const result = await service.choose(input, request());
  assert.equal(result.outcome, 'selected');
  assert.equal(result.selected.id, 'track_public');
  assert.deepEqual(result.selection.selected, {id: 'track_public', revision: 1});
  assert.equal(result.requiresHostRevalidation, true);
  assert.equal(result.calibrated, false);
  assert.equal(result.selection.calibrated, false);
  assert.match(result.receipt.digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.receipt.evidence.map(ref => ref.id), ['follow', 'q1']);
  assert.deepEqual(new Set(result.receipt.evidence.map(ref => ref.id)),
    new Set(result.policy.evidence.map(ref => ref.id)));
  assert.deepEqual(result.receipt.source, result.policy.source);
  assert.deepEqual(result.receipt.scope, {id: input.scope.id, revision: input.scope.revision});
  assert.deepEqual(result.receipt.selectedRef, {id: 'track_public', revision: 1});
  assert.equal(result.receipt.optionRefs.length, 3);
  assert.equal(result.receipt.modelReceiptId, result.selection.receipt.id);
  assert.equal(result.selected.kind, 'escalate');
  clock += minute;
});

test('revocation and unavailable or stale policy never offer tracking or resume', async () => {
  const now = Date.now();
  const input = fixture(now);
  const revoked = {...input, scope: {...input.scope, state: 'revoked'}};
  assert.deepEqual(buildInterestOptions(revoked).options.map(option => option.id),
    ['stop_tracking', 'keep_revoked']);
  const result = await new LayaInterestDecisionService(chooser('stop any existing'), () => now)
    .choose(revoked, request());
  assert.equal(result.selected.id, 'stop_tracking');
  assert.equal(result.options.some(option => option.id === 'track_public'), false);
  for (const changed of [
    {...input, evidence: [], previous: {state: 'watch_public'}},
    {...input, source: {...input.source, transportVerified: false}},
    {...input, scope: {...input.scope, publicLowRiskTracking: false}}
  ]) {
    const built = buildInterestOptions(changed);
    assert.ok(['decay', 'abstain'].includes(built.policy.state));
    assert.equal(built.options.some(option => option.id === 'track_public'), false);
  }
  const injected = {choose: async () => ({state: 'selected', selected: {id: 'track_public', revision: 1},
    eligibleForRuntime: true, reason: 'selected', calibrated: false, scores: [], receipt: {id: 'forged'}})};
  await assert.rejects(new LayaInterestDecisionService(injected, () => now)
    .choose(revoked, request()), /outside offered options/);
});

test('unknown policy values and injected selection identities are rejected', async () => {
  const now = Date.now();
  const input = fixture(now);
  for (const changed of [
    {...input, scope: {...input.scope, state: 'secretly_granted'}},
    {...input, scope: {...input.scope, publicLowRiskTracking: 'yes'}},
    {...input, source: {...input.source, visibility: 'internal'}},
    {...input, classification: {label: 'sustained', abstained: false, calibrated: true, evidence: []}}
  ]) assert.throws(() => buildInterestOptions(changed), /Invalid/);
  for (const selected of [{id: 'injected', revision: 1}, {id: 'track_public', revision: 2}]) {
    const injected = {choose: async () => ({state: 'selected', selected,
      eligibleForRuntime: true, reason: 'selected', calibrated: false, scores: [], receipt: {id: 'forged'}})};
    await assert.rejects(new LayaInterestDecisionService(injected, () => now)
      .choose(input, request()), /outside offered options/);
  }
});

test('async mutation and expiry cannot turn an old choice into a tracking decision', async () => {
  let clock = Date.now();
  const input = fixture(clock);
  const expires = Date.parse(input.scope.expiresAt);
  const service = new LayaInterestDecisionService(chooser('plan tracking', () => {
    input.scope.state = 'revoked';
    input.evidence[0].sourceRevision = 'forged';
    clock = expires + 1;
  }), () => clock);
  const result = await service.choose(input, request());
  assert.equal(result.policy.state, 'watch_public', 'caller mutation cannot alter captured policy');
  assert.equal(result.outcome, 'recheck');
  assert.equal(result.selected, undefined);
  assert.equal(result.receipt.evidence.some(ref => ref.sourceRevision === 'forged'), false);
  assert.equal(result.requiresHostRevalidation, true);
});

test('selection evaluates current time before offering choices and binds policy validity in digest', async () => {
  const now = Date.now();
  const input = fixture(now);
  const afterExpiry = Date.parse(input.scope.expiresAt) + 1;
  const stale = await new LayaInterestDecisionService(chooser('recheck evidence'), () => afterExpiry)
    .choose(input, {deadline: iso(now + 3 * 60 * minute), signal: new AbortController().signal});
  assert.equal(stale.policy.state, 'abstain');
  assert.equal(stale.options.some(option => option.id === 'track_public'), false);

  const fixed = {deadline: iso(now + 60 * minute), signal: new AbortController().signal};
  const first = await new LayaInterestDecisionService(chooser('plan tracking'), () => now)
    .choose(input, fixed);
  const same = await new LayaInterestDecisionService(chooser('plan tracking'), () => now)
    .choose(input, {...fixed, signal: new AbortController().signal});
  assert.equal(first.receipt.digest, same.receipt.digest);
  const changed = await new LayaInterestDecisionService(chooser('plan tracking'), () => now)
    .choose({...input, scope: {...input.scope, expiresAt: iso(now + 61 * minute)}},
      {...fixed, signal: new AbortController().signal});
  assert.notEqual(first.receipt.digest, changed.receipt.digest);
});
