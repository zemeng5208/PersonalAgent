import test from 'node:test';
import assert from 'node:assert/strict';
import {createDesktopEvidenceHost} from '../electron/evidence-host.js';

function fixture() {
  let adminActive = true;
  let owned = true;
  let conversationId = 'desktop-panel';
  const calls = [];
  const application = {
    runtime: {getTask: taskId => ({taskId, conversationId})},
    createEvidenceReader: options => ({
      list: async query => {
        assert.equal(await options.authorize(options), true);
        calls.push({operation: 'list', options, query});
        return {items: [], nextBeforeEvidenceId: undefined};
      },
      get: async evidenceId => {
        assert.equal(await options.authorize(options), true);
        calls.push({operation: 'get', options, evidenceId});
        return {evidenceId, verification: 'conditional'};
      },
    }),
    revokeHostAuthorization: async request => {
      calls.push({operation: 'revoke', request});
      assert.equal(await request.authorize(request), true);
      return {revoked: true, grantPresent: false, approvalRevision: request.expectedApprovalRevision};
    },
  };
  const host = createDesktopEvidenceHost({application, subjectRef: 'desktop-user-v1:synthetic',
    ownsTask: task => owned && task.conversationId === 'desktop-panel',
    isAdminSession: () => adminActive});
  return {host, calls, setAdmin: value => { adminActive = value; },
    setOwned: value => { owned = value; }, setConversation: value => { conversationId = value; }};
}

test('Evidence bridge derives identity from trusted task and returns only public metadata', async () => {
  const {host, calls} = fixture();
  assert.deepEqual(await host.list({taskId: 'task-1', limit: 3}), {items: [], nextBeforeEvidenceId: undefined});
  assert.deepEqual(await host.get({taskId: 'task-1', evidenceId: 'e-1'}),
    {evidenceId: 'e-1', verification: 'conditional'});
  assert.deepEqual(await host.revoke({taskId: 'task-1', authorizationRef: 'grant-1', expectedApprovalRevision: 2}),
    {revoked: true, grantPresent: false, approvalRevision: 2});
  for (const call of calls) {
    const scope = call.options ?? call.request;
    assert.equal(scope.subjectRef, 'desktop-user-v1:synthetic');
    assert.equal(scope.conversationId, 'desktop-panel');
    assert.equal(scope.taskId, 'task-1');
  }
  assert.deepEqual(calls[0].query, {limit: 3});
});

test('Evidence bridge rejects renderer identities and fails closed when session or task ownership changes', async () => {
  const {host, calls, setAdmin, setOwned, setConversation} = fixture();
  assert.throws(() => host.list({taskId: 'task-1', subjectRef: 'forged'}), /invalid/);
  assert.throws(() => host.get({taskId: 'task-1', evidenceId: 'e-1', conversationId: 'forged'}), /invalid/);
  await assert.rejects(host.revoke({taskId: 'task-1', authorizationRef: 'grant-1',
    expectedApprovalRevision: 2, authorize: true}), /invalid/);
  setAdmin(false);
  assert.throws(() => host.list({taskId: 'task-1'}), /denied/);
  setAdmin(true);
  setOwned(false);
  assert.throws(() => host.get({taskId: 'task-1', evidenceId: 'e-1'}), /denied/);
  setOwned(true);
  setConversation('another-conversation');
  assert.throws(() => host.list({taskId: 'task-1'}), /denied/);
  assert.equal(calls.length, 0);
});

test('Evidence reader authorization rechecks the admin session after reader creation', async () => {
  const {host, calls, setAdmin, setConversation} = fixture();
  await host.list({taskId: 'task-1'});
  const scope = calls[0].options;
  setAdmin(false);
  assert.equal(await scope.authorize(scope), false);
  setAdmin(true);
  setConversation('another-conversation');
  assert.equal(await scope.authorize(scope), false);
});
