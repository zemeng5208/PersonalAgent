import assert from 'node:assert/strict';
import test from 'node:test';
import {ingestConfirmedPrivateCitation} from '../dist/application/private-source.js';

function fixture() {
  const writes = [];
  const reads = [];
  const controller = new AbortController();
  const context = {deadline: '2099-01-01T00:00:00.000Z', signal: controller.signal};
  const memory = {
    createUserFact(namespace, fields) { writes.push({namespace, ...fields}); return writes.at(-1); },
    reviseUserFact(namespace, fields) { writes.push({namespace, ...fields}); return writes.at(-1); },
  };
  const options = {memory, namespace: 'private-original', factId: 'original-fact',
    expectedRevision: null,
    source: {vaultId: 'synthetic-vault', path: 'original.md', line: 1, revision: 'a'.repeat(64)},
    observedAt: '2026-09-29T00:00:00.000Z', validFrom: '2026-09-29T00:00:00.000Z',
    validUntil: '2027-01-01T00:00:00.000Z',
    vault: {async readCitation(request) {
      reads.push(structuredClone(request.source));
      if (request.signal.aborted) throw Object.assign(new Error('cancelled'), {code: 'CANCELLED'});
      return 'Synthetic confirmed citation';
    }},
    confirm: async () => ({operationId: 'confirmed-operation', summary: 'Confirmed summary'}),
  };
  return {options, context, controller, writes, reads};
}

test('private confirmation binds the original target and ports before awaiting', async () => {
  const f = fixture();
  const original = structuredClone(f.options.source);
  f.options.confirm = async () => {
    Object.assign(f.options, {namespace: 'different', factId: 'different', expectedRevision: 8,
      validUntil: '2098-01-01T00:00:00.000Z',
      vault: {readCitation() { throw Error('replacement vault must not be used'); }},
      memory: {createUserFact() { throw Error('replacement memory must not be used'); }}});
    f.options.source.path = 'different.md';
    return {operationId: 'confirmed-operation', summary: 'Confirmed summary'};
  };
  await ingestConfirmedPrivateCitation(f.options, f.context);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].namespace, 'private-original');
  assert.equal(f.writes[0].factId, 'original-fact');
  assert.equal(f.writes[0].validUntil, '2027-01-01T00:00:00.000Z');
  assert.deepEqual(f.reads, [original, original]);
});

test('citation readers cannot rewrite the private source used for the receipt', async () => {
  const f = fixture();
  const original = structuredClone(f.options.source);
  f.options.vault.readCitation = async request => {
    f.reads.push(structuredClone(request.source));
    request.source.path = 'port-mutated.md';
    return 'Synthetic confirmed citation';
  };
  await ingestConfirmedPrivateCitation(f.options, f.context);
  assert.deepEqual(f.options.source, original);
  assert.deepEqual(f.reads, [original, original]);
  assert.equal(f.writes[0].sourceRef,
    `synthetic-vault/original.md#L1@${'a'.repeat(64)}`);
});

test('confirmed decision fields stay stable during the second citation read', async () => {
  const f = fixture();
  const decision = {operationId: 'confirmed-operation', summary: 'Confirmed summary'};
  let count = 0;
  f.options.confirm = async () => decision;
  f.options.vault.readCitation = async () => {
    if (++count === 2) Object.assign(decision,
      {operationId: 'unconfirmed-operation', summary: 'Unconfirmed summary'});
    return 'Synthetic confirmed citation';
  };
  await ingestConfirmedPrivateCitation(f.options, f.context);
  assert.equal(f.writes[0].operationId, 'confirmed-operation');
  assert.equal(f.writes[0].summary, 'Confirmed summary');
});

test('replacing a caller context cannot remove the original cancellation', async () => {
  const f = fixture();
  f.options.confirm = async () => {
    f.controller.abort();
    f.context.signal = new AbortController().signal;
    f.context.deadline = '2099-12-31T00:00:00.000Z';
    return {operationId: 'confirmed-operation', summary: 'Confirmed summary'};
  };
  await assert.rejects(ingestConfirmedPrivateCitation(f.options, f.context), {code: 'CANCELLED'});
  assert.equal(f.writes.length, 0);
});

test('declined confirmation performs no write or second citation read', async () => {
  const f = fixture();
  f.options.confirm = async () => null;
  assert.equal(await ingestConfirmedPrivateCitation(f.options, f.context), null);
  assert.equal(f.writes.length, 0);
  assert.equal(f.reads.length, 1);
});

test('a changed citation remains rejected before a write', async () => {
  const f = fixture();
  let count = 0;
  f.options.vault.readCitation = async () => ++count === 1 ? 'Original text' : 'Changed text';
  await assert.rejects(ingestConfirmedPrivateCitation(f.options, f.context), {code: 'SOURCE_CHANGED'});
  assert.equal(f.writes.length, 0);
});

test('revision writes preserve the exact original head and private sensitivity', async () => {
  const f = fixture();
  f.options.expectedRevision = 2;
  await ingestConfirmedPrivateCitation(f.options, f.context);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].expectedRevision, 2);
  assert.equal(f.writes[0].sensitivity, 'private');
  assert.equal(f.writes[0].state, 'active');
  assert.equal(f.writes[0].signal, f.controller.signal);
});
