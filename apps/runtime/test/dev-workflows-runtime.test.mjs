import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {FakeModelProvider} from '@personal-agent/models';
import {GhCliProvider} from '@personal-agent/github';
import {createDevWorkflowsRuntime} from '../dist/dev-workflows-runtime.js';
import {ProtocolError} from '@personal-agent/contracts';
import {createWorkspaceReadTool, createWorkspacePatchPreviewTool} from '@personal-agent/coding-tools';

const issue = {number: 7, title: 'Improve docs', body: 'Please improve docs', state: 'open', labels: [],
  url: 'https://github.com/example/project/issues/7', updatedAt: '2026-10-01T00:00:00.000Z'};
function readTool(count) {
  return {descriptor: {name: 'github.issue.get', version: '0.1.0-alpha.1',
    inputSchema: {type: 'object', properties: {repo: {type: 'string'}, number: {type: 'integer'}},
      required: ['repo', 'number'], additionalProperties: false},
    outputSchema: {type: 'object'}, requiredScopes: ['github:read'], sideEffect: 'read',
    requiresPresence: false, idempotencySupport: true, recoverySupport: true}, async execute() { count.calls++; return structuredClone(issue); }};
}
function model() {
  return new FakeModelProvider([{kind: 'final', text: JSON.stringify({kind: 'docs', confidence: 0.95,
    evidence: [{field: 'title', quote: 'Improve docs'}]})}], {
    provider: 'fake', deployment: 'dev-workflows-test', model: 'fake', verification: 'mock',
    capabilities: {text: true, streaming: false, toolCalling: false, structuredOutput: false, vision: false},
  });
}
async function fixture(run, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dev-workflows-'));
  const count = {calls: 0};
  const host = createDevWorkflowsRuntime({path: path.join(directory, 'runtime.sqlite'), model: model(),
    tools: [readTool(count)], maxSteps: 16, maxTokens: 1024, ...options});
  try { await run(host, count); }
  finally { await host.close(); await rm(directory, {recursive: true, force: true}); }
}
const submission = () => ({request: {kind: 'issue_triage', input: {repo: 'example/project', number: 7}},
  conversationId: 'dev-tests', idempotencyKey: 'same-work', deadline: new Date(Date.now() + 60_000).toISOString()});

test('an unapproved GitHub read pauses the original task without execution', async () => {
  await fixture(async (host, count) => {
    const task = host.submit(submission());
    const paused = await host.start(task.taskId);
    assert.equal(paused.state, 'waiting_approval');
    assert.equal(count.calls, 0);
    assert.equal(host.runtime.readToolExecutions(task.taskId).length, 0);
  });
});

test('idempotent submissions retain request and deadline binding', async () => {
  await fixture(async host => {
    const input = submission();
    const first = host.submit(input);
    assert.equal(host.submit(input).taskId, first.taskId);
    assert.throws(() => host.submit({...input, request: {...input.request, input: {repo: 'example/project', number: 8}}}));
    assert.throws(() => host.submit({...input, deadline: new Date(Date.parse(input.deadline) + 1000).toISOString()}));
  });
});

test('approval resumes the original task and records a confirmed GitHub read', async () => {
  await fixture(async (host, count) => {
    const task = host.submit(submission());
    await host.start(task.taskId);
    const approval = host.runtime.listApprovals({taskId: task.taskId, state: 'pending'}).items[0];
    assert.ok(approval);
    host.runtime.respondApproval(approval.approvalId, 'allow_once', approval.revision);
    const completed = await host.resume(task.taskId);
    assert.equal(completed.taskId, task.taskId);
    assert.equal(completed.state, 'succeeded');
    assert.equal(host.readResult(task.taskId).state, 'classified');
    assert.equal(count.calls, 1);
    const records = host.runtime.readToolExecutions(task.taskId);
    assert.equal(records.length, 1);
    assert.equal(records[0].state, 'confirmed');
    assert.equal(records[0].policyDecision, 'allow');
  });
});

test('unknown tasks cannot be reopened without original confirmed Evidence', async () => {
  await fixture(async host => {
    const task = host.submit(submission());
    await host.start(task.taskId);
    assert.throws(() => host.resumeConfirmed(task.taskId, {runId: 'invented', toolName: 'github.issue.get',
      toolVersion: '0.1.0-alpha.1', arguments: {repo: 'example/project', number: 7}}), /confirmed receipt/);
  });
});

test('a larger CI budget does not prevent other workflows from starting', async () => {
  await fixture(async (host, count) => {
    const task = host.submit(submission());
    assert.equal((await host.start(task.taskId)).state, 'waiting_approval');
    const approval = host.runtime.listApprovals({taskId: task.taskId, state: 'pending'}).items[0];
    host.runtime.respondApproval(approval.approvalId, 'allow_once', approval.revision);
    assert.equal((await host.resume(task.taskId)).state, 'succeeded');
    assert.equal(host.readResult(task.taskId).state, 'classified');
    assert.equal(count.calls, 1);
  }, {maxTokens: 64_000});
});

test('failed workflow construction disposes registered GitHub providers and closes SQLite', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dev-init-rollback-'));
  const database = path.join(directory, 'runtime.sqlite');
  let disposed = 0;
  const github = {verification: 'mock', async execute() {throw Error('unused');}, dispose() {disposed++;}};
  try {
    assert.throws(() => createDevWorkflowsRuntime({path: database, model: model(), github,
      maxSteps: 16, maxTokens: 1024, issueTriage: {minConfidence: 2}}), /INVALID_TRIAGE_OPTIONS/);
    assert.equal(disposed, 1);
    // Windows rejects deleting a SQLite file if a leaked connection still owns it.
    await rm(database);
    const host = createDevWorkflowsRuntime({path: database, model: model(), tools: [readTool({calls: 0})],
      maxSteps: 16, maxTokens: 1024});
    await host.close();
  } finally {await rm(directory, {recursive: true, force: true});}
});

test('provider disposal failure does not hide the original workflow construction error', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dev-dispose-error-'));
  const database = path.join(directory, 'runtime.sqlite');
  let disposed = 0;
  const github = {verification: 'mock', async execute() {throw Error('unused');},
    dispose() {disposed++; throw Error('dispose interrupted');}};
  try {
    assert.throws(() => createDevWorkflowsRuntime({path: database, model: model(), github,
      maxSteps: 16, maxTokens: 1024, issueTriage: {minConfidence: 2}}), /INVALID_TRIAGE_OPTIONS/);
    assert.equal(disposed, 1);
    await rm(database);
  } finally {await rm(directory, {recursive: true, force: true});}
});

test('PR base drift during approval cannot publish a cached pre-review', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dev-review-base-'));
  const headSha = 'a'.repeat(40), baseSha = 'b'.repeat(40);
  let currentBase = baseSha, writes = 0;
  const diff = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n';
  // Exercise the production gh adapter with a synthetic transport; no network/account writes.
  const github = new GhCliProvider({repositories: ['example/project'], readToken: async () => 'synthetic-token',
    runner: {async run(command) {
      const method = command.args[command.args.indexOf('--method') + 1];
      if (method === 'POST') {
        writes++;
        return {exitCode: 0, stdout: JSON.stringify({id: 10,
          html_url: 'https://github.com/example/project/pull/7#discussion_r10'}), stderr: ''};
      }
      if (command.args.includes('Accept: application/vnd.github.diff')) return {exitCode: 0, stdout: diff, stderr: ''};
      return {exitCode: 0, stdout: JSON.stringify({number: 7, title: 'Change', body: '', state: 'open', draft: false,
        base: {ref: 'main', sha: currentBase}, head: {ref: 'feature', sha: headSha},
        html_url: 'https://github.com/example/project/pull/7'}), stderr: ''};
    }}});
  const model = new FakeModelProvider([{kind: 'final', text: JSON.stringify({findings: [
    {kind: 'question', ruleId: 'rule', path: 'src/a.ts', line: 1, side: 'RIGHT', body: 'Explain this change'},
  ]})}]);
  const host = createDevWorkflowsRuntime({path: path.join(directory, 'runtime.sqlite'), model, github,
    isUserPresent: () => true, maxSteps: 20, maxTokens: 1024});
  try {
    const task = host.submit({request: {kind: 'code_review', publish: true, input: {repo: 'example/project', number: 7,
      rules: [{id: 'rule', text: 'Explain meaningful changes'}]}}, conversationId: 'review-base',
      idempotencyKey: 'one-review', deadline: new Date(Date.now() + 60_000).toISOString()});
    let snapshot = await host.start(task.taskId), reachedWriteApproval = false;
    for (let i = 0; snapshot.state === 'waiting_approval' && i < 12; i++) {
      const approval = host.runtime.listApprovals({taskId: task.taskId, state: 'pending'}).items[0];
      assert.ok(approval);
      if (approval.action === 'github.pr.review.comment') {currentBase = 'c'.repeat(40); reachedWriteApproval = true;}
      host.runtime.respondApproval(approval.approvalId, 'allow_once', approval.revision);
      snapshot = await host.resume(task.taskId);
      if (reachedWriteApproval) break;
    }
    assert.equal(reachedWriteApproval, true);
    assert.equal(writes, 0);
    assert.equal(snapshot.state, 'waiting_reconciliation');
    const record = host.runtime.readToolExecutions(task.taskId).find(record => record.toolName === 'github.pr.review.comment');
    assert.equal(record.state, 'unknown');
    assert.equal(record.errorCode, 'RESULT_UNKNOWN');
  } finally {await host.close(); await rm(directory, {recursive: true, force: true});}
});

async function patchFixture(t, {confirmApply = false, previewFailure, invalidPreview = false, intentSaveFailure = false} = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dev-patch-recovery-'));
  await writeFile(path.join(directory, 'app.js'), 'const value = 1;\n');
  const {createHash} = await import('node:crypto');
  const before = createHash('sha256').update('const value = 1;\n').digest('hex');
  const preflightFailure = !!previewFailure || invalidPreview || intentSaveFailure;
  const calls = {apply: 0, polls: [], outcome: 'unknown', bindingId: 'd'.repeat(64), marker: !preflightFailure};
  const read = createWorkspaceReadTool({rootPath: directory});
  const trustedPreview = createWorkspacePatchPreviewTool({rootPath: directory});
  const preview = {...trustedPreview, async execute(input, context) {
    if (previewFailure) throw previewFailure;
    const result = await trustedPreview.execute(input, context);
    return invalidPreview ? {...result, afterSha256: 'invalid'} : result;
  }};
  const descriptor = (name, sideEffect = 'read') => ({name, version: '1.0.0', inputSchema: {type: 'object'},
    outputSchema: {type: 'object'}, requiredScopes: [sideEffect === 'read' ? 'workspace:read' : 'workspace:write'],
    sideEffect, requiresPresence: false, idempotencySupport: false, recoverySupport: false});
  const values = {
    'github.actions.run.list': {items: [{id: 1, conclusion: 'failure', headSha: 'a'.repeat(40), url: 'https://github.com/example/project/actions/runs/1'}]},
    'github.actions.job.list': {items: [{id: 2, conclusion: 'failure'}]},
    'github.actions.log.read': {text: 'synthetic failing build', truncated: false},
    'workspace.git.head': {headSha: 'a'.repeat(40), clean: true, workspaceClean: true},
    'workspace.run_allowed_command': {recipeId: 'check', exitCode: 0},
    'workspace.git.commit': {headSha: 'b'.repeat(40), parentSha: 'a'.repeat(40)},
    'workspace.git.push': {headSha: 'b'.repeat(40), pushed: true},
    'github.pr.create': {state: 'confirmed', externalId: '9', url: 'https://github.com/example/project/pull/9'},
    'github.pr.comment': {state: 'confirmed'},
  };
  const tools = [read, preview, ...Object.entries(values).map(([name, result]) => ({descriptor: descriptor(name),
    async execute() {return structuredClone(result);}})),
    {descriptor: {...descriptor('workspace.apply_text_patch', 'local_write'), requiredScopes: ['workspace:read','workspace:write']},
      async execute(input, context) {
        calls.apply++;
        if (confirmApply) return host.runtime.loadCheckpoint(context.taskId, `dev-patch-intent:${context.runId}`).expected;
        throw new ProtocolError('RESULT_UNKNOWN', 'Workspace patch helper identity is unavailable');
      }}];
  const provider = new FakeModelProvider([{kind: 'final', text: JSON.stringify({diagnosis: 'synthetic repair',
    patches: [{path: 'app.js', expectedSha256: before, edits: [{oldText: 'value = 1', newText: 'value = 2'}]}]})}]);
  let host;
  const create = () => createDevWorkflowsRuntime({path: path.join(directory, 'runtime.sqlite'), model: provider,
    tools, maxSteps: 32, maxTokens: 64_000,
    ciFix: {sourcePaths: ['app.js'], verifyRecipeId: 'check', headBranch: 'repair', baseBranch: 'main',
      gitTools: {head: 'workspace.git.head', commit: 'workspace.git.commit', push: 'workspace.git.push',
        pullRequest: 'github.pr.create', backlink: 'github.pr.comment'}},
    workspacePatchReconciliation: {get bindingId() {return calls.bindingId;}, async reconcile(input) {
      calls.polls.push(input);
      if (!calls.marker) return {path: input.relativePath, state: 'clear'};
      const intent = host.runtime.loadCheckpoint(input.expectedRunId.split(':ci-fix:')[0], `dev-patch-intent:${input.expectedRunId}`);
      const result = {path: input.relativePath, runId: input.expectedRunId, argumentsDigest: input.expectedArgumentsDigest,
        beforeSha256: intent.expected.beforeSha256, afterSha256: intent.expected.afterSha256};
      if (calls.outcome === 'in_progress') return {...result, state: 'in_progress', pid: 123};
      if (input.retainMarker !== true) calls.marker = false;
      const observed = {...result, state: 'reconciled', outcome: calls.outcome,
        currentSha256: calls.outcome === 'applied' ? result.afterSha256 : calls.outcome === 'not_applied' ? result.beforeSha256 : 'f'.repeat(64)};
      if (!calls.reuseReadback) return observed;
      calls.sharedReadback ??= {};
      Object.assign(calls.sharedReadback, observed);
      if (input.retainMarker !== true && calls.mutateAcknowledgement) {
        calls.sharedReadback.outcome = 'applied'; calls.sharedReadback.currentSha256 = result.afterSha256;
      }
      return calls.sharedReadback;
    }},
  });
  host = create();
  if (intentSaveFailure) {
    const saveOnce = host.runtime.saveCheckpointOnce.bind(host.runtime);
    host.runtime.saveCheckpointOnce = (taskId, key, value) => {
      if (key.startsWith('dev-patch-intent:')) throw new ProtocolError('EXTERNAL_FAILURE', 'Synthetic intent persistence failure');
      return saveOnce(taskId, key, value);
    };
  }
  t.after(async () => {await host.close(); await rm(directory, {recursive: true, force: true});});
  const task = host.submit({request: {kind: 'ci_fix', repository: 'example/project', runId: '1'},
    conversationId: 'patch-recovery', idempotencyKey: 'same-repair', deadline: new Date(Date.now() + 120_000).toISOString()});
  let snapshot = await host.start(task.taskId);
  for (let index = 0; snapshot.state === 'waiting_approval' && index < 10; index++) {
    const approval = host.runtime.listApprovals({taskId: task.taskId, state: 'pending'}).items[0];
    host.runtime.respondApproval(approval.approvalId, 'allow_once', approval.revision);
    snapshot = await host.resume(task.taskId);
  }
  if (!confirmApply) assert.equal(snapshot.state, 'waiting_reconciliation');
  assert.equal(calls.apply, preflightFailure ? 0 : 1);
  const record = host.runtime.readToolExecutions(task.taskId).find(item => item.toolName === 'workspace.apply_text_patch');
  assert.ok(record);
  return {get host() {return host;}, taskId: task.taskId, runId: record.evidenceId, calls,
    async restart() {await host.close(); host = create();}};
}

test('patch preview preflight failures retain the original unknown run with fixed local diagnostics', async t => {
  for (const [name, options, code] of [
    ['preview rejection', {previewFailure: new ProtocolError('REVISION_CONFLICT', 'Synthetic private /unshared/source.js token ghp_fixture_secret')}, 'REVISION_CONFLICT'],
    ['invalid preview', {invalidPreview: true}, 'REVISION_CONFLICT'],
    ['intent persistence', {intentSaveFailure: true}, 'EXTERNAL_FAILURE'],
  ]) await t.test(name, async t => {
    const f = await patchFixture(t, options);
    const record = f.host.runtime.readToolExecutions(f.taskId).find(item => item.evidenceId === f.runId);
    assert.equal(record.state, 'unknown'); assert.equal(record.errorCode, 'RESULT_UNKNOWN');
    assert.equal(record.policyDecision, 'allow'); assert.equal(record.executionStarted, true);
    assert.equal(record.reconciliationOutcome, undefined);
    assert.ok(f.runId.startsWith(`${f.taskId}:ci-fix:`));
    assert.equal(f.host.runtime.getTask(f.taskId).state, 'waiting_reconciliation');
    assert.equal(f.calls.apply, 0); assert.equal(f.calls.marker, false); assert.equal(f.calls.polls.length, 0);
    for (const key of [`dev-patch-intent:${f.runId}`, `dev-patch-readback:${f.runId}`, `tool-result-${f.runId}`]) {
      assert.equal(f.host.runtime.loadCheckpoint(f.taskId, key), undefined);
    }
    const diagnostic = f.host.runtime.loadCheckpoint(f.taskId, `dev-patch-diagnostic:${f.runId}`);
    assert.deepEqual(diagnostic, {stage: 'preview', code});
    await f.restart();
    assert.deepEqual(f.host.runtime.loadCheckpoint(f.taskId, `dev-patch-diagnostic:${f.runId}`), diagnostic);
    await assert.rejects(f.host.reconcileWorkspacePatchTask(f.taskId, f.runId), /original workflow/);
    assert.equal(f.calls.apply, 0); assert.equal(f.calls.polls.length, 0);
    assert.equal(f.host.runtime.getTask(f.taskId).state, 'waiting_reconciliation');
  });
});

test('workflow patch polls preserve unknown markers across restart without repeating apply', async t => {
  const f = await patchFixture(t);
  const diagnostic = f.host.runtime.loadCheckpoint(f.taskId, `dev-patch-diagnostic:${f.runId}`);
  assert.deepEqual(diagnostic, {stage: 'process_identity', code: 'RESULT_UNKNOWN'});
  for (const outcome of ['unknown','in_progress']) {
    f.calls.outcome = outcome;
    const observed = await f.host.reconcileWorkspacePatchTask(f.taskId, f.runId);
    assert.equal(observed.task.state, 'waiting_reconciliation'); assert.equal(observed.receipt, undefined);
  }
  assert.equal(f.calls.marker, true); await f.restart();
  f.calls.outcome = 'unknown'; await f.host.reconcileWorkspacePatchTask(f.taskId, f.runId);
  assert.equal(f.calls.apply, 1); assert.ok(f.calls.polls.every(input => input.retainMarker === true));
  assert.equal(f.host.runtime.readToolExecutions(f.taskId).find(item => item.evidenceId === f.runId).reconciliationOutcome, undefined);
});

test('each Runtime approval resumes the same precommit head read and reaches the original repair commit', async t => {
  const f = await patchFixture(t, {confirmApply: true});
  let snapshot = f.host.runtime.getTask(f.taskId);
  const pendingActions = [];
  for (let index = 0; snapshot.state === 'waiting_approval' && index < 32; index++) {
    const approval = f.host.runtime.listApprovals({taskId: f.taskId, state: 'pending'}).items[0];
    assert.ok(approval); pendingActions.push(approval.action);
    f.host.runtime.respondApproval(approval.approvalId, 'allow_once', approval.revision);
    snapshot = await f.host.resume(f.taskId);
  }
  assert.equal(snapshot.state, 'succeeded', JSON.stringify({pendingActions, result: f.host.readResult(f.taskId)}));
  const records = f.host.runtime.readToolExecutions(f.taskId);
  assert.equal(records.filter(record => record.toolName === 'workspace.git.commit').length, 1);
  assert.equal(records.filter(record => record.toolName === 'workspace.git.head').length, 2);
  assert.equal(f.calls.apply, 1); assert.equal(f.host.readResult(f.taskId).status, 'succeeded');
});

test('applied workflow recovery persists the original result and resumes after restart', async t => {
  const f = await patchFixture(t); f.calls.outcome = 'applied';
  const recovered = await f.host.reconcileWorkspacePatchTask(f.taskId, f.runId);
  assert.equal(recovered.task.state, 'waiting_reconciliation');
  assert.equal(recovered.result.outcome, 'applied');
  assert.ok(recovered.receipt);
  assert.equal(f.calls.marker, false);
  assert.equal(f.calls.apply, 1);
  const record = f.host.runtime.readToolExecutions(f.taskId).find(item => item.evidenceId === f.runId);
  assert.equal(record.state, 'confirmed');
  assert.equal(record.reconciliationOutcome, 'applied');
  assert.ok(f.host.runtime.loadCheckpoint(f.taskId, `tool-result-${f.runId}`));

  await f.restart();
  const replay = await f.host.reconcileWorkspacePatchTask(f.taskId, f.runId);
  assert.ok(replay.receipt);
  let snapshot = await f.host.resumeConfirmed(f.taskId, replay.receipt);
  for (let index = 0; snapshot.state === 'waiting_approval' && index < 32; index++) {
    const approval = f.host.runtime.listApprovals({taskId: f.taskId, state: 'pending'}).items[0];
    assert.ok(approval);
    f.host.runtime.respondApproval(approval.approvalId, 'allow_once', approval.revision);
    snapshot = await f.host.resume(f.taskId);
  }
  assert.equal(snapshot.state, 'succeeded');
  assert.equal(f.host.readResult(f.taskId).status, 'succeeded');
  assert.equal(f.calls.apply, 1);
  assert.equal(f.host.runtime.readToolExecutions(f.taskId).filter(item => item.toolName === 'workspace.git.commit').length, 1);
});

test('not-applied readback persists the original failed run before acknowledging its marker', async t => {
  const f = await patchFixture(t); f.calls.outcome = 'not_applied';
  const observed = await f.host.reconcileWorkspacePatchTask(f.taskId, f.runId);
  assert.equal(observed.task.state, 'failed'); assert.equal(observed.receipt, undefined);
  assert.equal(f.calls.marker, false); assert.equal(f.calls.apply, 1);
  assert.equal(f.host.runtime.readToolExecutions(f.taskId).find(item => item.evidenceId === f.runId).reconciliationOutcome, 'not_applied');
  await f.restart(); await f.host.reconcileWorkspacePatchTask(f.taskId, f.runId);
  assert.equal(f.calls.apply, 1);
});

test('a reused readback object cannot rewrite the persisted outcome or return an applied receipt', async t => {
  const f = await patchFixture(t);
  f.calls.outcome = 'not_applied'; f.calls.reuseReadback = true; f.calls.mutateAcknowledgement = true;
  await assert.rejects(f.host.reconcileWorkspacePatchTask(f.taskId, f.runId), /marker changed before acknowledgement/);
  const saved = f.host.runtime.loadCheckpoint(f.taskId, `dev-patch-readback:${f.runId}`);
  assert.equal(saved.outcome, 'not_applied'); assert.equal(saved.currentSha256, saved.beforeSha256);
  assert.equal(f.calls.sharedReadback.outcome, 'applied');
  const core = f.host.runtime.loadCheckpoint(f.taskId, `tool-reconciliation-${f.runId}`);
  assert.deepEqual(core.result, saved);
  assert.equal(f.host.runtime.getTask(f.taskId).state, 'failed');
  assert.equal(f.host.runtime.readToolExecutions(f.taskId).find(item => item.evidenceId === f.runId).reconciliationOutcome, 'not_applied');
  // A port acknowledgement can remove its own marker; the original bound facts
  // must survive that removal and a restart without adopting its later mutation.
  await f.restart();
  const observed = await f.host.reconcileWorkspacePatchTask(f.taskId, f.runId);
  assert.deepEqual(observed.result, saved); assert.equal(observed.receipt, undefined);
  assert.equal(f.calls.apply, 1);
});

test('missing persisted patch observation prevents marker acknowledgement', async t => {
  const f = await patchFixture(t); f.calls.outcome = 'not_applied';
  const save = f.host.runtime.saveCheckpoint.bind(f.host.runtime);
  f.host.runtime.saveCheckpoint = (taskId, key, value) => {
    if (key !== `dev-patch-readback:${f.runId}`) save(taskId, key, value);
  };
  await assert.rejects(f.host.reconcileWorkspacePatchTask(f.taskId, f.runId), /persistence could not be read back/);
  assert.equal(f.calls.marker, true); assert.equal(f.calls.polls.length, 1);
  assert.equal(f.host.runtime.loadCheckpoint(f.taskId, `dev-patch-readback:${f.runId}`), undefined);
  assert.equal(f.calls.apply, 1);
});

test('a mismatched persisted core receipt prevents marker acknowledgement', async t => {
  const f = await patchFixture(t); f.calls.outcome = 'not_applied';
  const reconcile = f.host.runtime.reconcileToolExecution.bind(f.host.runtime);
  f.host.runtime.reconcileToolExecution = (taskId, runId, outcome, result) => {
    const task = reconcile(taskId, runId, outcome, result);
    f.host.runtime.saveCheckpoint(taskId, `tool-reconciliation-${runId}`, {result: {...result, path: 'another.js'}});
    return task;
  };
  await assert.rejects(f.host.reconcileWorkspacePatchTask(f.taskId, f.runId), /persistence could not be read back/);
  assert.equal(f.calls.marker, true); assert.equal(f.calls.polls.length, 1);
  assert.equal(f.calls.apply, 1);
});

test('workflow recovery rejects changed workspace, original inputs and absent markers', async t => {
  const f = await patchFixture(t); f.calls.bindingId = 'e'.repeat(64);
  await assert.rejects(f.host.reconcileWorkspacePatchTask(f.taskId, f.runId), /workspace/);
  assert.equal(f.calls.polls.length, 0); f.calls.bindingId = 'd'.repeat(64);
  const original = f.host.runtime.loadCheckpoint(f.taskId, `dev-patch-intent:${f.runId}`);
  f.host.runtime.saveCheckpoint(f.taskId, `dev-patch-intent:${f.runId}`, {...original,
    arguments: {...original.arguments, path: 'another.js'}});
  await assert.rejects(f.host.reconcileWorkspacePatchTask(f.taskId, f.runId), /input/);
  assert.equal(f.calls.polls.length, 0);
  f.host.runtime.saveCheckpoint(f.taskId, `dev-patch-intent:${f.runId}`, original); f.calls.marker = false;
  await assert.rejects(f.host.reconcileWorkspacePatchTask(f.taskId, f.runId), /marker is absent/);
  assert.equal(f.host.runtime.getTask(f.taskId).state, 'waiting_reconciliation'); assert.equal(f.calls.apply, 1);
});
