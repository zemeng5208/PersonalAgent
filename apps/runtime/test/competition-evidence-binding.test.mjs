import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {Client} from '@personal-agent/client';
import {FakeCoordinationPort} from '@personal-agent/coordination/testing';
import {createPublicFactRepairHostProxy, createRuntimeApplication} from '../dist/application.js';

const key = {vaultId: 'public-demo', path: 'meeting-update.json', factId: 'meeting/update'};
const baseline = {
  goal: {id: 'meeting-goal', summary: 'Prepare for meeting at 15:00'},
  decision: {id: 'meeting-decision', summary: 'Use 15:00 meeting time'},
  plan: {id: 'meeting-plan', summary: 'Remind for 15:00'},
};
const context = () => ({deadline: new Date(Date.now() + 60_000).toISOString(),
  signal: new AbortController().signal});
const sourceContent = '{"meetingId":"mvp-meeting","revision":2,"start":"17:00","timezone":"Asia/Shanghai"}\n';
const sourceBytes = Buffer.from(sourceContent, 'utf8');
const sourceRevision = createHash('sha256').update(sourceBytes).digest('hex');
const sourceResult = {path: key.path, encoding: 'utf-8', byteLength: sourceBytes.byteLength,
  content: sourceContent};
const sourceDescriptor = {
  name: 'workspace.read_text', version: '1.0.0',
  inputSchema: {type: 'object', required: ['path'], additionalProperties: false,
    properties: {path: {type: 'string'}}},
  outputSchema: {type: 'object', required: ['path', 'encoding', 'byteLength', 'content'],
    additionalProperties: false, properties: {path: {type: 'string'},
      encoding: {enum: ['utf-8']}, byteLength: {type: 'integer'}, content: {type: 'string'}}},
  sideEffect: 'read', requiredScopes: ['workspace:read'],
  idempotencySupport: true, recoverySupport: true, requiresPresence: false,
};

async function settle(app, taskId, wanted) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const task = app.runtime.getTask(taskId);
    if (wanted.includes(task.state)) return task;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw Error(`Task ${taskId} did not enter ${wanted.join(', ')}`);
}

test('same confirmed Competition read binds public Fact17 before candidate and repairs affected plan', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pa-evidence-fact-'));
  const sourcePath = join(directory, key.path);
  const runtimePath = join(directory, 'runtime.sqlite');
  const memoryPath = join(directory, 'memory.sqlite');
  writeFileSync(sourcePath, sourceBytes);
  let host;
  let app;
  let bound;
  let projectError;
  let sourceQueue = Promise.resolve();
  const withSourceLock = async work => {
    const previous = sourceQueue;
    let release;
    sourceQueue = new Promise(resolve => {release = resolve;});
    await previous;
    try { return await work(); } finally { release(); }
  };
  const source = {...key, sourceRevision, line: 1, summary: 'Meeting at 17:00',
    observedAt: new Date().toISOString(), validFrom: '2026-09-25T00:00:00.000Z',
    validUntil: '2027-01-01T00:00:00.000Z', expectedFactRevision: 1};
  const repair = createPublicFactRepairHostProxy({getHost: () => host,
    graphNamespace: 'meeting-graph', sourcePath: key.path});
  const coordination = new FakeCoordinationPort(request => request.continuation ? {
    kind: 'repair_candidate', candidateVersion: '1.0',
    candidate: {expectedGraphRevision: bound.binding.graphRevision, changes: [{
      node: bound.binding.allowedTargets[0], summary: 'Remind for 17:00',
      reason: 'Confirmed public meeting time changed',
      dependencies: bound.binding.allowedDependencies,
    }]}, verification: 'unverified',
  } : {kind: 'tool_proposal', proposalId: 'meeting-read',
    toolName: sourceDescriptor.name, toolVersion: sourceDescriptor.version,
    arguments: {path: key.path}, verification: 'unverified'});
  app = createRuntimeApplication({path: runtimePath, profile: 'huawei_ict_agentarts',
    coordination, repairCandidateVersion: '1.0', localRepair: repair,
    tools: [{descriptor: sourceDescriptor, execute: async () => sourceResult}],
    competitionToolExports: [{toolName: sourceDescriptor.name,
      toolVersion: sourceDescriptor.version, exportPolicyVersion: 'public-meeting-v1',
      accepts: ({arguments: args}) => args.path === key.path,
      project: async ({taskId, proposalId, result, signal}) => {
        try {
          bound = await host.bindConfirmedPublicRead({sourceTaskId: taskId, proposalId,
            result, source, baseline}, {deadline: new Date(Date.now() + 60_000).toISOString(), signal});
        } catch (error) { projectError = error; throw error; }
        return {time: '17:00', graphRevision: bound.binding.graphRevision,
          factRef: bound.binding.fact, planRef: bound.binding.allowedTargets[0]};
      }}],
  });
  const hostOptions = {memoryPath, memoryNamespace: 'public-meetings',
    graphNamespace: 'meeting-graph', consumerKey: 'meeting-consumer',
    evidence: {allowedPath: key.path, readSourceBytes: () => readFileSync(sourcePath),
      interpretSource: content => ({line: 1,
        summary: `Meeting at ${JSON.parse(content).start}`}), withSourceLock}};
  host = app.createCompetitionFactHost(hostOptions);
  try {
    host.recordPublicSource({...key, sourceRevision: 'a'.repeat(64), line: 1,
      summary: 'Meeting at 15:00', observedAt: new Date().toISOString(),
      validFrom: source.validFrom, validUntil: source.validUntil,
      expectedFactRevision: null}, context());
    await host.drain({...context(), limit: 10, maxBatches: 2});
    const client = new Client(app);
    await client.connect();
    const submitted = await client.call('task.submit', {goal: 'Read public meeting correction',
      conversationId: 'meeting'}, {idempotencyKey: 'meeting-source'});
    assert.equal((await settle(app, submitted.taskId, ['waiting_approval', 'failed'])).state,
      'waiting_approval');
    const approval = (await client.call('approval.list', {taskId: submitted.taskId})).items[0];
    await client.call('authorization.respond', {approvalId: approval.approvalId,
      expectedRevision: approval.revision, decision: 'allow_once'});
    const sourceTask = await settle(app, submitted.taskId, ['succeeded', 'failed']);
    assert.equal(sourceTask.state, 'succeeded', JSON.stringify({error: sourceTask.error,
      projectError: projectError?.stack, bound}));
    assert.equal(bound.evidenceId, approval.approvalId);
    assert.equal(bound.fact.ref.revision, 2);
    assert.equal(bound.binding.graphRevision, 5);
    assert.deepEqual(host.resolveEvidenceBinding({sourceTaskId: submitted.taskId,
      evidenceId: approval.approvalId}), bound.binding);
    assert.throws(() => host.resolveEvidenceBinding({sourceTaskId: submitted.taskId,
      evidenceId: 'another-approval'}), {code: 'UNAUTHORIZED'});
    const graph = app.runtime.bindCoordinationStore('meeting-graph').read();
    assert.deepEqual(graph.history.slice(1, 4).map(item => [item.kind, item.dependencies.length]),
      [['goal', 1], ['decision', 1], ['plan', 2]]);
    const impact = host.readCompletedImpact(bound.impactBatchToken);
    assert.equal(impact.report.items.find(item => item.node.id === baseline.plan.id).action,
      'RECHECK');
    writeFileSync(sourcePath, sourceContent.replace('17:00', '18:00'));
    const unchanged = app.runtime.bindCoordinationStore('meeting-graph').read();
    const tampered = app.submitLocalRepair({sourceTaskId: submitted.taskId,
      evidenceId: approval.approvalId, idempotencyKey: 'repair-tampered',
      deadline: new Date(Date.now() + 60_000).toISOString()});
    assert.equal((await settle(app, tampered.taskId, ['waiting_approval', 'failed'])).state,
      'waiting_approval');
    const tamperedApproval = (await client.call('approval.list', {taskId: tampered.taskId})).items[0];
    await client.call('authorization.respond', {approvalId: tamperedApproval.approvalId,
      expectedRevision: tamperedApproval.revision, decision: 'allow_once'});
    assert.equal((await settle(app, tampered.taskId, ['succeeded', 'failed'])).state, 'failed');
    assert.deepEqual(app.runtime.bindCoordinationStore('meeting-graph').read(), unchanged);
    writeFileSync(sourcePath, sourceBytes);
    const repairTask = app.submitLocalRepair({sourceTaskId: submitted.taskId,
      evidenceId: approval.approvalId, idempotencyKey: 'repair-meeting',
      deadline: new Date(Date.now() + 60_000).toISOString()});
    assert.equal((await settle(app, repairTask.taskId, ['waiting_approval', 'failed'])).state,
      'waiting_approval');
    const repairApproval = (await client.call('approval.list', {taskId: repairTask.taskId})).items[0];
    await client.call('authorization.respond', {approvalId: repairApproval.approvalId,
      expectedRevision: repairApproval.revision, decision: 'allow_once'});
    assert.equal((await settle(app, repairTask.taskId, ['succeeded', 'failed'])).state,
      'succeeded');
    assert.equal(app.runtime.bindCoordinationStore('meeting-graph').read().history.at(-1).summary,
      'Remind for 17:00');
    host.close(); app.close();
    app = createRuntimeApplication({path: runtimePath, profile: 'huawei_ict_agentarts'});
    host = app.createCompetitionFactHost(hostOptions);
    assert.deepEqual(host.resolveEvidenceBinding({sourceTaskId: submitted.taskId,
      evidenceId: approval.approvalId}), bound.binding);
    assert.equal(app.runtime.bindCoordinationStore('meeting-graph').read().history.at(-1).summary,
      'Remind for 17:00');
  } finally {
    host.close(); app.close();
    rmSync(directory, {recursive: true, force: true});
  }
});
