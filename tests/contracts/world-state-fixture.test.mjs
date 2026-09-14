import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/world-state/meeting-change.json', import.meta.url), 'utf8'));
const refKey = ref => `${ref.id}@${ref.revision}`;

test('world-state fixture is synthetic and version references are self-consistent', () => {
  assert.equal(fixture.synthetic, true);
  assert.match(fixture.namespace, /^fixture\//);

  const seen = new Set();
  const latestRevision = new Map();
  for (const fact of fixture.facts) {
    assert.equal(fact.revision, (latestRevision.get(fact.id) ?? 0) + 1);
    for (const key of ['observedAt', 'validFrom', 'validUntil']) assert.match(fact[key], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    latestRevision.set(fact.id, fact.revision);
    if (fact.corrects) assert.ok(seen.has(refKey(fact.corrects)));
    seen.add(refKey(fact));
  }

  const seedIds = new Set(fixture.graphSeeds.map(seed => seed.id));
  for (const seed of fixture.graphSeeds) {
    assert.ok(seen.has(refKey(seed.dependsOn)) || seedIds.has(seed.dependsOn.id));
  }
});

test('query probes distinguish empty, invalid, forbidden and external failures', () => {
  const probes = new Map(fixture.queryProbes.map(probe => [probe.id, probe]));
  const refs = new Set(fixture.facts.map(refKey));
  assert.equal(probes.size, fixture.queryProbes.length);
  assert.deepEqual(probes.get('meeting-effective-at-snapshot-2').expected, {
    status: 'OK',
    snapshotWatermark: 2,
    refs: [{id: 'meeting', revision: 2}]
  });
  assert.deepEqual(probes.get('fact-history-at-revision').expected, {
    status: 'OK',
    refs: [{id: 'meeting', revision: 1}]
  });
  assert.deepEqual(probes.get('no-match-is-empty').expected, {status: 'OK', snapshotWatermark: 3, refs: []});
  assert.equal(probes.get('missing-bound-namespace').expected.status, 'NOT_FOUND');
  assert.equal(probes.get('invalid-limit').expected.status, 'INVALID_ARGUMENT');
  assert.deepEqual(probes.get('restricted-scope-denied').expected, {status: 'FORBIDDEN', revealsExistence: false});

  for (const id of ['storage-unavailable', 'deadline-exceeded', 'cancelled']) {
    assert.equal(probes.get(id).expected.partialSuccess, false);
  }
  for (const probe of probes.values()) {
    for (const ref of probe.expected.refs ?? []) assert.ok(refs.has(refKey(ref)), `${probe.id}: ${refKey(ref)}`);
  }
});

test('change-feed probes hold a watermark and advance only confirmed cursors', () => {
  const probes = new Map(fixture.changeFeedProbes.map(probe => [probe.id, probe]));
  assert.equal(probes.size, fixture.changeFeedProbes.length);
  const pagination = probes.get('fixed-watermark-pagination');
  const factRefs = new Set(fixture.facts.map(refKey));
  for (const change of fixture.changes) assert.ok(factRefs.has(refKey(change.fact)), `${change.eventId}: ${refKey(change.fact)}`);
  assert.ok(pagination.pages.flat().every(id => Number(id.slice('fixture-change-'.length)) <= pagination.watermark));
  assert.deepEqual(pagination.excludedUntilNextRead, [pagination.concurrentlyArriving.eventId]);
  assert.equal(probes.get('restart-after-confirmed-cursor').expectedNextEventId, 'fixture-change-3');
  assert.equal(probes.get('processing-failure-does-not-confirm').expectedConfirmedSequence, 1);
  assert.equal(probes.get('duplicate-event-idempotent').expectedAppliedCount, 1);
  assert.equal(probes.get('sequence-gap').advancesCursor, false);
  assert.equal(probes.get('expired-cursor').silentRestart, false);
  assert.equal(probes.get('cancelled-subscription').deliveriesAfterCancellation, 0);
});

test('impact expectations neither overlap nor omit graph seeds', () => {
  const ids = new Set(fixture.graphSeeds.map(seed => seed.id));
  for (const [name, expectation] of Object.entries(fixture.expectations)) {
    if (!expectation || !Array.isArray(expectation.keep) || !Array.isArray(expectation.recheck)) continue;
    assert.equal(new Set([...expectation.keep, ...expectation.recheck]).size, ids.size, name);
    assert.equal(expectation.keep.some(id => expectation.recheck.includes(id)), false, name);
    for (const id of [...expectation.keep, ...expectation.recheck]) assert.ok(ids.has(id), `${name}: ${id}`);
  }
});
