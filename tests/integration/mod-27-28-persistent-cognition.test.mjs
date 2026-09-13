import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {TaskRuntime} from '@personal-agent/runtime';
import {analyzeStoredImpact, commitStoredPlanRevision} from '@personal-agent/cognition';

const at = '2026-09-12T09:00:00.000Z';
const node = (id, kind = 'fact', dependencies = []) => ({id, kind, dependencies,
  summary: id === 'meeting' ? 'Meeting at 15:00' : id, sourceRef: 'synthetic/integration',
  sensitivity: 'private', state: 'active', reason: 'fixture',
  validFrom: '2026-09-12T00:00:00.000Z', validUntil: '2026-09-13T00:00:00.000Z'});
const affected = report => report.items.filter(item => item.action === 'RECHECK').map(item => item.node.id);

test('SQLite-bound consumer reanalyzes a conflict, applies an explicit repair, and survives restart', t => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-persistent-cognition-'));
  const path = join(dir, 'runtime.sqlite');
  let runtime = new TaskRuntime(path);
  t.after(() => {
    try { runtime.close(); } catch {}
    rmSync(dir, {recursive: true, force: true});
  });
  let store = runtime.provisionCoordinationStore('synthetic-person');
  for (const input of [node('meeting'), node('goal', 'goal', [{id: 'meeting', revision: 1}]),
    node('decision', 'decision', [{id: 'goal', revision: 1}]),
    node('plan', 'plan', [{id: 'decision', revision: 1}]), node('unrelated', 'plan')]) {
    store.append(store.read().revision, input);
  }
  store.append(5, {...node('meeting'), summary: 'Meeting at 17:00', reason: 'correction'});
  assert.deepEqual(affected(analyzeStoredImpact(store, at).report), ['goal', 'decision', 'plan']);
  store.append(6, {...node('goal', 'goal', [{id: 'meeting', revision: 2}]), reason: 'explicit recheck'});
  store.append(7, {...node('decision', 'decision', [{id: 'goal', revision: 2}]), reason: 'explicit decision'});
  const stale = {expectedGraphRevision: 8, plan: {id: 'plan', revision: 1},
    summary: 'Remind at 16:15', reason: 'explicit reviewed repair', dependencies: [{id: 'decision', revision: 2}]};
  store.append(8, node('concurrent-unrelated'));
  const conflict = commitStoredPlanRevision(store, at, stale);
  assert.equal(conflict.kind, 'conflict');
  assert.equal(conflict.currentGraphRevision, 9);
  assert.deepEqual(affected(conflict.report), ['plan']);
  const applied = commitStoredPlanRevision(store, at, {...stale, expectedGraphRevision: 9});
  assert.equal(applied.kind, 'applied');
  assert.equal(applied.snapshot.revision, 10);
  assert.deepEqual(affected(applied.report), []);
  assert.equal(applied.snapshot.history.find(n => n.id === 'unrelated').revision, 1);

  runtime.close();
  runtime = new TaskRuntime(path);
  store = runtime.bindCoordinationStore('synthetic-person');
  const reopened = analyzeStoredImpact(store, at);
  assert.equal(reopened.snapshot.revision, 10);
  assert.equal(reopened.snapshot.history.at(-1).summary, 'Remind at 16:15');
  assert.deepEqual(affected(reopened.report), []);
});
