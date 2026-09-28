import test from 'node:test';
import assert from 'node:assert/strict';

const escape = value => String(value).replace(/[&<>"']/g,
  char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));

test('admin task monitor reads steps and Evidence counts without exposing refs or inventing source', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'matchMedia');
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  globalThis.matchMedia = () => ({matches: false, addEventListener() {}});
  globalThis.window = {addEventListener() {}};
  t.after(() => previous
    ? Object.defineProperty(globalThis, 'matchMedia', previous)
    : delete globalThis.matchMedia);
  t.after(() => previousWindow
    ? Object.defineProperty(globalThis, 'window', previousWindow)
    : delete globalThis.window);
  const {taskTable} = await import('../src/features/admin/view.js');
  const html = taskTable({tasks: [{taskId: 'task-1', state: 'waiting_approval', revision: 3,
    steps: [{stepId: 'one', label: '<private>', state: 'waiting'}],
    evidenceRefs: ['secret-ref'], resultSummary: '等待用户授权'}]}, escape);
  assert.match(html, /等待授权/);
  assert.match(html, /步骤 1 项 · Evidence 引用 1 条/);
  assert.match(html, /&lt;private&gt;/);
  assert.doesNotMatch(html, /secret-ref|<private>/);
  assert.match(html, /此接口未提供任务来源或云端 trace/);
});
