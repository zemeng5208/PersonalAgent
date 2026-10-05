import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {FakeModelProvider} from '@personal-agent/models';
import {GhCliProvider} from '@personal-agent/github';
import {createDevWorkflowsRuntime} from '../dist/dev-workflows-runtime.js';

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
