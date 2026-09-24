import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {Client} from '@personal-agent/client';
import {FakeCoordinationPort} from '@personal-agent/coordination/testing';
import {createRuntimeApplication} from '@personal-agent/runtime/application';
import {currentNodes} from '@personal-agent/goals';
import {createSyntheticMeetingToolset} from '../../../apps/desktop/electron/competition-synthetic-workspace.js';
import {createSyntheticRepairHost} from '../../../apps/desktop/electron/competition-repair-host.js';

const fixtureRoot = fileURLToPath(new URL('./fixtures/mvp-meeting/', import.meta.url));
async function state(app, taskId, wanted) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const task = app.runtime.getTask(taskId);
    if (wanted.includes(task.state)) return task;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw Error('Synthetic task did not settle');
}
async function approve(client, taskId) {
  const approval = (await client.call('approval.list', {taskId})).items[0];
  assert.ok(approval);
  await client.call('authorization.respond', {approvalId: approval.approvalId,
    expectedRevision: approval.revision, decision: 'allow_once'});
}

test('confirmed synthetic read produces exact graph-bound candidate, separate approved CAS, and restart readback', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pa-mvp-repair-host-'));
  const runtimePath = join(directory, 'runtime.sqlite');
  const memoryPath = join(directory, 'memory.sqlite');
  let host;
  let app;
  t.after(() => {
    try { app?.close(); } finally { host?.close(); rmSync(directory, {recursive: true, force: true}); }
  });
  const cloud = new FakeCoordinationPort(request => {
    if (!request.continuation) return {kind: 'tool_proposal', proposalId: 'mvp-meeting-read-1',
      toolName: 'workspace.read_text', toolVersion: '1.0.0',
      arguments: {path: 'meeting-update.json'}, verification: 'unverified'};
    const context = request.continuation.result.repairContext;
    assert.equal(context.targets.length, 3);
    return {kind: 'repair_candidate', candidateVersion: '1.0', verification: 'unverified',
      candidate: {expectedGraphRevision: context.expectedGraphRevision, changes: [
        {node: context.targets[0].node, summary: 'Attend meeting at 17:00',
          reason: 'Confirmed synthetic meeting correction', dependencies: [context.projectedFact]},
        {node: context.targets[1].node, summary: 'Prepare one hour before 17:00 meeting',
          reason: 'Dependent attendance time changed',
          dependencies: [{id: 'attend', revision: context.targets[0].node.revision + 1}]},
        {node: context.targets[2].node, summary: 'Prepare at 16:00',
          reason: 'One hour before confirmed meeting',
          dependencies: [{id: 'prepare', revision: context.targets[1].node.revision + 1}]},
      ]}};
  });
  async function open() {
    host = createSyntheticRepairHost(memoryPath);
    app = createRuntimeApplication({path: runtimePath, profile: 'huawei_ict_agentarts',
      coordination: cloud, repairCandidateVersion: '1.0', localRepair: host.localRepair,
      ...createSyntheticMeetingToolset(fixtureRoot, input => host.projectConfirmed(input))});
    await host.initialize(app.runtime);
  }
  await open();
  const client = new Client(app);
  await client.connect();
  const {taskId} = await client.call('task.submit', {goal: 'Read synthetic meeting change', conversationId: 'mvp'},
    {idempotencyKey: 'mvp-repair-source', timeoutMs: 60_000});
  assert.equal((await state(app, taskId, ['waiting_approval', 'failed'])).state, 'waiting_approval');
  assert.equal(app.runtime.bindCoordinationStore('mvp-synthetic-meeting').read().revision, 5);
  await approve(client, taskId);
  const source = await state(app, taskId, ['succeeded', 'failed']);
  assert.equal(source.state, 'succeeded');
  assert.equal(cloud.requests.length, 2);
  if (process.env.PA_MVP_CONTEXT_OUTPUT) {
    const context = cloud.requests[1].continuation.result.repairContext;
    writeFileSync(process.env.PA_MVP_CONTEXT_OUTPUT, JSON.stringify(context, null, 2));
  }
  const candidate = app.readRepairCandidate(taskId);
  assert.equal(candidate.candidate.expectedGraphRevision, 6);
  app.runtime.saveCheckpoint(taskId, 'competition-repair-candidate', {...candidate,
    candidate: {...candidate.candidate, changes: candidate.candidate.changes.map((change, index) =>
      index === 2 ? {...change, dependencies: []} : change)}});
  assert.throws(() => host.readBinding(taskId), /Synthetic repair source unavailable/,
    'The cloud may not erase the preparation dependency');
  app.runtime.saveCheckpoint(taskId, 'competition-repair-candidate', candidate);
  const binding = host.readBinding(taskId);
  assert.equal(binding.binding.graphRevision, 6);
  assert.deepEqual(binding.binding.fact, {id: 'meeting/time', revision: 2});
  const before = host.readGraph();
  const unrelated = currentNodes(before).find(item => item.id === 'unrelated');
  const local = app.submitLocalRepair({sourceTaskId: taskId, evidenceId: binding.evidenceId,
    idempotencyKey: 'mvp-repair-local', deadline: new Date(Date.now() + 60_000).toISOString()});
  assert.equal((await state(app, local.taskId, ['waiting_approval', 'failed'])).state, 'waiting_approval');
  assert.deepEqual(host.readGraph(), before, 'A candidate and pending approval cannot write the graph');
  await approve(client, local.taskId);
  assert.equal((await state(app, local.taskId, ['succeeded', 'failed'])).state, 'succeeded');
  const after = host.readGraph();
  assert.equal(after.revision, before.revision + 3);
  assert.equal(currentNodes(after).find(item => item.id === 'preparation').summary, 'Prepare at 16:00');
  assert.deepEqual(currentNodes(after).find(item => item.id === 'unrelated'), unrelated);
  app.close(); host.close(); app = undefined; host = undefined;
  await open();
  assert.equal(app.runtime.getTask(taskId).state, 'succeeded');
  assert.equal(app.runtime.getTask(local.taskId).state, 'succeeded');
  assert.deepEqual(host.readGraph(), after);
  assert.equal(cloud.requests.length, 2, 'Readback never replays paid cloud calls');
});
