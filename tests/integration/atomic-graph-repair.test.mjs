import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {TaskRuntime} from '@personal-agent/runtime';
import {previewStoredRepair, commitStoredRepair, analyzeStoredImpact} from '@personal-agent/cognition';

const at = '2026-09-17T12:00:00.000Z';
const node = (id, kind, dependencies = []) => ({id, kind, dependencies, summary:id,
  sourceRef:'synthetic/atomic-repair', sensitivity:'private', state:'active', reason:'fixture',
  validFrom:'2026-09-17T00:00:00.000Z', validUntil:'2026-09-18T00:00:00.000Z'});

test('public cognition consumer commits a complete repair atomically and reads it after SQLite restart', t => {
  const folder = mkdtempSync(join(tmpdir(), 'pa-atomic-repair-'));
  const file = join(folder, 'runtime.sqlite');
  let runtime = new TaskRuntime(file);
  t.after(() => { try { runtime.close(); } finally { rmSync(folder, {recursive:true, force:true}); } });
  let store = runtime.provisionCoordinationStore('synthetic-person');
  store.appendBatch(0, [node('meeting','fact'), node('goal','goal',[{id:'meeting',revision:1}]),
    node('decision','decision',[{id:'goal',revision:1}]), node('plan','plan',[{id:'decision',revision:1}]),
    node('unrelated','plan')]);
  store.append(5, {...node('meeting','fact'), summary:'Meeting moved to 17:00', reason:'synthetic correction'});
  const before = store.read();
  const request = {expectedGraphRevision:6, changes:[
    {node:{id:'goal',revision:1}, summary:'Attend at 17:00', reason:'explicit review', dependencies:[{id:'meeting',revision:2}]},
    {node:{id:'decision',revision:1}, summary:'Depart at 16:30', reason:'explicit review', dependencies:[{id:'goal',revision:2}]},
    {node:{id:'plan',revision:1}, summary:'Remind at 16:15', reason:'explicit review', dependencies:[{id:'decision',revision:2}]},
  ]};
  const preview = previewStoredRepair(store, at, request);
  assert.deepEqual(store.read(), before);
  assert.equal(preview.after.snapshot.revision, 9);
  const result = commitStoredRepair(store, at, request);
  assert.equal(result.kind, 'applied');
  assert.equal(result.snapshot.revision, 9);
  assert.deepEqual(result.report.items.filter(item => item.action === 'RECHECK'), []);
  assert.equal(result.snapshot.history.findLast(item => item.id === 'unrelated').revision, 1);
  runtime.close();
  runtime = new TaskRuntime(file);
  store = runtime.bindCoordinationStore('synthetic-person');
  const restored = analyzeStoredImpact(store, at);
  assert.deepEqual(restored.snapshot, result.snapshot);
  assert.deepEqual(restored.report, result.report);
  assert.deepEqual(store.read(6), before);
});
