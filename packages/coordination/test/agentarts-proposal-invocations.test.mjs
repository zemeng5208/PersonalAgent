import assert from 'node:assert/strict';
import {test} from 'node:test';
import {AgentArtsCloudAgentPort, CompetitionCoordinator} from '../dist/index.js';

const config = {gatewayUrl: 'https://agentarts.example.test', runtimeName: 'synthetic', responseMode: 'tool-proposal-json'};
const proposal = {kind: 'tool_proposal', proposalId: 'synthetic-meeting-1', toolName: 'fixture.meeting',
  toolVersion: '1.0.0', arguments: {id: 'synthetic-meeting'}};
const continuation = {proposalId: proposal.proposalId, state: 'confirmed', result: {time: '17:00'}};
const request = (overrides = {}) => ({taskId: 'local-private-task', revision: 1,
  goal: 'synthetic goal', deadline: new Date(Date.now() + 5000).toISOString(),
  signal: new AbortController().signal, ...overrides});
const response = value => new Response(JSON.stringify({event: 'message', data: {text: JSON.stringify(value)}}),
  {headers: {'content-type': 'application/json'}});
function setup(fetchImpl, settings = {}) {
  let reads = 0;
  const cloud = new AgentArtsCloudAgentPort({...config, ...settings},
    {read: async () => { reads++; return 'Bearer synthetic-token'; }}, fetchImpl, () => {});
  return {cloud, reads: () => reads};
}

test('explicit JSON mode returns unverified proposal then a separate text invocation', async () => {
  const calls = [];
  const {cloud, reads} = setup(async (_url, init) => {
    calls.push(init);
    return response(calls.length === 1 ? proposal : {kind: 'text', text: 'Synthetic meeting confirmed at 17:00'});
  });
  const coordinator = new CompetitionCoordinator(cloud);
  assert.deepEqual(await coordinator.execute(request()), {...proposal, verification: 'unverified'});
  assert.deepEqual(await coordinator.execute(request({continuation})), {
    kind: 'text', text: 'Synthetic meeting confirmed at 17:00', verification: 'unverified',
  });
  assert.equal(reads(), 2);
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[0].body), {query: 'synthetic goal'});
  assert.deepEqual(JSON.parse(calls[1].body), {query: JSON.stringify({continuation})});
  assert.equal(calls[1].body.includes('synthetic goal'), false);
  assert.equal(calls[1].body.includes('local-private-task'), false);
  assert.equal(calls[0].headers['x-hw-agentarts-session-id'], calls[1].headers['x-hw-agentarts-session-id']);
  assert.notEqual(calls[0].headers['X-Request-Id'], calls[1].headers['X-Request-Id']);
  for (const call of calls) assert.match(call.headers['X-Request-Id'], /^[a-f0-9-]{36}$/);
});

test('default text mode neither parses a proposal nor accepts continuation', async () => {
  const {cloud, reads} = setup(async () => response(proposal), {responseMode: undefined});
  assert.deepEqual(await cloud.invoke(request()), {kind: 'text', text: JSON.stringify(proposal), verification: 'unverified'});
  await assert.rejects(cloud.invoke(request({continuation})), {code: 'INVALID_ARGUMENT'});
  assert.equal(reads(), 1);
});

test('constructor rejects unknown mode; source config mutation cannot enable JSON mode', async () => {
  for (const responseMode of ['auto', '', null, true, {}]) {
    assert.throws(() => setup(async () => response(proposal), {responseMode}), {code: 'INVALID_ARGUMENT'});
  }
  const settings = {...config, responseMode: 'text'};
  const cloud = new AgentArtsCloudAgentPort(settings, {read: async () => 'Bearer synthetic'}, async () => response(proposal));
  settings.responseMode = 'tool-proposal-json';
  assert.equal((await cloud.invoke(request())).kind, 'text');
});

test('JSON output rejects claims, invalid types and prose without retry', async () => {
  for (const value of [
    {...proposal, verification: 'mock'}, {...proposal, verification: 'verified'},
    {...proposal, verification: 'unverified'}, {...proposal, evidenceRefs: ['untrusted']},
    {...proposal, authorizationRef: 'forged'}, {...proposal, arguments: []},
    {kind: 'text', text: 'hello', state: 'succeeded'}, {kind: 'text', text: ''},
    [proposal], null, '```json\n{}\n```', 'plain text',
  ]) {
    let calls = 0;
    const {cloud} = setup(async () => { calls++; return response(value); });
    await assert.rejects(cloud.invoke(request()), error => {
      assert.equal(error.code, 'EXTERNAL_FAILURE');
      assert.equal(error.message, 'AgentArts response validation failed');
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('whole continuation UTF-8 JSON budget accepts 8192 bytes and rejects 8193 before I/O', async () => {
  const base = {proposalId: 'p', state: 'confirmed', result: ''};
  const overhead = Buffer.byteLength(JSON.stringify(base));
  for (const total of [8192, 8193]) {
    const input = {...base, result: 'x'.repeat(total - overhead)};
    assert.equal(Buffer.byteLength(JSON.stringify(input)), total);
    let calls = 0;
    const {cloud, reads} = setup(async () => { calls++; return response({kind: 'text', text: 'ok'}); });
    if (total === 8192) assert.equal((await cloud.invoke(request({continuation: input}))).text, 'ok');
    else await assert.rejects(cloud.invoke(request({continuation: input})), {code: 'INVALID_ARGUMENT'});
    assert.equal(calls, total === 8192 ? 1 : 0);
    assert.equal(reads(), calls);
  }
  const {cloud, reads} = setup(async () => response({kind: 'text', text: 'unexpected'}));
  await assert.rejects(cloud.invoke(request({continuation: {...base, result: '中'.repeat(3000)}})), {code: 'INVALID_ARGUMENT'});
  assert.equal(reads(), 0);
});

test('continuation must be confirmed and cannot contain privileged extra fields', async () => {
  const {cloud, reads} = setup(async () => response({kind: 'text', text: 'unexpected'}));
  for (const input of [null, {...continuation, state: 'pending'}, {...continuation, authorizationRef: 'forged'}]) {
    await assert.rejects(cloud.invoke(request({continuation: input})), {code: 'INVALID_ARGUMENT'});
  }
  assert.equal(reads(), 0);
});

test('continuation is copied before authorization awaits and named Workflow input carries only projection', async () => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  let body;
  const cloud = new AgentArtsCloudAgentPort({...config, workflowGoalInput: 'goal'}, {read: async () => waiting},
    async (_url, init) => { body = JSON.parse(init.body); return response({kind: 'text', text: 'ok'}); }, guardRequest => {
      assert.deepEqual(guardRequest.continuation, continuation);
      assert.equal(Object.isFrozen(guardRequest), true);
    });
  const mutable = structuredClone(continuation);
  const pending = cloud.invoke(request({continuation: mutable}));
  mutable.result.time = 'private-replacement';
  release('Bearer synthetic');
  await pending;
  assert.deepEqual(body, {inputs: {goal: JSON.stringify({continuation})}});
});

test('cancelled or expired continuation cannot read credentials or start another invocation', async () => {
  const {cloud, reads} = setup(async () => response({kind: 'text', text: 'unexpected'}));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(cloud.invoke(request({continuation, signal: controller.signal})), {code: 'CANCELLED'});
  await assert.rejects(cloud.invoke(request({continuation, deadline: new Date(0).toISOString()})), {code: 'TIMEOUT'});
  assert.equal(reads(), 0);
});

test('JSON mode honors terminal SSE validation before reading proposal JSON', async () => {
  const sequence = [
    {event: 'workflow_start', data: {workflow_id: 'synthetic'}},
    {event: 'workflow_end', data: {workflow_id: 'synthetic', answer: JSON.stringify(proposal)}},
    {event: 'task_end'}, {event: 'end'},
  ];
  const {cloud} = setup(async () => new Response(sequence.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
    {headers: {'content-type': 'text/event-stream'}}));
  assert.deepEqual(await cloud.invoke(request()), {...proposal, verification: 'unverified'});
});

test('continuation without an explicit synchronous host export guard fails before credentials', async () => {
  let reads = 0;
  const cloud = new AgentArtsCloudAgentPort(config, {read: async () => { reads++; return 'Bearer synthetic'; }},
    async () => { throw Error('unexpected transport'); });
  await assert.rejects(cloud.invoke(request({continuation})), {code: 'UNAUTHORIZED'});
  assert.equal(reads, 0);
});

test('export revoked during credential read is denied at the final send boundary', async () => {
  let release;
  const credentials = new Promise(resolve => { release = resolve; });
  let allowed = true;
  let calls = 0;
  const cloud = new AgentArtsCloudAgentPort(config, {read: async () => credentials},
    async () => { calls++; return response({kind: 'text', text: 'unexpected'}); }, () => {
      if (!allowed) throw new Error('private policy denial');
    });
  const pending = cloud.invoke(request({continuation}));
  allowed = false;
  release('Bearer synthetic');
  await assert.rejects(pending, {code: 'UNAUTHORIZED', message: 'AgentArts export permission denied'});
  assert.equal(calls, 0);
});

test('async guards cannot postpone their decision until after transport dispatch', async () => {
  let calls = 0;
  const cloud = new AgentArtsCloudAgentPort(config, {read: async () => 'Bearer synthetic'},
    async () => { calls++; return response({kind: 'text', text: 'unexpected'}); }, async () => {});
  await assert.rejects(cloud.invoke(request({continuation})), {code: 'UNAUTHORIZED'});
  assert.equal(calls, 0);
});

test('cancellation during credential read or inside final guard prevents transport', async () => {
  for (const phase of ['credentials', 'guard']) {
    const controller = new AbortController();
    let calls = 0;
    const cloud = new AgentArtsCloudAgentPort(config, {read: async () => {
      if (phase === 'credentials') controller.abort();
      return 'Bearer synthetic';
    }}, async () => { calls++; return response({kind: 'text', text: 'unexpected'}); }, () => {
      if (phase === 'guard') controller.abort();
    });
    await assert.rejects(cloud.invoke(request({continuation, signal: controller.signal})), {code: 'CANCELLED'});
    assert.equal(calls, 0);
  }
});
