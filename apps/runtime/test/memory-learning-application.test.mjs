import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {openSqliteLearningHost} from '@personal-agent/learning';
import {openSqliteMemoryHost} from '@personal-agent/memory/sqlite';
import {createReferenceSummarySkill} from '@personal-agent/skills';
import {RuntimeToolInvoker} from '@personal-agent/agents';
import {InMemoryAuthorizationPolicy} from '@personal-agent/policy';
import {ToolGateway, toolArgumentsDigest} from '@personal-agent/tool-gateway';
import {TaskRuntime} from '../dist/index.js';
import {createSqliteFactProjectionHost} from '../dist/application/sqlite-fact-projection.js';
import {createWorkflowLearningApplication, createBoundPublicFactErasureApplication,
  LEARNING_BINDING_CHECKPOINT} from '../dist/application/memory-learning.js';

const context = () => ({deadline: new Date(Date.now() + 60_000).toISOString(), signal: new AbortController().signal});
const hash = text => createHash('sha256').update(text).digest('hex');
async function directory(t) {
  const parent = fileURLToPath(new URL('../../../.cache/memory-learning-runtime/', import.meta.url));
  await mkdir(parent, {recursive: true});
  const base = await mkdtemp(join(parent, 'case-'));
  return base;
}

async function learningFixture(t) {
  const base = await directory(t);
  await writeFile(join(base, 'reference.md'), 'Public synthetic reference.\nA second source line.\n');
  const learning = openSqliteLearningHost(join(base, 'learning.sqlite'));
  const policy = new InMemoryAuthorizationPolicy();
  const gateway = new ToolGateway({policy});
  let calls = 0;
  let corrupt = false;
  gateway.register({descriptor: {name: 'mcp.workspace.read_text', version: '1.0.0', sideEffect: 'read',
    inputSchema: {type: 'object', required: ['path'], properties: {path: {type: 'string'}}, additionalProperties: false},
    outputSchema: {type: 'object'}, requiredScopes: ['synthetic:read'], idempotencySupport: true,
    recoverySupport: true, requiresPresence: false}, execute: async input => {
    calls++;
    const text = await readFile(join(base, input.path), 'utf8');
    return {path: input.path, text, contentDigest: corrupt ? '0'.repeat(64) : hash(text), source: 'mcp', serverVersion: 'synthetic'};
  }});
  const runtime = new TaskRuntime(join(base, 'runtime.sqlite'), {toolGateway: gateway});
  const skill = createReferenceSummarySkill({enabled: true, tools: new RuntimeToolInvoker(runtime, gateway.list()),
    isToolAvailable: () => true});
  let learningApp;
  const submissions = new Map();
  let allowActivation = false;
  let onDeletion;
  const submitSkillTask = binding => {
    const task = runtime.submitTaskWithCheckpoint({goal: 'Validate or execute a fixed public reference workflow',
      conversationId: 'learning:desktop-learning', idempotencyKey: binding.operationId}, LEARNING_BINDING_CHECKPOINT, binding);
    submissions.set(task.taskId, binding);
    return task.taskId;
  };
  const make = () => createWorkflowLearningApplication({profile: 'huawei_ict_agentarts', namespace: 'desktop-learning',
    learning, runtime, skillManifest: () => skill.manifest(), submitSkillTask,
    confirmActivation: async () => allowActivation, confirmDeletion: async () => {await onDeletion?.(); return true;}});
  learningApp = make();
  const dispatch = async taskId => {
    const binding = submissions.get(taskId);
    const scope = context();
    const runId = `skill-read-${taskId}-${binding.digest.slice(0, 16)}`;
    // Explicit synthetic trusted-host grant. Neither learned candidate nor Skill issues it.
    policy.grant({authorizationRef: runId, taskId, toolName: 'mcp.workspace.read_text', scopes: ['synthetic:read'],
      argumentsDigest: toolArgumentsDigest({path: binding.path}), expiresAt: scope.deadline, maxUses: 1});
    return runtime.runTask(taskId, async worker => {
      learningApp.assertDispatchBinding(binding);
      const result = await skill.invoke({skillId: binding.skillId, version: binding.version,
        digest: binding.digest, path: binding.path}, worker);
      learningApp.assertDispatchBinding(binding);
      return {resultSummary: result.resultSummary, evidenceRefs: result.evidenceRefs};
    }, {deadline: scope.deadline, sideEffect: 'read'});
  };
  t.after(async () => {skill.dispose(); learning.close(); runtime.close(); await rm(base, {recursive: true, force: true});});
  return {learning, runtime, app: learningApp, skill, dispatch,
    setAllowed(value) {allowActivation = value;}, setCorrupt(value) {corrupt = value;},
    setOnDeletion(callback) {onDeletion = callback;}, calls: () => calls};
}

const propose = (app, expectedRevision = null, summary = 'Summarize public reference') => app.propose({
  workflowId: 'reference-review', expectedRevision, operationId: `propose-${expectedRevision ?? 0}`,
  summary, path: 'reference.md', createdAt: new Date().toISOString(), ...context()});
const activate = (app, revision, expectedActiveRevision, operationId) => app.activate({
  workflowId: 'reference-review', revision, expectedActiveRevision, operationId,
  activatedAt: new Date().toISOString(), ...context()});
const validate = async (f, revision, op) => {
  const task = await f.app.startValidation({workflowId: 'reference-review', revision, operationId: op, ...context()});
  assert.equal((await f.app.validate({workflowId: 'reference-review', revision, taskId: task.taskId, ...context()})).state, 'pending');
  await f.dispatch(task.taskId);
  return f.app.validate({workflowId: 'reference-review', revision, taskId: task.taskId, ...context()});
};

test('fixed Skill validation uses Runtime/Policy/tool Evidence; activation, run, rollback and deletion are separate', async t => {
  const f = await learningFixture(t);
  assert.equal(propose(f.app).validation, 'candidate');
  await assert.rejects(activate(f.app, 1, null, 'activate-before-validation'), {code: 'NOT_VALIDATED'});
  assert.equal((await validate(f, 1, 'validate-one')).version.validation, 'passed');
  assert.equal((await activate(f.app, 1, null, 'declined-activation')).state, 'declined');
  f.setAllowed(true);
  assert.equal((await activate(f.app, 1, null, 'activate-one')).receipt.toRevision, 1);
  const run = await f.app.run({workflowId: 'reference-review', revision: 1, operationId: 'run-one', ...context()});
  assert.equal((await f.dispatch(run.taskId)).state, 'succeeded');
  assert.equal(f.runtime.readToolExecutions(run.taskId)[0].policyDecision, 'allow');
  assert.equal(propose(f.app, 1, 'Updated description').revision, 2);
  assert.equal((await validate(f, 2, 'validate-two')).version.validation, 'passed');
  await activate(f.app, 2, 1, 'activate-two');
  const oldBinding = f.runtime.loadCheckpoint(run.taskId, LEARNING_BINDING_CHECKPOINT);
  assert.throws(() => f.app.assertDispatchBinding(oldBinding), {code: 'NOT_VALIDATED'});
  await activate(f.app, 1, 2, 'rollback-one');
  assert.equal(f.app.readActive('reference-review').revision, 1);
  const queued = await f.app.run({workflowId: 'reference-review', revision: 1, operationId: 'queued-before-erase', ...context()});
  assert.equal((await f.app.erase({workflowId: 'reference-review', expectedRevision: 2,
    operationId: 'erase-workflow', ...context()})).state, 'deleted');
  assert.equal(f.runtime.getTask(queued.taskId).cancelRequested, true);
  assert.throws(() => f.app.readVersion('reference-review', 1), {code: 'NOT_FOUND'});
  assert.throws(() => f.app.assertDispatchBinding(oldBinding), {code: 'NOT_FOUND'});
  assert.equal(f.calls(), 3);
  f.learning.resumeErasureMaintenance('desktop-learning');
});

test('bad source verification fails learning; a self-reported succeeded task without tool records cannot activate', async t => {
  const f = await learningFixture(t);
  propose(f.app);
  f.setCorrupt(true);
  const result = await validate(f, 1, 'validate-corrupt');
  assert.equal(result.version.validation, 'failed');
  f.setAllowed(true);
  await assert.rejects(activate(f.app, 1, null, 'activate-failed'), {code: 'NOT_VALIDATED'});
  propose(f.app, 1, 'Another candidate');
  const fake = await f.app.startValidation({workflowId: 'reference-review', revision: 2,
    operationId: 'self-reported', ...context()});
  await f.runtime.runTask(fake.taskId, async () => ({resultSummary: 'Model says all passed'}),
    {deadline: context().deadline, sideEffect: 'read'});
  await assert.rejects(f.app.validate({workflowId: 'reference-review', revision: 2,
    taskId: fake.taskId, ...context()}), {code: 'NOT_VALIDATED'});
  assert.equal(f.app.readVersion('reference-review', 2).validation, 'candidate');
  assert.equal(f.calls(), 1);
});

test('invalidated workflow source blocks new validation submission and the original dispatch/resume binding before MCP', async t => {
  const f = await learningFixture(t);
  const candidate = propose(f.app);
  const queued = await f.app.startValidation({workflowId: 'reference-review', revision: 1,
    operationId: 'queued-before-source-revocation', ...context()});
  const binding = f.runtime.loadCheckpoint(queued.taskId, LEARNING_BINDING_CHECKPOINT);
  f.app.assertDispatchBinding(binding);
  f.learning.invalidateSource({namespace: 'desktop-learning', sourceRef: candidate.sourceRef,
    operationId: 'revoke-original-source', invalidatedAt: new Date().toISOString(), ...context()});
  assert.equal(f.app.readVersion('reference-review', 1).validation, 'candidate');
  await assert.rejects(f.app.startValidation({workflowId: 'reference-review', revision: 1,
    operationId: 'rejected-after-source-revocation', ...context()}), {code: 'NOT_FOUND'});
  assert.equal(f.runtime.listTasks({conversationId: 'learning:desktop-learning', limit: 10}).items.length, 1);
  assert.throws(() => f.app.assertDispatchBinding(binding), {code: 'NOT_FOUND'});
  assert.equal((await f.dispatch(queued.taskId)).state, 'failed');
  assert.equal(f.calls(), 0);
  assert.throws(() => f.app.assertDispatchBinding(binding), {code: 'NOT_FOUND'});
});

test('stale learning deletion has zero cancellation effects on old and current version tasks', async t => {
  const f = await learningFixture(t);
  propose(f.app);
  const old = await f.app.startValidation({workflowId: 'reference-review', revision: 1,
    operationId: 'old-validation-task', ...context()});
  propose(f.app, 1, 'Current version');
  const current = await f.app.startValidation({workflowId: 'reference-review', revision: 2,
    operationId: 'current-validation-task', ...context()});
  f.runtime.transitionTask(current.taskId, 'planning');
  f.runtime.transitionTask(current.taskId, 'running');
  await assert.rejects(f.app.erase({workflowId: 'reference-review', expectedRevision: 1,
    operationId: 'stale-erase', ...context()}), {code: 'REVISION_CONFLICT'});
  assert.equal(f.runtime.getTask(old.taskId).state, 'created');
  assert.equal(f.runtime.getTask(current.taskId).state, 'running');
  assert.equal(f.runtime.getTask(current.taskId).cancelRequested, undefined);
  assert.equal(f.learning.readErasureReceipt('desktop-learning', 'reference-review'), null);
  assert.equal(f.app.readVersion('reference-review', 2).summary, 'Current version');
});

test('learning stop cancels only the precisely bound Runtime task and preserves workflow versions', async t => {
  const f = await learningFixture(t);
  propose(f.app);
  const first = await f.app.startValidation({workflowId: 'reference-review', revision: 1,
    operationId: 'stop-one', ...context()});
  const independent = await f.app.startValidation({workflowId: 'reference-review', revision: 1,
    operationId: 'stop-independent', ...context()});
  assert.throws(() => f.app.stop({workflowId: 'another-workflow', revision: 1, taskId: first.taskId,
    ...context()}), {code: 'SCOPE_DENIED'});
  assert.equal(f.runtime.getTask(first.taskId).cancelRequested, undefined);
  let started;
  const entered = new Promise(resolve => {started = resolve;});
  const running = f.runtime.runTask(first.taskId, async worker => {
    started();
    await new Promise(resolve => worker.signal.addEventListener('abort', resolve, {once: true}));
    return {resultSummary: 'Cancelled synthetic worker'};
  }, {deadline: context().deadline, sideEffect: 'read'});
  await entered;
  assert.equal(f.runtime.getTask(first.taskId).state, 'running');
  const result = f.app.stop({workflowId: 'reference-review', revision: 1, taskId: first.taskId, ...context()});
  assert.equal(result.cancelRequested, true);
  assert.equal(f.runtime.getTask(independent.taskId).cancelRequested, undefined);
  assert.equal((await running).state, 'cancelled');
  assert.equal(f.calls(), 0);
  assert.equal(f.app.readVersion('reference-review', 1).validation, 'candidate');
  assert.equal(f.app.stop({workflowId: 'reference-review', revision: 1, taskId: first.taskId,
    ...context()}).state, 'cancelled');
});

test('a new head during deletion confirmation rejects atomically before cancelling current work', async t => {
  const f = await learningFixture(t);
  propose(f.app);
  const old = await f.app.startValidation({workflowId: 'reference-review', revision: 1,
    operationId: 'confirmation-old-task', ...context()});
  let current;
  f.setOnDeletion(async () => {
    propose(f.app, 1, 'New head during consent');
    current = await f.app.startValidation({workflowId: 'reference-review', revision: 2,
      operationId: 'confirmation-new-task', ...context()});
    f.runtime.transitionTask(current.taskId, 'planning');
    f.runtime.transitionTask(current.taskId, 'running');
  });
  await assert.rejects(f.app.erase({workflowId: 'reference-review', expectedRevision: 1,
    operationId: 'confirmation-stale-erase', ...context()}), {code: 'REVISION_CONFLICT'});
  assert.equal(f.runtime.getTask(old.taskId).state, 'created');
  assert.equal(f.runtime.getTask(current.taskId).state, 'running');
  assert.equal(f.runtime.getTask(current.taskId).cancelRequested, undefined);
  assert.equal(f.learning.readErasureReceipt('desktop-learning', 'reference-review'), null);
  assert.equal(f.app.readVersion('reference-review', 2).summary, 'New head during consent');
});

test('public bound deletion resumes from Runtime receipt after Memory commit failure and restart', async t => {
  const base = await directory(t);
  const memoryPath = join(base, 'memory.sqlite');
  const runtimePath = join(base, 'runtime.sqlite');
  let memory = openSqliteMemoryHost(memoryPath);
  let runtime = new TaskRuntime(runtimePath);
  const namespace = 'synthetic-public';
  const graphNamespace = 'synthetic-public-graph';
  memory.provision(namespace);
  for (const id of ['target', 'independent']) memory.append(namespace, {ref: {id, revision: 1}, summary: id,
    sourceRef: `synthetic:${id}`, observedAt: '2026-09-25T00:00:00.000Z',
    validFrom: '2026-09-25T00:00:00.000Z', validUntil: '2027-01-01T00:00:00.000Z',
    state: 'active', sensitivity: 'public', confirmation: 'user_confirmed'});
  const projection = () => createSqliteFactProjectionHost({memory, runtime, memoryNamespace: namespace,
    graphNamespace, consumerKey: 'synthetic-consumer'});
  const host = () => createBoundPublicFactErasureApplication({profile: 'huawei_ict_agentarts', memory, runtime,
    memoryNamespace: namespace, graphNamespace, projection: projection(), confirm: async () => true});
  t.after(async () => {memory.close(); runtime.close(); await rm(base, {recursive: true, force: true});});
  await projection().drain({limit: 10, maxBatches: 2, ...context()});
  const fault = new DatabaseSync(memoryPath);
  fault.exec("CREATE TRIGGER synthetic_commit_fault BEFORE DELETE ON memory_facts BEGIN SELECT RAISE(ABORT, 'synthetic interrupted Memory purge'); END;");
  await assert.rejects(host().erase({factId: 'target', expectedRevision: 1, operationId: 'erase-public', ...context()}));
  assert.equal(memory.listFactErasures(namespace, {limit: 10, ...context()})[0].phase, 'pending');
  const originalReceipt = runtime.bindFactProjectionStore(graphNamespace).readErasureReceipt(namespace, 'target');
  assert.ok(originalReceipt);
  fault.exec('DROP TRIGGER synthetic_commit_fault');
  fault.close();
  memory.close(); runtime.close();
  memory = openSqliteMemoryHost(memoryPath); runtime = new TaskRuntime(runtimePath);
  assert.equal((await host().reconcile(context())).state, 'reconciled');
  assert.deepEqual(runtime.bindFactProjectionStore(graphNamespace).readErasureReceipt(namespace, 'target'), originalReceipt);
  assert.equal(memory.listFactErasures(namespace, {limit: 10, ...context()})[0].phase, 'completed');
  assert.deepEqual(runtime.bindCoordinationStore(graphNamespace).read().history.map(node => node.summary), ['independent']);
  assert.equal((await host().reconcile(context())).state, 'reconciled');
});
