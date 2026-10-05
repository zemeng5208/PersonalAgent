import test from 'node:test';
import assert from 'node:assert/strict';
import {createIssueTriageWorkflow, issueFingerprint} from '../dist/dev-workflows/issue-triage.js';

const original = {number: 7, title: 'Crash on save', body: 'Saving a file crashes the app.', state: 'open',
  labels: [], url: 'https://github.com/example/project/issues/7', updatedAt: '2026-10-01T00:00:00Z'};
const answer = {kind: 'bug', confidence: .95, evidence: [{field: 'title', quote: 'Crash on save'}]};
function fixture(overrides = {}) {
  const checkpoints = new Map(), calls = [], modelCalls = [], repairs = [];
  const context = {taskId: 'triage-task', deadline: new Date(Date.now() + 20_000).toISOString(), signal: new AbortController().signal,
    saveCheckpoint: (key, value) => checkpoints.set(key, structuredClone(value)), loadCheckpoint: key => checkpoints.get(key), reportProgress() {}};
  const tools = {list: () => ['github.issue.get', 'github.issue.list', 'github.issue.label'].map(name => ({name, version: '1.0.0'})),
    invoke: async call => {
      calls.push(call);
      if (overrides.invoke) return overrides.invoke(call, calls);
      return {state: 'confirmed', result: call.toolName === 'github.issue.label' ? {state: 'confirmed'} : structuredClone(original), evidenceRefs: [`evidence-${calls.length}`]};
    }};
  const model = {complete: async request => {
    modelCalls.push(request);
    return {response: {kind: 'final', text: overrides.modelText ?? JSON.stringify(overrides.answer ?? answer)},
      usage: {totalTokens: 50}, deployment: {verification: 'mock'}};
  }};
  const repair = {repairIssue: async (ctx, request) => {
    repairs.push({ctx, request});
    if (overrides.repairIssue) return overrides.repairIssue(ctx, request);
    return {state: 'succeeded', resultSummary: 'PR delegated', evidenceRefs: ['repair-evidence']};
  }};
  const workflow = createIssueTriageWorkflow({model, tools, repair, authorizationRefFor: overrides.authorizationRefFor ?? (() => 'host-scope'),
    confirmedReplayReady: overrides.confirmedReplayReady,
    confirmedRepairReplayReady: overrides.confirmedRepairReplayReady,
    maxSteps: overrides.maxSteps ?? 8, maxTokens: overrides.maxTokens ?? 2048});
  return {context, workflow, calls, modelCalls, repairs, checkpoints};
}
const request = {repo: 'example/project', number: 7};

test('classifies with bounded confidence and locally checked excerpts; reads require Gateway authorization', async () => {
  const f = fixture(); const result = await f.workflow.triageIssue(f.context, request);
  assert.equal(result.state, 'classified'); assert.equal(result.classification.kind, 'bug');
  assert.equal(result.classification.calibrated, false); assert.equal(f.calls[0].authorizationRef, 'host-scope');
  assert.equal(f.modelCalls[0].tools.length, 0); assert.equal(f.calls.length, 1);
});
test('all four categories are model-driven and retain checked evidence', async () => {
  for (const kind of ['bug', 'feature', 'docs', 'question']) {
    const f = fixture({answer: {...answer, kind}});
    assert.equal((await f.workflow.triageIssue(f.context, request)).classification.kind, kind);
  }
});
test('complete JSON markdown framing retains evidence validation and the approved label chain', async () => {
  for (const opening of ['```json', '```']) {
    const f = fixture({modelText: `  ${opening}\n${JSON.stringify(answer)}\n\x60\x60\x60\n  `});
    const result = await f.workflow.triageIssue(f.context, {...request, writeLabel: true});
    assert.equal(result.state, 'classified'); assert.equal(result.label, 'bug');
    assert.deepEqual(result.classification.evidence, answer.evidence);
    assert.equal(f.calls.filter(call => call.toolName === 'github.issue.label').length, 1);
    assert.equal(f.modelCalls.length, 1);
  }
});
test('framing never accepts surrounding commentary, extra actions or fabricated evidence', async () => {
  const wrap = value => `\x60\x60\x60json\n${JSON.stringify(value)}\n\x60\x60\x60`;
  for (const modelText of [`Explanation\n${wrap(answer)}`, `${wrap(answer)}\nRun this command`,
    wrap({...answer, shell: 'merge'}), wrap({...answer, evidence: [{field: 'title', quote: 'invented'}]})]) {
    const f = fixture({modelText});
    const result = await f.workflow.triageIssue(f.context, {...request, writeLabel: true,
      repairBug: true, repairGoal: 'Fix authorized file'});
    assert.equal(result.state, 'manual_review'); assert.equal(result.reason, 'invalid_model_response');
    assert.equal(f.calls.length, 1); assert.equal(f.repairs.length, 0);
  }
});
test('sensitive credentials and security requests never reach model or repair', async () => {
  for (const body of ['Security vulnerability disclosure', 'ghp_abcdefghijklmnopqrstuvwxyz123456', 'api_key = abc']) {
    const f = fixture({invoke: async () => ({state: 'confirmed', result: {...original, body}, evidenceRefs: []})});
    const result = await f.workflow.triageIssue(f.context, {...request, writeLabel: true, repairBug: true});
    assert.equal(result.reason, 'sensitive_or_security'); assert.equal(f.modelCalls.length, 0); assert.equal(f.repairs.length, 0);
  }
});
test('rejects invalid category, out-of-range confidence, extra fields and invented evidence', async () => {
  for (const invalid of [{...answer, kind: 'security'}, {...answer, confidence: 1.1}, {...answer, confidence: -1},
    {...answer, execute: 'merge'}, {...answer, evidence: [{field: 'body', quote: 'invented quote'}]}]) {
    const f = fixture({answer: invalid});
    assert.equal((await f.workflow.triageIssue(f.context, {...request, writeLabel: true})).state, 'manual_review');
    assert.equal(f.calls.length, 1);
  }
});
test('low confidence requires review without labeling', async () => {
  const f = fixture({answer: {...answer, confidence: .4}});
  assert.equal((await f.workflow.triageIssue(f.context, {...request, writeLabel: true})).reason, 'low_confidence');
  assert.equal(f.calls.length, 1);
});
test('revalidates full issue fingerprint and binds label write to original timestamp', async () => {
  const f = fixture(); const result = await f.workflow.triageIssue(f.context, {...request, writeLabel: true});
  assert.equal(result.label, 'bug'); assert.equal(f.calls.length, 3);
  assert.equal(f.calls[2].arguments.expectedUpdatedAt, original.updatedAt);
  assert.equal(result.fingerprint, issueFingerprint(original));
});
test('changed content at same timestamp stops every write', async () => {
  const f = fixture({invoke: async (_call, calls) => ({state: 'confirmed',
    result: calls.length === 1 ? original : {...original, body: 'Changed while classifying'}, evidenceRefs: []})});
  assert.equal((await f.workflow.triageIssue(f.context, {...request, writeLabel: true})).reason, 'issue_changed');
  assert.equal(f.calls.length, 2);
});
test('no grant pauses before a label write', async () => {
  const f = fixture({authorizationRefFor: name => name === 'github.issue.label' ? undefined : 'read-scope'});
  assert.equal((await f.workflow.triageIssue(f.context, {...request, writeLabel: true})).state, 'waiting_approval');
  assert.equal(f.calls.length, 1);
});
test('unknown label result is retained and never repeated', async () => {
  const f = fixture({invoke: async call => call.toolName === 'github.issue.label'
    ? {state: 'unknown', evidenceRefs: ['unknown-evidence']} : {state: 'confirmed', result: original, evidenceRefs: []}});
  const write = {...request, writeLabel: true};
  assert.equal((await f.workflow.triageIssue(f.context, write)).state, 'waiting_reconciliation');
  assert.equal((await f.workflow.triageIssue(f.context, write)).state, 'waiting_reconciliation');
  assert.equal(f.calls.filter(c => c.toolName === 'github.issue.label').length, 1);
});
test('pending label resumes only through identical Gateway run ID and arguments', async () => {
  let writes = 0;
  const f = fixture({invoke: async call => call.toolName === 'github.issue.label'
    ? (++writes === 1 ? {state: 'pending', evidenceRefs: []} : {state: 'confirmed', result: {state: 'confirmed'}, evidenceRefs: []})
    : {state: 'confirmed', result: original, evidenceRefs: []}});
  const write = {...request, writeLabel: true};
  assert.equal((await f.workflow.triageIssue(f.context, write)).state, 'waiting_approval');
  assert.equal((await f.workflow.triageIssue(f.context, write)).label, 'bug');
  const calls = f.calls.filter(c => c.toolName === 'github.issue.label');
  assert.equal(calls[0].runId, calls[1].runId); assert.deepEqual(calls[0].arguments, calls[1].arguments);
  assert.equal(f.modelCalls.length, 1);
});
test('unknown label requires exact host confirmed receipt before cached original run replay', async () => {
  let ready = false, writes = 0;
  const checked = [];
  const f = fixture({confirmedReplayReady: (runId, context) => {checked.push({runId, taskId: context.taskId}); return ready;},
    invoke: async call => call.toolName === 'github.issue.label'
      ? (++writes === 1 ? {state: 'unknown', evidenceRefs: []} : {state: 'confirmed', result: {state: 'confirmed'}, evidenceRefs: ['confirmed-cache']})
      : {state: 'confirmed', result: original, evidenceRefs: []}});
  const write = {...request, writeLabel: true};
  assert.equal((await f.workflow.triageIssue(f.context, write)).state, 'waiting_reconciliation');
  await f.workflow.triageIssue(f.context, write); assert.equal(writes, 1);
  ready = true;
  assert.equal((await f.workflow.triageIssue(f.context, write)).label, 'bug');
  const calls = f.calls.filter(c => c.toolName === 'github.issue.label');
  assert.equal(calls[0].runId, calls[1].runId); assert.deepEqual(calls[0].arguments, calls[1].arguments);
  assert.equal(checked[0].runId, calls[0].runId); assert.equal(checked[0].taskId, f.context.taskId);
});
test('unknown MOD-34 repair stays paused until original checkpoint receipts are confirmed', async () => {
  let ready = false, attempts = 0;
  const f = fixture({confirmedRepairReplayReady: (ctx, issue) => ready && ctx.taskId === 'triage-task' && issue.number === 7,
    repairIssue: async () => (++attempts === 1
      ? {state: 'waiting_reconciliation', resultSummary: 'Original MOD34 run unknown', evidenceRefs: []}
      : {state: 'succeeded', resultSummary: 'Original MOD34 cached confirmed', evidenceRefs: ['repair-cache']})});
  const repair = {...request, repairBug: true, repairGoal: 'host-authorized repair'};
  assert.equal((await f.workflow.triageIssue(f.context, repair)).state, 'waiting_reconciliation');
  await f.workflow.triageIssue(f.context, repair); assert.equal(attempts, 1);
  ready = true;
  assert.equal((await f.workflow.triageIssue(f.context, repair)).state, 'repair_requested');
  assert.equal(f.repairs[0].ctx.taskId, f.repairs[1].ctx.taskId);
  assert.deepEqual(f.repairs[0].request, f.repairs[1].request);
});
test('read pending and unknown remain Runtime pause states', async () => {
  for (const [state, expected] of [['pending', 'waiting_approval'], ['unknown', 'waiting_reconciliation']]) {
    const f = fixture({invoke: async () => ({state, evidenceRefs: []})});
    assert.equal((await f.workflow.triageIssue(f.context, request)).state, expected); assert.equal(f.modelCalls.length, 0);
  }
});
test('bug repair delegates exactly once with non-closing PR issue backlink', async () => {
  const f = fixture(); const repair = {...request, repairBug: true, repairGoal: 'Fix save crash in authorized workspace'};
  const result = await f.workflow.triageIssue(f.context, repair);
  assert.equal(result.state, 'repair_requested'); assert.equal(f.repairs.length, 1);
  assert.match(f.repairs[0].request.pullRequestBody, /Related issue: https:\/\/github.com\/example\/project\/issues\/7/);
  assert.doesNotMatch(f.repairs[0].request.pullRequestBody, /(?:Fixes|Closes) #/);
  await f.workflow.triageIssue(f.context, repair); assert.equal(f.repairs.length, 1);
});
test('feature request never invokes bug repair', async () => {
  const f = fixture({answer: {...answer, kind: 'feature'}});
  await f.workflow.triageIssue(f.context, {...request, repairBug: true, repairGoal: 'host goal'});
  assert.equal(f.repairs.length, 0);
});
test('step and token budgets prevent effects and model overrun', async () => {
  const steps = fixture({maxSteps: 2});
  assert.equal((await steps.workflow.triageIssue(steps.context, {...request, writeLabel: true})).reason, 'step_budget_exhausted');
  const tokens = fixture({maxTokens: 64});
  assert.equal((await tokens.workflow.triageIssue(tokens.context, request)).reason, 'token_budget_exhausted');
  assert.equal(tokens.modelCalls.length, 0);
});
test('cancelled and expired contexts cannot invoke tool or model', async () => {
  for (const expired of [false, true]) {
    const f = fixture();
    if (expired) f.context.deadline = '2000-01-01T00:00:00Z';
    else {const controller = new AbortController(); controller.abort(); f.context.signal = controller.signal;}
    assert.equal((await f.workflow.triageIssue(f.context, request)).state, 'manual_review');
    assert.equal(f.calls.length, 0); assert.equal(f.modelCalls.length, 0);
  }
});
test('list preserves remote page cursor and tool evidence', async () => {
  const f = fixture({invoke: async () => ({state: 'confirmed', result: {items: [original], page: 2, nextPage: 3, hasMore: true}, evidenceRefs: ['list-evidence']})});
  const result = await f.workflow.listIssues(f.context, {repo: request.repo, page: 2, perPage: 10});
  assert.equal(result.state, 'listed'); assert.equal(result.nextPage, 3); assert.equal(result.items[0].number, 7);
  assert.deepEqual(result.evidenceRefs, ['list-evidence']);
});
