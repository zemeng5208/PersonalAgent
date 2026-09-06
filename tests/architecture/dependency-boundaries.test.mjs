import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectArchitecture } from '../../scripts/checks/architecture.mjs';

test('workspace dependencies obey the documented architecture boundaries', () => {
  const report = inspectArchitecture();
  assert.ok(report.workspaces.length > 0, 'expected at least one workspace');
  assert.deepEqual(report.violations, []);
});
