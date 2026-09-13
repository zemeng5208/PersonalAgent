import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync, fork} from 'node:child_process';
import {once} from 'node:events';
import {openStorage} from '@personal-agent/storage';
import {FakeCoordinationStoreHost} from '@personal-agent/goals/store';
import {TaskRuntime, RUNTIME_MIGRATIONS} from '../dist/index.js';

const input = (id = 'meeting') => ({id, kind: 'fact', summary: 'synthetic meeting 15:00',
  sourceRef: 'fixture/meeting', validFrom: '2026-09-09T00:00:00.000Z',
  validUntil: '2026-09-11T00:00:00.000Z', sensitivity: 'private',
  state: 'active', reason: 'fixture', dependencies: []});
function database(t, close = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pa-coordination-'));
  t.after(() => { close(); rmSync(dir, {recursive: true, force: true}); });
  return join(dir, 'runtime.sqlite');
}
for (const kind of ['fake', 'sqlite']) {
  function host(t) {
    if (kind === 'fake') return new FakeCoordinationStoreHost();
    let runtime;
    runtime = new TaskRuntime(database(t, () => runtime?.close()));
    return {provision: n => runtime.provisionCoordinationStore(n), bind: n => runtime.bindCoordinationStore(n)};
  }
  test(kind + ': explicit provisioning, retained history and copy isolation', t => {
    const h = host(t), missing = h.bind('a');
    assert.throws(() => missing.read(), {code: 'NOT_FOUND'});
    assert.throws(() => missing.append(0, input()), {code: 'NOT_FOUND'});
    const store = h.provision('a');
    const first = store.append(0, input());
    first.history[0].summary = 'mutated outside';
    const second = store.append(1, {...input(), state: 'withdrawn', reason: 'withdrawal'});
    assert.equal(second.history[0].summary, 'synthetic meeting 15:00');
    assert.equal(store.read(1).history[0].state, 'active');
    assert.equal(store.read().history[1].state, 'withdrawn');
    assert.deepEqual(h.provision('a').read(), store.read());
    assert.equal(missing.read().revision, 2);
  });
  test(kind + ': stale or invalid writes preserve data and bound namespaces', t => {
    const h = host(t), a = h.provision('a'), b = h.provision('b');
    a.append(0, input());
    assert.throws(() => h.bind('a').append(0, input('other')), {code: 'REVISION_CONFLICT'});
    assert.throws(() => a.append(1, {...input(), namespace: 'b'}), {code: 'INVALID_ARGUMENT'});
    assert.throws(() => a.append(1, {...input(), dependencies: [{id: 'missing', revision: 1}]}), {code: 'INVALID_ARGUMENT'});
    assert.throws(() => a.read(2), {code: 'INVALID_ARGUMENT'});
    assert.equal(a.read().revision, 1);
    assert.deepEqual(b.read().history, []);
    assert.throws(() => a.read('b'), {code: 'INVALID_ARGUMENT'});
    b.append(0, input());
    assert.equal(a.read().revision, 1);
  });
}
test('SQLite: migration preserves tasks and rejects unsupported downgrade', t => {
  const path = database(t);
  const old = openStorage(path, RUNTIME_MIGRATIONS.slice(0, -1));
  old.prepare("INSERT INTO tasks (task_id, goal, conversation_id, attachment_refs_json, state, revision, updated_at, steps_json, evidence_refs_json) VALUES (?, ?, ?, '[]', 'created', 1, ?, '[]', '[]')")
    .run('existing-task', 'preserve me', 'existing-conversation', '2026-09-09T00:00:00.000Z');
  old.close();
  const runtime = new TaskRuntime(path);
  try {
    assert.equal(runtime.getTask('existing-task').goal, 'preserve me');
    runtime.provisionCoordinationStore('a').append(0, input());
  } finally { runtime.close(); }
  assert.throws(() => openStorage(path, RUNTIME_MIGRATIONS.slice(0, -1)), /newer/);
});
test('SQLite: a fresh process reads committed history', t => {
  const path = database(t), runtime = new TaskRuntime(path);
  runtime.provisionCoordinationStore('a').append(0, input());
  runtime.close();
  const script = "import {TaskRuntime} from '@personal-agent/runtime'; const r=new TaskRuntime(process.argv[1]); try {console.log(JSON.stringify(r.bindCoordinationStore('a').read()));} finally {r.close();}";
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, path], {encoding: 'utf8', timeout: 15000, windowsHide: true});
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).history[0].summary, input().summary);
});
test('SQLite: two processes with the same revision have exactly one winner', {timeout: 20000}, async t => {
  const path = database(t), runtime = new TaskRuntime(path);
  runtime.provisionCoordinationStore('a');
  runtime.close();
  const children = [1, 2].map(() => fork(new URL('./fixtures/coordination-writer.mjs', import.meta.url), [path], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true
  }));
  t.after(() => children.forEach(c => { if (c.exitCode === null) c.kill(); }));
  await Promise.all(children.map(c => once(c, 'message')));
  const results = children.map(c => once(c, 'message'));
  const exits = children.map(c => once(c, 'exit'));
  children.forEach(c => c.send(input()));
  assert.deepEqual((await Promise.all(results)).map(([r]) => r).sort(), ['REVISION_CONFLICT', 'committed']);
  assert.deepEqual((await Promise.all(exits)).map(([code]) => code), [0, 0]);
  const reopened = new TaskRuntime(path);
  try { assert.equal(reopened.bindCoordinationStore('a').read().revision, 1); }
  finally { reopened.close(); }
});
test('SQLite: corrupt or unavailable storage never looks empty or reveals stored content', t => {
  const path = database(t), runtime = new TaskRuntime(path);
  const store = runtime.provisionCoordinationStore('a');
  const db = openStorage(path, RUNTIME_MIGRATIONS);
  db.prepare('UPDATE coordination_graphs SET snapshot_json = ?').run('private-secret-invalid-json');
  db.close();
  assert.throws(() => store.read(), e => e.code === 'STORAGE_UNAVAILABLE' && !e.message.includes('private-secret'));
  assert.throws(() => store.append(0, input()), {code: 'STORAGE_UNAVAILABLE'});
  runtime.close();
  assert.throws(() => store.read(), {code: 'STORAGE_UNAVAILABLE'});
});
