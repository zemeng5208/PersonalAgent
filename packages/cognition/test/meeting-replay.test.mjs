import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runMeetingReplay} from '../examples/meeting-replay.mjs';

test('local meeting replay repairs only explicitly rebound versions and preserves history', () => {
  const report = runMeetingReplay();
  assert.equal(report.verification, 'mock');
  assert.equal(report.externalActionsExecuted, false);
  assert.equal(report.graph.revision, 9);
  assert.equal(report.stages.corrected.filter(i => i.action === 'RECHECK').length, 3);
  assert.equal(report.stages.partiallyRebound.filter(i => i.action === 'RECHECK').length, 2);
  assert.equal(report.stages.repaired.filter(i => i.action === 'RECHECK').length, 0);
  assert.equal(report.unrelatedPlanPreserved, true);
  assert.equal(report.historicalSnapshotPreserved, true);
  assert.deepEqual(runMeetingReplay(), report);
});
