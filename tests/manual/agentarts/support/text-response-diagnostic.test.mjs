import assert from 'node:assert/strict';
import {test} from 'node:test';
import {AgentArtsCloudAgentPort} from '../../../../packages/coordination/dist/index.js';
import {createTextDiagnosticFetch, inspectTextResponse} from './text-response-diagnostic.mjs';

const encode = text => new TextEncoder().encode(text);
const message = (text, index = 0) => ({event: 'message', data: {text, index}});
const events = [
  {event: 'workflow_start', data: {workflow_name: 'private-workflow-A'}},
  message('private-A'), {event: 'workflow_end', data: {answer: 'private-answer-A'}},
  {event: 'workflow_start', data: {workflow_name: 'private-workflow-B'}},
  message('private-B'), {event: 'workflow_end', data: {answer: 'private-answer-B'}},
  {event: 'task_end'}, {event: 'end'},
];

test('exact built parser replay distinguishes global/workflow conflicts without content', () => {
  const result = inspectTextResponse(encode(JSON.stringify(events)), 'application/json');
  assert.equal(result.parserOutcome, 'accepted');
  assert.equal(result.structure.globalIndexConflicts, 1);
  assert.equal(result.structure.workflowIndexConflicts, 0);
  assert.equal(result.resultCharacters, 'private-answer-B'.length);
  assert.match(result.parserSha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes('private'), false);

  const conflict = [...events.slice(0, 2), message('private-conflict'), ...events.slice(2)];
  const rejected = inspectTextResponse(encode(JSON.stringify(conflict)), 'application/json');
  assert.equal(rejected.parserOutcome, 'rejected');
  assert.equal(rejected.rejection, 'index_conflict');
  assert.equal(rejected.structure.workflowIndexConflicts, 1);
});

test('standard multiline SSE is replayed exactly and counters declare incomplete inspection', () => {
  const body = 'data: {"event":"message",\n' + 'data: "data":{"text":"private-output"}}\n\n';
  const result = inspectTextResponse(encode(body), 'text/event-stream');
  assert.equal(result.parserOutcome, 'accepted');
  assert.equal(result.structure.framing, 'not_fully_inspected');
  assert.equal(JSON.stringify(result).includes('private-output'), false);
});

test('diagnostic reports allowlisted parser reasons and bounded invalid encoding', () => {
  for (const [body, reason] of [
    [JSON.stringify([{event: 'error', data: {message: 'private-error'}}]), 'provider_failure'],
    [JSON.stringify([{event: 'workflow_start'}, {event: 'workflow_end', data: {answer: 'private-partial'}}]), 'no_final_text'],
    [JSON.stringify(message({private: 'value'})), 'message_type'],
  ]) {
    const result = inspectTextResponse(encode(body), 'application/json');
    assert.equal(result.rejection, reason);
    assert.equal(JSON.stringify(result).includes('private'), false);
  }
  assert.deepEqual(inspectTextResponse(new Uint8Array(1024 * 1024 + 1), 'application/json'), {outcome: 'inspection_limit'});
  assert.deepEqual(inspectTextResponse(new Uint8Array([255]), 'application/json'), {outcome: 'invalid_utf8'});
});

test('fetch observation retains production acceptance/rejection and never reissues network I/O', async () => {
  for (const [body, succeeds] of [[events, true], [[...events.slice(0, 2), message('different')], false]]) {
    let calls = 0;
    const diagnostic = createTextDiagnosticFetch(async () => {
      calls++;
      return new Response(JSON.stringify(body), {headers: {'content-type': 'application/json'}});
    });
    const cloud = new AgentArtsCloudAgentPort({gatewayUrl: 'https://agentarts.example.test', runtimeName: 'synthetic'},
      {read: async () => 'Bearer private-token'}, diagnostic.fetch);
    const run = cloud.invoke({taskId: 'private-id', revision: 1, goal: 'synthetic',
      deadline: new Date(Date.now() + 5000).toISOString(), signal: new AbortController().signal});
    if (succeeds) assert.equal((await run).text, 'private-answer-B');
    else await assert.rejects(run, {code: 'EXTERNAL_FAILURE'});
    const report = diagnostic.snapshot();
    assert.equal(calls, 1);
    assert.equal(report.networkCalls, 1);
    assert.equal(report.bodyOutcome, 'complete');
    assert.equal(report.diagnostic.parserOutcome, succeeds ? 'accepted' : 'rejected');
    assert.equal(JSON.stringify(report).includes('private'), false);
    report.status = 0;
    assert.equal(diagnostic.snapshot().status, 200);
  }
});

test('transport details cannot appear in diagnostic reports', async () => {
  const diagnostic = createTextDiagnosticFetch(async () => { throw new Error('private transport details'); });
  await assert.rejects(diagnostic.fetch('https://example.test', {}));
  assert.deepEqual(diagnostic.snapshot(), {networkCalls: 1, bodyOutcome: 'pending', transport: 'rejected'});
});
