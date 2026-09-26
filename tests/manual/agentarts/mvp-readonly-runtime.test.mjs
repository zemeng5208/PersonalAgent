import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {Client} from '@personal-agent/client';
import {FakeCoordinationPort} from '@personal-agent/coordination/testing';
import {TaskRuntime} from '@personal-agent/runtime';
import {createRuntimeApplication} from '@personal-agent/runtime/application';
import {createSyntheticMeetingToolset} from '../../../apps/desktop/electron/competition-synthetic-workspace.js';

async function waitForState(app, taskId, states) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const task = app.runtime.getTask(taskId);
    if (states.includes(task.state)) return task;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw Error('Synthetic task did not reach the expected state');
}

// Fake cloud orchestration only; real Runtime/Policy/ToolGateway, actual tracked
// synthetic-file reading and actual SQLite restart. Not a cloud acceptance.
test('MVP composition reads the synthetic file only after approval, exports a minimal result and preserves evidence', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pa-mvp-tool-'));
  const database = join(directory, 'runtime.sqlite');
  const fixtureRoot = fileURLToPath(new URL('./fixtures/mvp-meeting/', import.meta.url));
  const cloud = new FakeCoordinationPort(request => request.continuation
    ? {kind: 'text', text: 'Synthetic meeting update read at 17:00', verification: 'unverified'}
    : {kind: 'tool_proposal', proposalId: 'mvp-meeting-read', toolName: 'workspace.read_text',
      toolVersion: '1.0.0', arguments: {path: 'meeting-update.json'}, verification: 'unverified'});
  const app = createRuntimeApplication({path: database, profile: 'huawei_ict_agentarts',
    coordination: cloud, ...createSyntheticMeetingToolset(fixtureRoot)});
  let closed = false;
  t.after(async () => {
    if (!closed) await app.close();
    rmSync(directory, {recursive: true, force: true});
  });
  const client = new Client(app);
  await client.connect();
  const {taskId} = await client.call('task.submit', {goal: 'Read the approved synthetic meeting change', conversationId: 'mvp'},
    {idempotencyKey: 'mvp-synthetic-read', timeoutMs: 30_000});
  assert.equal((await waitForState(app, taskId, ['waiting_approval', 'failed'])).state, 'waiting_approval');
  assert.deepEqual(app.runtime.readToolExecutions(taskId), []);
  const approval = (await client.call('approval.list', {taskId})).items[0];
  await client.call('authorization.respond', {approvalId: approval.approvalId,
    expectedRevision: approval.revision, decision: 'allow_once'});
  const completed = await waitForState(app, taskId, ['succeeded', 'failed']);
  assert.equal(completed.state, 'succeeded');
  assert.equal(cloud.requests.length, 2);
  assert.ok(cloud.requests.every(request => request.taskId === taskId));
  assert.deepEqual(cloud.requests[1].continuation, {proposalId: 'mvp-meeting-read', state: 'confirmed',
    result: {meetingId: 'mvp-meeting', revision: 2, start: '17:00', timezone: 'Asia/Shanghai'}});
  const records = app.runtime.readToolExecutions(taskId);
  assert.equal(records.length, 1);
  assert.equal(records[0].state, 'confirmed');
  assert.equal(records[0].policyDecision, 'allow');
  assert.equal(records[0].executionStarted, true);
  assert.equal(records[0].toolName, 'workspace.read_text');
  assert.deepEqual(completed.evidenceRefs, [records[0].evidenceId]);
  const evidence = app.runtime.readEvidence(taskId);
  assert.equal(evidence[0].verification, 'conditional');
  await app.close();
  closed = true;
  const restored = new TaskRuntime(database);
  try {
    assert.deepEqual(restored.getTask(taskId), completed);
    assert.deepEqual(restored.readToolExecutions(taskId), records);
    assert.deepEqual(restored.readEvidence(taskId), evidence);
  } finally { restored.close(); }
});
