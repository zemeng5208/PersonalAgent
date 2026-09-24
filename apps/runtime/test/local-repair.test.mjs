import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Client} from '@personal-agent/client';
import {ProtocolError} from '@personal-agent/contracts';
import {FakeCoordinationPort} from '@personal-agent/coordination/testing';
import {createRuntimeApplication} from '../dist/application.js';

const sourceArguments = {id: 'synthetic-meeting'};
const sourceTool = {name: 'fixture.meeting', version: '1.0.0', arguments: sourceArguments};
const sourceDescriptor = {
  name: sourceTool.name, version: sourceTool.version,
  inputSchema: {type: 'object', required: ['id'], additionalProperties: false,
    properties: {id: {type: 'string'}}},
  outputSchema: {type: 'object', required: ['time'], additionalProperties: false,
    properties: {time: {type: 'string'}}},
  sideEffect: 'read', requiredScopes: ['fixture:read'],
  idempotencySupport: true, recoverySupport: true, requiresPresence: false,
};
const sourceProposal = {kind: 'tool_proposal', proposalId: 'meeting-1',
  toolName: sourceTool.name, toolVersion: sourceTool.version,
  arguments: sourceArguments, verification: 'unverified'};
const later = () => new Date(Date.now() + 86_400_000).toISOString();
const earlier = () => new Date(Date.now() - 86_400_000).toISOString();
const node = (id, kind, summary, sourceRef, dependencies = []) => ({
  id, kind, summary, sourceRef, dependencies, sensitivity: 'private',
  state: 'active', reason: 'synthetic fixture', validFrom: earlier(), validUntil: later(),
});

async function settle(app, taskId, wanted) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const task = app.runtime.getTask(taskId);
    if (wanted.includes(task.state)) return task;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw Error(`Task ${taskId} did not enter ${wanted.join(', ')}`);
}

async function approve(client, taskId, decision = 'allow_once') {
  const approval = (await client.call('approval.list', {taskId})).items[0];
  assert.ok(approval);
  await client.call('authorization.respond', {approvalId: approval.approvalId,
    expectedRevision: approval.revision, decision});
  return approval;
}

function fixture(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'pa-local-repair-'));
  const path = join(directory, 'runtime.sqlite');
  let app;
  let executions = 0;
  let binding;
  let fact;
  let sourceQueue = Promise.resolve();
  const host = {
    graphNamespace: 'synthetic-meeting', bindingVersion: 'fixture-v1', sourceTool,
    memory: {async listCurrent() { return {snapshot: 'synthetic', facts: fact ? [structuredClone(fact)] : []}; }},
    async withSourceLock(work) {
      const before = sourceQueue;
      let release;
      sourceQueue = new Promise(resolve => {release = resolve;});
      await before;
      try {return await work();} finally {release();}
    },
    resolveBinding: () => structuredClone(binding),
    matchesSource: ({result, fact}) => result.time === '17:00' && fact.summary === 'Meeting at 17:00',
  };
  const proposalResult = {kind: 'repair_candidate', candidateVersion: '1.0',
    candidate: {expectedGraphRevision: 4, changes: [{
      node: {id: 'plan', revision: 1}, summary: 'Remind for 17:00',
      reason: 'Meeting time corrected by a read observation',
      dependencies: [{id: 'meeting', revision: 2}],
    }]}, verification: 'unverified'};
  const port = new FakeCoordinationPort(request => request.continuation ? proposalResult : sourceProposal);
  const create = () => createRuntimeApplication({path, profile: 'huawei_ict_agentarts',
    coordination: port, repairCandidateVersion: '1.0', localRepair: host,
    competitionToolExports: [{toolName: sourceTool.name, toolVersion: sourceTool.version,
      exportPolicyVersion: 'fixture-v1', accepts: ({arguments: args}) => args.id === sourceArguments.id,
      project: ({taskId, result}) => {
        const evidenceId = app.runtime.readToolExecutions(taskId).find(record => record.state === 'confirmed')?.evidenceId;
        assert.ok(evidenceId, 'real confirmed read evidence is required');
        const store = app.runtime.provisionCoordinationStore(host.graphNamespace);
        const sourceRef = `tool-evidence:${evidenceId}`;
        const oldFact = store.append(0, node('meeting', 'fact', 'Meeting at 16:00', 'synthetic-old'));
        const plan = store.append(oldFact.revision, node('plan', 'plan', 'Remind for 16:00',
          'synthetic-plan', [{id: 'meeting', revision: 1}]));
        store.append(plan.revision, node('unrelated', 'plan', 'Unrelated plan', 'synthetic-unrelated'));
        const validFrom = earlier();
        const validUntil = later();
        const newest = store.append(3, {...node('meeting', 'fact', 'Meeting at 17:00', sourceRef),
          validFrom, validUntil});
        fact = {ref: {id: 'meeting', revision: 2}, summary: 'Meeting at 17:00', sourceRef,
          observedAt: new Date().toISOString(), validFrom, validUntil,
          sensitivity: 'private', state: 'active', confirmation: 'external_observation',
          corrects: {id: 'meeting', revision: 1}};
        binding = {fact: fact.ref, node: {id: 'meeting', revision: 2},
          graphRevision: newest.revision, allowedTargets: [{id: 'plan', revision: 1}],
          allowedDependencies: [{id: 'meeting', revision: 2}]};
        return {time: result.time};
      }}],
    tools: [{descriptor: sourceDescriptor, execute: async () => {executions++; return {time: '17:00'};}}],
  });
  app = create();
  t.after(() => {app.close(); rmSync(directory, {recursive: true, force: true});});
  return {
    get app() {return app;}, host, port, path, create,
    replaceApp(next) {app = next;},
    fact: () => fact, setFact(next) {fact = next;},
    binding: () => binding,
    executions: () => executions,
    async source() {
      const client = new Client(app);
      await client.connect();
      const {taskId} = await client.call('task.submit', {goal: 'Read meeting and request repair',
        conversationId: 'synthetic-repair'}, {idempotencyKey: 'source'});
      assert.equal((await settle(app, taskId, ['waiting_approval', 'failed'])).state, 'waiting_approval');
      const originalApproval = await approve(client, taskId);
      assert.equal((await settle(app, taskId, ['succeeded', 'failed'])).state, 'succeeded');
      assert.ok(app.readRepairCandidate(taskId));
      assert.equal(app.runtime.bindCoordinationStore(host.graphNamespace).read().revision, 4);
      return {client, taskId, evidenceId: originalApproval.approvalId};
    },
    async repair(sourceTaskId, evidenceId, key = 'repair-once') {
      const repair = app.submitLocalRepair({sourceTaskId, evidenceId,
        idempotencyKey: key, deadline: new Date(Date.now() + 30_000).toISOString()});
      assert.equal((await settle(app, repair.taskId, ['waiting_approval', 'failed'])).state, 'waiting_approval');
      return repair;
    },
  };
}

test('approved separate local task commits the selected plan by CAS and reads back persisted graph', async t => {
  const f = fixture(t);
  const {client, taskId, evidenceId} = await f.source();
  const before = f.app.runtime.bindCoordinationStore(f.host.graphNamespace).read();
  const request = {sourceTaskId: taskId, evidenceId, idempotencyKey: 'approved-once',
    deadline: new Date(Date.now() + 30_000).toISOString()};
  const repair = f.app.submitLocalRepair(request);
  assert.equal((await settle(f.app, repair.taskId, ['waiting_approval'])).state, 'waiting_approval');
  assert.equal(f.executions(), 1);
  assert.deepEqual(f.app.runtime.bindCoordinationStore(f.host.graphNamespace).read(), before);
  assert.equal((await client.call('approval.list', {taskId: repair.taskId})).items.length, 1);
  await approve(client, repair.taskId);
  const complete = await settle(f.app, repair.taskId, ['succeeded', 'failed', 'waiting_reconciliation']);
  assert.equal(complete.state, 'succeeded', JSON.stringify(complete.error));
  const after = f.app.runtime.bindCoordinationStore(f.host.graphNamespace).read();
  assert.equal(after.revision, 5);
  assert.equal(after.history.findLast(item => item.id === 'plan').summary, 'Remind for 17:00');
  assert.deepEqual(after.history.find(item => item.id === 'unrelated'), before.history.find(item => item.id === 'unrelated'));
  assert.equal(f.app.runtime.readToolExecutions(repair.taskId)[0].state, 'confirmed');
  assert.equal(f.app.runtime.readToolExecutions(repair.taskId)[0].toolName, 'cognition.commit_repair');
  f.app.close();
  const reopened = f.create();
  f.replaceApp(reopened);
  assert.equal(reopened.runtime.getTask(repair.taskId).state, 'succeeded');
  assert.deepEqual(reopened.runtime.bindCoordinationStore(f.host.graphNamespace).read(), after);
  const repeat = reopened.submitLocalRepair(request);
  assert.equal(repeat.taskId, repair.taskId);
  assert.equal(repeat.state, 'succeeded');
  assert.equal(reopened.runtime.bindCoordinationStore(f.host.graphNamespace).read().revision, 5);
});

test('denied local approval leaves the graph and source task unchanged', async t => {
  const f = fixture(t);
  const {client, taskId, evidenceId} = await f.source();
  const repair = await f.repair(taskId, evidenceId);
  await approve(client, repair.taskId, 'deny');
  assert.equal((await settle(f.app, repair.taskId, ['cancelled'])).state, 'cancelled');
  assert.equal(f.app.runtime.bindCoordinationStore(f.host.graphNamespace).read().revision, 4);
  assert.equal(f.app.runtime.getTask(taskId).state, 'succeeded');
});

test('changed current FactRef is rejected after approval without a graph write', async t => {
  const f = fixture(t);
  const {client, taskId, evidenceId} = await f.source();
  const repair = await f.repair(taskId, evidenceId);
  f.setFact({...f.fact(), ref: {id: 'meeting', revision: 3}});
  await approve(client, repair.taskId);
  const stopped = await settle(f.app, repair.taskId, ['failed', 'waiting_reconciliation']);
  assert.equal(stopped.state, 'failed');
  assert.equal(f.app.runtime.bindCoordinationStore(f.host.graphNamespace).read().revision, 4);
});

test('stale graph and denied selection both fail before a write', async t => {
  const f = fixture(t);
  const {client, taskId, evidenceId} = await f.source();
  const repair = await f.repair(taskId, evidenceId);
  const store = f.app.runtime.bindCoordinationStore(f.host.graphNamespace);
  store.append(4, node('new-unrelated', 'plan', 'Someone else changed the graph', 'synthetic-other'));
  await approve(client, repair.taskId);
  assert.equal((await settle(f.app, repair.taskId, ['failed'])).state, 'failed');
  assert.equal(store.read().revision, 5);

  const f2 = fixture(t);
  const source2 = await f2.source();
  f2.binding().allowedTargets.length = 0;
  assert.throws(() => f2.app.submitLocalRepair({sourceTaskId: source2.taskId,
    evidenceId: source2.evidenceId, idempotencyKey: 'out-of-scope', deadline: later()}),
  {code: 'UNAUTHORIZED'});
  assert.equal(f2.app.runtime.bindCoordinationStore(f2.host.graphNamespace).read().revision, 4);
});

test('candidate cannot silently remove a baseline plan dependency', async t => {
  const f = fixture(t);
  const {taskId, evidenceId} = await f.source();
  const candidate = f.app.readRepairCandidate(taskId);
  candidate.candidate.changes[0].dependencies = [];
  f.app.runtime.saveCheckpoint(taskId, 'competition-repair-candidate', candidate);
  assert.throws(() => f.app.submitLocalRepair({sourceTaskId: taskId, evidenceId,
    idempotencyKey: 'sever-fact-link', deadline: later()}), {code: 'UNAUTHORIZED'});
  assert.equal(f.app.runtime.bindCoordinationStore(f.host.graphNamespace).read().revision, 4);
});

test('shared source lock serializes Fact ingestion before the repair reads current Fact', async t => {
  const f = fixture(t);
  const {client, taskId, evidenceId} = await f.source();
  const repair = await f.repair(taskId, evidenceId);
  let entered;
  const lockEntered = new Promise(resolve => {entered = resolve;});
  let release;
  const gate = new Promise(resolve => {release = resolve;});
  const ingest = f.host.withSourceLock(async () => {
    entered();
    await gate;
    f.setFact({...f.fact(), ref: {id: 'meeting', revision: 3}});
  });
  await lockEntered;
  await approve(client, repair.taskId);
  release();
  await ingest;
  assert.equal((await settle(f.app, repair.taskId, ['failed'])).state, 'failed');
  assert.equal(f.app.runtime.bindCoordinationStore(f.host.graphNamespace).read().revision, 4);
});

test('unknown result after durable CAS survives restart and never replays the local write', async t => {
  const f = fixture(t);
  const {client, taskId, evidenceId} = await f.source();
  const request = {sourceTaskId: taskId, evidenceId, idempotencyKey: 'crash-after-cas',
    deadline: new Date(Date.now() + 30_000).toISOString()};
  const repair = f.app.submitLocalRepair(request);
  assert.equal((await settle(f.app, repair.taskId, ['waiting_approval'])).state, 'waiting_approval');
  const originalBind = f.app.runtime.bindCoordinationStore.bind(f.app.runtime);
  f.app.runtime.bindCoordinationStore = namespace => {
    const store = originalBind(namespace);
    return {...store, read: store.read.bind(store), append: store.append.bind(store),
      appendBatch: (revision, nodes) => {
        const committed = store.appendBatch(revision, nodes);
        assert.equal(committed.revision, 5);
        throw new ProtocolError('RESULT_UNKNOWN', 'Simulated process loss after durable CAS');
      }};
  };
  await approve(client, repair.taskId);
  assert.equal((await settle(f.app, repair.taskId, ['waiting_reconciliation', 'failed'])).state,
    'waiting_reconciliation');
  assert.equal(originalBind(f.host.graphNamespace).read().revision, 5);
  f.app.close();
  const reopened = f.create();
  f.replaceApp(reopened);
  const replay = reopened.submitLocalRepair(request);
  assert.equal(replay.taskId, repair.taskId);
  assert.equal(replay.state, 'waiting_reconciliation');
  assert.equal(reopened.runtime.bindCoordinationStore(f.host.graphNamespace).read().revision, 5);
  assert.equal(reopened.runtime.readToolExecutions(repair.taskId).length, 1);
});

test('one idempotency key is bound to the original candidate and deadline', async t => {
  const f = fixture(t);
  const {taskId, evidenceId} = await f.source();
  const request = {sourceTaskId: taskId, evidenceId, idempotencyKey: 'one-intent', deadline: later()};
  const first = f.app.submitLocalRepair(request);
  assert.equal((await settle(f.app, first.taskId, ['waiting_approval'])).state, 'waiting_approval');
  assert.equal(f.app.submitLocalRepair(request).taskId, first.taskId);
  assert.throws(() => f.app.submitLocalRepair({...request, deadline: new Date(Date.now() + 100_000).toISOString()}),
    {code: 'REVISION_CONFLICT'});
  assert.equal(f.app.runtime.bindCoordinationStore(f.host.graphNamespace).read().revision, 4);
});
