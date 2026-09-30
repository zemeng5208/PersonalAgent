// Opt-in integration: real Desktop workspace host / Runtime / Policy / SQLite /
// Windows patch helper. New fixture files only. Laya and cloud are explicit Fakes.
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@personal-agent/client';
import {LayaActionChoiceService} from '@personal-agent/cognition';
import {createAgentArtsRuntimeApplication, createProactiveCognitionHost} from '@personal-agent/runtime/application';
import {createWorkspaceConfigHost} from '../../../apps/desktop/electron/workspace-config-host.js';
import {createDesktopGoalCognitionHost} from '../../../apps/desktop/electron/goal-cognition-host.js';
import {cognitionReviewFeedback} from '../../../apps/desktop/src/app/proactive-controls.js';

if (process.platform !== 'win32') throw Error('Windows integration only');
const repository = fileURLToPath(new URL('../../../', import.meta.url));
await mkdir(path.join(repository, '.cache'), {recursive: true});
const directory = await mkdtemp(path.join(repository, '.cache', 'p8-approved-consumption-'));
const workspace = path.join(directory, '隔离工作区');
const userData = path.join(directory, 'isolated-user-data');
await mkdir(workspace);
const source = path.join(workspace, 'demo.mjs');
const before = '\ufeffexport const value = "P8_BEFORE";\r\n';
const after = before.replace('P8_BEFORE', 'P8_AFTER_中文');
await writeFile(source, before, {flag: 'wx'});
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const safeStorage = {isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(value).reverse(),
  decryptString: value => Buffer.from(value).reverse().toString()}; // Fake encryption, never DPAPI proof.
const hostOptions = {userData, safeStorage, selectDirectory: async () => workspace};
let workspaceHost = createWorkspaceConfigHost(hostOptions);
await workspaceHost.select();
workspaceHost.close();
workspaceHost = createWorkspaceConfigHost(hostOptions); // Controlled reload of this isolated host only.

let goalHost, facts, application, releaseFetch, cloudCalls = 0, layaCalls = 0, goalWrites = 0;
const receipts = [];
async function until(predicate) {
  const expires = Date.now() + 60_000;
  while (!predicate()) {
    if (Date.now() >= expires) throw Error('P8 integration deadline expired');
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}
try {
  application = createAgentArtsRuntimeApplication({path: path.join(directory, 'runtime.sqlite'),
    hostUserNamespace: 'p8-isolated-consumption', tools: workspaceHost.tools,
    ...(workspaceHost.patchReconciliation ? {workspacePatchReconciliation: workspaceHost.patchReconciliation} : {}),
    competitionToolAvailability: workspaceHost.competitionToolAvailability,
    competitionToolExports: workspaceHost.competitionToolExports,
    initialRequestMode: 'goal-with-tools-json', responseMode: 'tool-proposal-json',
    gatewayUrl: 'https://agentarts.example.test', runtimeName: 'explicit-fake-integration',
    authorizationProvider: {read: async () => 'Bearer synthetic-not-a-key'},
    beforeCompetitionSend: request => goalHost.assertCloudSend(request),
    fetchImpl: async (_url, input) => {
      cloudCalls++;
      assert.doesNotMatch(JSON.parse(input.body).query, /PRIVATE_SOURCE_SENTINEL|P8_BEFORE|P8_AFTER/);
      await new Promise(resolve => {releaseFetch = resolve;});
      return new Response(JSON.stringify({event: 'message', data: {
        text: JSON.stringify({kind: 'text', text: '显式夹具编排完成'}), index: 0}}),
        {headers: {'content-type': 'application/json'}});
    }});
  workspaceHost.bindApplication(application);
  workspaceHost.authorize({cloudExportAllowed: true, writeAllowed: true, commandAllowed: false});
  assert.equal(workspaceHost.snapshot().readAvailable, true);
  assert.equal(workspaceHost.snapshot().writeAvailable, true);
  const client = new Client(application, Date.now);
  await client.connect();
  async function execute(toolName, argumentsValue) {
    const submitted = application.submitHostToolTask({commandId: randomUUID(), toolName,
      toolVersion: '1.0.0', arguments: argumentsValue, deadline: new Date(Date.now() + 60_000).toISOString()});
    const taskId = submitted.task.taskId;
    const availability = workspaceHost.competitionToolAvailability.find(item => item.toolName === toolName);
    assert.equal(await availability.available({taskId, signal: new AbortController().signal}), true);
    await until(() => application.runtime.getTask(taskId).state === 'waiting_approval');
    const pending = application.readHostToolTask(taskId);
    assert.equal(pending.confirmed, undefined);
    assert.equal(pending.approval.state, 'pending');
    if (toolName === 'workspace.apply_text_patch') assert.deepEqual(await readFile(source), Buffer.from(before));
    await client.call('authorization.respond', {approvalId: pending.approval.approvalId,
      expectedRevision: pending.approval.revision, decision: 'allow_once'});
    await until(() => ['succeeded', 'failed', 'waiting_reconciliation', 'cancelled']
      .includes(application.runtime.getTask(taskId).state));
    await until(() => application.activeTaskCount === 0);
    const result = application.readHostToolTask(taskId);
    assert.equal(result.task.state, 'succeeded', result.task.error?.message);
    receipts.push({taskId, toolName, state: result.task.state,
      evidenceRefs: result.task.evidenceRefs,
      evidence: application.runtime.readEvidence(taskId).map(item => ({evidenceId: item.evidenceId,
        verification: item.verification})),
      execution: application.runtime.readToolExecutions(taskId).map(item => ({runId: item.evidenceId,
        state: item.state, executionStarted: item.executionStarted, argumentsDigest: item.inputDigest}))});
    return result;
  }
  const read = await execute('workspace.read_text', {path: 'demo.mjs'});
  assert.equal(read.confirmed.result.content, before);
  assert.equal(read.confirmed.result.sha256, sha(await readFile(source)));
  const patch = {path: read.confirmed.result.path, expectedSha256: read.confirmed.result.sha256,
    edits: [{oldText: 'P8_BEFORE', newText: 'P8_AFTER_中文'}]};
  const preview = await execute('workspace.preview_text_patch', patch);
  assert.equal(preview.confirmed.result.previewText, after);
  assert.equal(preview.confirmed.result.beforeSha256, patch.expectedSha256);
  assert.deepEqual(await readFile(source), Buffer.from(before));
  const applied = await execute('workspace.apply_text_patch', patch);
  assert.equal(applied.confirmed.result.applied, true);
  assert.equal(applied.confirmed.result.beforeSha256, patch.expectedSha256);
  const reread = await execute('workspace.read_text', {path: patch.path});
  assert.deepEqual(await readFile(source), Buffer.from(after));
  assert.equal(reread.confirmed.result.sha256, sha(Buffer.from(after)));
  assert.equal(reread.confirmed.result.sha256, applied.confirmed.result.afterSha256);
  assert.ok(applied.confirmed.evidenceRefs.length > 0);

  const namespace = 'p8-isolated-goals';
  const store = application.runtime.provisionCoordinationStore(namespace);
  const node = (id, kind, dependencies, summary) => ({id, kind, dependencies, summary,
    sensitivity: 'private', sourceRef: 'synthetic/source', state: 'active', reason: 'isolated fixture',
    validFrom: '2026-01-01T00:00:00.000Z', validUntil: '2099-01-01T00:00:00.000Z'});
  const ref = (id, revision = 1) => ({id, revision});
  store.append(0, node('source', 'fact', [], 'PRIVATE_SOURCE_SENTINEL'));
  store.append(1, node('goal', 'goal', [ref('source')], '原目标'));
  store.append(2, node('decision', 'decision', [ref('goal')], '原决策'));
  store.append(3, node('plan', 'plan', [ref('decision')], '原计划'));
  store.append(4, node('goal', 'goal', [ref('source')], '变更后的目标'));
  const sourceTask = application.runtime.submitTask({goal: 'Synthetic prior Goal receipt',
    conversationId: 'isolated-fixture', idempotencyKey: 'p8-source-goal-receipt'});
  await application.runtime.runTask(sourceTask.taskId, async () => ({resultSummary: 'Fixture source receipt'}),
    {deadline: new Date(Date.now() + 60_000).toISOString(), sideEffect: 'read'});
  const sourceGoalPort = {listTasks: () => [{taskId: sourceTask.taskId, state: 'succeeded',
    result: {kind: 'applied', graphRevision: 5, previousGoal: ref('goal'), currentGoal: ref('goal', 2)}}],
    revise: () => {goalWrites++; throw Error('Goal writes are outside this fixture');}};
  facts = application.createCompetitionFactHost({memoryPath: path.join(directory, 'memory.sqlite'),
    memoryNamespace: 'p8-isolated-memory', graphNamespace: namespace, consumerKey: 'p8-integration'});
  const chooser = new LayaActionChoiceService({infer: async input => {
    layaCalls++;
    const choices = Object.keys(input.questions.action.criteria), selected = choices.at(-1);
    return {answers: {action: {choice: selected, probabilities: Object.fromEntries(choices.map(value =>
      [value, value === selected ? 0.98 : 0.02 / (choices.length - 1)])), answer_confidence: 0.98, confidence: 0.5}}};
  }});
  goalHost = createDesktopGoalCognitionHost({application, client, facts, namespace,
    goalHost: sourceGoalPort, chooser, ready: () => true, createHost: createProactiveCognitionHost});
  goalHost.configure({enabled: true, cloudAllowed: false});
  await goalHost.tick();
  const reviewTaskId = goalHost.snapshot().reviews[0]?.reviewTaskId;
  assert.ok(reviewTaskId);
  await assert.rejects(goalHost.applyDecision(reviewTaskId), /许可未开启/);
  goalHost.configure({enabled: true, cloudAllowed: true});
  const submitted = await goalHost.applyDecision(reviewTaskId);
  assert.equal(submitted.status, 'submitted');
  assert.equal(cognitionReviewFeedback(submitted).locked, true);
  await until(() => typeof releaseFetch === 'function');
  assert.equal((await goalHost.applyDecision(reviewTaskId)).taskId, submitted.taskId);
  assert.equal(cloudCalls, 1);
  releaseFetch();
  await until(() => application.runtime.getTask(submitted.taskId).state === 'succeeded');
  await until(() => application.activeTaskCount === 0);
  const final = goalHost.snapshot().reviews.find(item => item.reviewTaskId === reviewTaskId);
  assert.equal(final.state, 'succeeded');
  assert.equal(final.executionVerified, false);
  assert.equal(final.graphUpdateVerified, false);
  const rendered = cognitionReviewFeedback(final);
  assert.equal(rendered.locked, true);
  assert.match(rendered.message, /目标更新尚未核实/);
  assert.equal(store.read().revision, 5);
  assert.equal(goalWrites, 0);
  assert.equal(layaCalls, 1);
  const summary = {profile: 'huawei_ict_agentarts', verification: 'conditional', realLocalExecution: true,
    desktopUiVerified: false, cloudVerified: false, safeStorageVerified: false, formalF9Verified: false,
    bomAndCrlfPreserved: true, workspaceHostConsumed: true, policyApprovals: receipts.length,
    beforeSha256: read.confirmed.result.sha256, afterSha256: reread.confirmed.result.sha256,
    filesystemReadbackVerified: true, receipts,
    goal: {reviewTaskId, taskId: submitted.taskId, state: final.state,
      executionVerified: false, graphUpdateVerified: false, graphRevision: store.read().revision,
      goalWrites, layaCalls, fakeCloudCalls: cloudCalls, rendered}};
  await writeFile(path.join(directory, 'receipt.json'), JSON.stringify(summary, null, 2), {flag: 'wx'});
  console.log(JSON.stringify({passed: true, receiptDirectory: path.relative(repository, directory),
    verification: summary.verification, workspaceEvidence: receipts.map(item => item.evidence), goal: summary.goal}));
} finally {
  releaseFetch?.();
  goalHost?.close();
  facts?.close();
  workspaceHost.close();
  if (application) {await until(() => application.activeTaskCount === 0); application.close();}
}
