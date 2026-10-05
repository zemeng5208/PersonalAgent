import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {Client} from '@personal-agent/client';
import {openSqliteLearningHost} from '@personal-agent/learning';
import {createAgentArtsRuntimeApplication, createReadonlyMcpHost,
  createWorkflowLearningApplication, LEARNING_BINDING_CHECKPOINT} from '@personal-agent/runtime/application';

const context = () => ({deadline: new Date(Date.now() + 60000).toISOString(), signal: new AbortController().signal});
async function settled(app, taskId) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (!app.activeTaskCount) return app.runtime.getTask(taskId);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw Error('Local reference Skill worker did not settle');
}

test('official MCP and SQLite approval validate learning; activation, rollback, restart and erasure retain their gates', async t => {
  const parent = fileURLToPath(new URL('../../.cache/memory-learning-mcp/', import.meta.url));
  await mkdir(parent, {recursive: true});
  const directory = await mkdtemp(join(parent, 'case-'));
  const text = 'Public synthetic workflow reference.\nPreserve this source file.\n';
  await writeFile(join(directory, 'reference.md'), text);
  const mcp = createReadonlyMcpHost({rootPath: directory, nodeExecutable: process.execPath, enabled: true});
  const namespace = 'synthetic-mcp-learning';
  let app, store, learning, client, calls = 0, cloudCalls = 0, allowActivation = false;
  const confirmations = [];
  t.after(async () => {
    app?.close(); store?.close(); await mcp.dispose();
    assert.equal(dirname(directory), resolve(parent));
    await rm(directory, {recursive: true, force: true});
  });
  await mcp.start({...context(), deadline: new Date(Date.now() + 15000).toISOString()});
  const tool = {...mcp.tools[0], execute: async (...args) => {calls++; return mcp.tools[0].execute(...args);}};
  async function open() {
    app = createAgentArtsRuntimeApplication({path: join(directory, 'runtime.sqlite'),
      hostUserNamespace: namespace, tools: [tool], gatewayUrl: 'https://learning.example.test',
      runtimeName: 'synthetic-unused', invokeMode: 'published',
      authorizationProvider: {read: async () => {cloudCalls++; throw Error('Cloud authorization must not be requested');}},
      fetchImpl: async () => {cloudCalls++; throw Error('Cloud invocation must not be requested');}});
    app.configureReferenceSkill({enabled: true, isToolAvailable: () => mcp.health().connected,
      currentConfigurationRef: () => 'synthetic-local-mcp-configuration', assertDispatchBinding(taskId) {
        const binding = app.runtime.loadCheckpoint(taskId, LEARNING_BINDING_CHECKPOINT);
        if (binding !== undefined) learning.assertDispatchBinding(binding);
      }});
    store = openSqliteLearningHost(join(directory, 'learning.sqlite'));
    store.resumeErasureMaintenance(namespace);
    learning = createWorkflowLearningApplication({profile: 'huawei_ict_agentarts', namespace, learning: store,
      runtime: app.runtime, skillManifest: () => app.referenceSkillSnapshot().manifest,
      submitSkillTask: (binding, scope) => app.submitReferenceSkillTask({skillId: binding.skillId,
        version: binding.version, digest: binding.digest, path: binding.path, idempotencyKey: binding.operationId,
        deadline: scope.deadline, conversationId: `learning:${namespace}`,
        hostBinding: {key: LEARNING_BINDING_CHECKPOINT, value: binding}}).taskId,
      // Explicit Fake native decisions; the MCP service and Runtime approval below are real local components.
      confirmActivation: async binding => {confirmations.push(binding); return allowActivation;},
      confirmDeletion: async () => true});
    client = new Client(app, Date.now);
    await client.connect();
  }
  await open();
  const workflowId = 'reference-review';
  const propose = (expectedRevision, operationId, id = workflowId) => learning.propose({workflowId: id,
    expectedRevision, operationId, summary: 'Summarize the public reference', path: 'reference.md',
    createdAt: new Date().toISOString(), ...context()});
  const activate = (revision, expectedActiveRevision, operationId) => learning.activate({workflowId, revision,
    expectedActiveRevision, operationId, activatedAt: new Date().toISOString(), ...context()});
  const submit = (method, revision, operationId) => learning[method]({workflowId, revision, operationId, ...context()});
  async function waiting(taskId) {
    assert.equal((await settled(app, taskId)).state, 'waiting_approval');
    const binding = app.runtime.loadCheckpoint(taskId, LEARNING_BINDING_CHECKPOINT);
    const approvalId = `skill-read-${taskId}-${binding.digest.slice(0, 16)}`;
    const approval = app.runtime.getApproval(approvalId);
    assert.equal(approval.state, 'pending');
    return {approvalId, expectedRevision: approval.revision, decision: 'allow_once'};
  }
  async function approve(taskId, response) {
    await client.call('authorization.respond', response ?? await waiting(taskId));
    return settled(app, taskId);
  }
  async function validate(revision, operationId) {
    const task = await submit('startValidation', revision, operationId);
    const before = calls;
    const approval = await waiting(task.taskId);
    assert.equal(calls, before);
    assert.equal((await learning.validate({workflowId, revision, taskId: task.taskId, ...context()})).state, 'pending');
    assert.equal((await approve(task.taskId, approval)).state, 'succeeded');
    const record = app.runtime.readToolExecutions(task.taskId)[0];
    assert.equal(record.state, 'confirmed');
    assert.equal(record.policyDecision, 'allow');
    assert.equal(record.executionStarted, true);
    assert.ok(app.runtime.readEvidence(task.taskId).some(item => item.evidenceId === record.evidenceId));
    const checkpoint = app.runtime.loadCheckpoint(task.taskId, `tool-result-${record.evidenceId}`);
    assert.equal(checkpoint.result.source, 'mcp');
    assert.equal(checkpoint.result.text, text);
    assert.equal(checkpoint.result.contentDigest, createHash('sha256').update(text).digest('hex'));
    assert.equal((await learning.validate({workflowId, revision, taskId: task.taskId, ...context()})).version.validation, 'passed');
    assert.equal(calls, before + 1);
  }

  assert.equal(propose(null, 'propose-one').validation, 'candidate');
  await assert.rejects(activate(1, null, 'premature-activation'), {code: 'NOT_VALIDATED'});
  assert.equal(confirmations.length, 0);
  await validate(1, 'validate-one');
  assert.equal((await activate(1, null, 'decline-one')).state, 'declined');
  assert.equal(learning.readActive(workflowId), null);
  allowActivation = true;
  assert.equal((await activate(1, null, 'activate-one')).receipt.toRevision, 1);
  const first = await submit('run', 1, 'execute-one');
  const firstApproval = await waiting(first.taskId);
  assert.equal(calls, 1);
  assert.equal((await approve(first.taskId, firstApproval)).state, 'succeeded');

  assert.equal(propose(1, 'propose-two').revision, 2);
  await validate(2, 'validate-two');
  await activate(2, 1, 'activate-two');
  const obsolete = await submit('run', 2, 'queued-before-rollback');
  const obsoleteApproval = await waiting(obsolete.taskId);
  await activate(1, 2, 'rollback-one');
  const refused = await approve(obsolete.taskId, obsoleteApproval);
  assert.equal(refused.state, 'failed');
  assert.equal(refused.error.code, 'EXTERNAL_FAILURE');
  assert.equal(app.runtime.readEvents().filter(event => event.taskId === obsolete.taskId).at(-1).type, 'task.failed');
  assert.equal(calls, 3);
  assert.equal(app.runtime.readToolExecutions(obsolete.taskId).filter(item => item.executionStarted).length, 0);
  assert.equal(learning.readActive(workflowId).revision, 1);

  app.close(); store.close();
  await open();
  assert.equal(learning.readVersion(workflowId, 2).validation, 'passed');
  assert.equal(learning.readActive(workflowId).revision, 1);
  assert.throws(() => learning.run({workflowId, revision: 2, operationId: 'inactive-after-restart', ...context()}),
    {code: 'NOT_VALIDATED'});
  const restarted = await submit('run', 1, 'execute-after-restart');
  const restartApproval = await waiting(restarted.taskId);
  assert.equal(calls, 3);
  assert.equal((await approve(restarted.taskId, restartApproval)).state, 'succeeded');
  assert.equal(calls, 4);

  const independent = propose(null, 'independent-candidate', 'preserve-independent');
  const queued = await submit('run', 1, 'queued-before-erasure');
  await waiting(queued.taskId);
  assert.equal((await learning.erase({workflowId, expectedRevision: 2, operationId: 'erase-workflow', ...context()})).state, 'deleted');
  assert.equal((await settled(app, queued.taskId)).state, 'cancelled');
  assert.equal(learning.readActive(workflowId), null);
  for (const revision of [1, 2]) assert.throws(() => learning.readVersion(workflowId, revision), {code: 'NOT_FOUND'});
  assert.deepEqual(learning.readVersion(independent.workflowId, 1), independent);
  assert.equal(store.readErasureReceipt(namespace, workflowId).operationId, 'erase-workflow');
  assert.equal(await readFile(join(directory, 'reference.md'), 'utf8'), text);
  assert.equal(calls, 4);
  assert.equal(cloudCalls, 0);
});
