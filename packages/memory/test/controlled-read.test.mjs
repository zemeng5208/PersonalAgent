import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createControlledMemoryReader} from '../dist/index.js';
import {openSqliteMemoryHost} from '../dist/sqlite.js';

const context = () => ({deadline: '2099-01-01T00:00:00.000Z', signal: new AbortController().signal});
test('actual SQLite correction is cited locally; private cloud use and late correction fail closed', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pa-memory-owned-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const path = join(directory, 'memory.sqlite');
  let host = openSqliteMemoryHost(path);
  host.provision('synthetic');
  const fields = {factId: 'synthetic-preference', operationId: 'create-1', summary: 'Monday review',
    sourceRef: 'synthetic-user-confirmation', observedAt: '2026-09-30T00:00:00.000Z',
    validFrom: '2026-09-30T00:00:00.000Z', validUntil: '2099-01-01T00:00:00.000Z', ...context()};
  host.createUserFact('synthetic', fields);
  host.reviseUserFact('synthetic', {...fields, operationId: 'correct-2', expectedRevision: 1,
    summary: 'Tuesday review', state: 'active', sensitivity: 'private'});
  host.close(); host = openSqliteMemoryHost(path);
  try {
    const query = host.bind('synthetic', {allowedSensitivities: ['private']});
    const reader = createControlledMemoryReader({query, authorize: async () => ({allowed: true})});
    const request = {fact: {id: fields.factId, revision: 2}, destination: 'local', purpose: 'Synthetic local read', ...context()};
    const citation = await reader.read(request);
    assert.equal(citation.summary, 'Tuesday review'); assert.equal(citation.ref.revision, 2);
    assert.equal(citation.sourceRef, fields.sourceRef); assert.equal(citation.destination, 'local');
    await assert.rejects(reader.read({...request, destination: 'cloud'}), {code: 'SCOPE_DENIED'});
    const delayed = createControlledMemoryReader({query, authorize: async () => {
      host.reviseUserFact('synthetic', {...fields, operationId: 'correct-3', expectedRevision: 2,
        summary: 'Wednesday review', state: 'active', sensitivity: 'private'});
      return {allowed: true};
    }});
    await assert.rejects(delayed.read(request), {code: 'SCOPE_DENIED'});
    host.eraseUnboundFact('synthetic', {factId: fields.factId, expectedRevision: 3, operationId: 'erase-1', ...context()});
    await assert.rejects(reader.read({...request, fact: {id: fields.factId, revision: 3}}), {code: 'SCOPE_DENIED'});
  } finally {host.close();}
});
