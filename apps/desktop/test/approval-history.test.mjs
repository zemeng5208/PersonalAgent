import test from 'node:test';
import assert from 'node:assert/strict';
import {readApprovalPage} from '../electron/approval-history.js';
import {authorizationHistoryHtml} from '../src/features/admin/approval-status.js';

const escape = value => String(value).replace(/[&<>"']/g,
  character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]));

test('Desktop history bridge accepts only a bounded public approval cursor', async () => {
  const calls = [];
  const client = {async call(operation, payload) {
    calls.push({operation, payload});
    return {items: [], nextBeforeRowId: payload.beforeRowId ? undefined : 29};
  }};
  assert.equal((await readApprovalPage(client, {})).nextBeforeRowId, 29);
  await readApprovalPage(client, {beforeRowId: 29});
  assert.deepEqual(calls, [
    {operation: 'approval.list', payload: {limit: 50}},
    {operation: 'approval.list', payload: {limit: 50, beforeRowId: 29}},
  ]);
  for (const payload of [undefined, null, 0, [], new Date(), {limit: 100},
    {beforeRowId: 0}, {beforeRowId: -1}, {beforeRowId: 1.5}, {beforeRowId: '29'},
    {beforeRowId: Number.MAX_SAFE_INTEGER + 1}]) {
    await assert.rejects(readApprovalPage(client, payload), /分页参数无效/);
  }
  assert.equal(calls.length, 2, 'Invalid renderer payloads never reach Runtime');
});

test('history displays only redacted completed approvals and distinct loading states', () => {
  const approval = {approvalId: 'approval-1', taskId: 'task-1', state: 'allowed',
    action: 'workspace.read_text', scopes: ['workspace:read'],
    argumentSummary: 'redacted', expiresAt: '2026-09-24T13:00:00.000Z'};
  Object.defineProperty(approval, 'arguments', {
    get() { throw Error('Raw arguments must not be read'); },
  });
  const status = {loaded: true, loading: false, error: false, nextBeforeRowId: 29};
  const html = authorizationHistoryHtml([approval, {...approval, state: 'pending',
    approvalId: 'pending-1'}], escape, status);
  assert.match(html, /已允许/);
  assert.match(html, /id="approval-history-refresh"/);
  assert.match(html, /加载更早记录/);
  assert.doesNotMatch(html, /pending-1|data-approval=|允许一次/);
  assert.match(authorizationHistoryHtml([], escape,
    {...status, loaded: false, loading: true}), /正在读取授权历史/);
  assert.match(authorizationHistoryHtml([], escape,
    {...status, loaded: false, error: true}), /读取失败/);
  assert.match(authorizationHistoryHtml([], escape,
    {...status, nextBeforeRowId: undefined}), /没有已处理的授权记录/);
});
