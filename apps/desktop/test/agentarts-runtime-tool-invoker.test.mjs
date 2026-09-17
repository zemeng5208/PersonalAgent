import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TaskRuntime} from '@personal-agent/runtime';
import {Client} from '@personal-agent/client';
import {ToolGateway, toolArgumentsDigest} from '@personal-agent/tool-gateway';
import {createWorkspaceReadTool} from '@personal-agent/coding-tools';
import {createAgentArtsRuntimeToolInvoker} from '../electron/agentarts-runtime-tool-invoker.js';
import {createAgentArtsMcpBridge} from '../electron/agentarts-mcp-bridge.js';

test('trusted MCP binding executes a synthetic read through approval, Runtime and Policy once', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pa-mcp-synthetic-'));
  const file = join(root, 'synthetic.txt');
  await writeFile(file, 'synthetic-only:T1=17:00', 'utf8');
  const source = createWorkspaceReadTool({rootPath: root});
  let executions = 0;
  const runtime = new TaskRuntime(':memory:', {createToolGateway: policy => {
    const gateway = new ToolGateway({policy});
    gateway.register({...source, execute: async (...args) => {executions++; return source.execute(...args);}});
    return gateway;
  }});
  t.after(() => runtime.close());
  const client = new Client(runtime);
  await client.connect();
  const task = runtime.submitTask({goal: 'Synthetic MCP read', conversationId: 'mcp-test', idempotencyKey: 'mcp-one'});
  const deadline = new Date(Date.now() + 30000).toISOString();
  const args = {path: 'synthetic.txt'};
  await runtime.runTask(task.taskId, async () => {
    runtime.requestToolApproval('synthetic-grant', task.taskId, source.descriptor, deadline, toolArgumentsDigest(args));
    return {resultSummary: 'Waiting for explicit local decision', evidenceRefs: []};
  }, {deadline, sideEffect: 'read'});
  assert.equal(runtime.getTask(task.taskId).state, 'waiting_approval');
  assert.equal(executions, 0);
  // Test harness plays the user; the bridge itself never grants approval.
  await client.call('authorization.respond', {approvalId: 'synthetic-grant', decision: 'allow_once', expectedRevision: 1});
  let exports = 0;
  const invoke = createAgentArtsRuntimeToolInvoker({client, taskId: task.taskId, deadline,
    tools: [{name: source.descriptor.name, version: source.descriptor.version, scopeRef: 'synthetic-grant'}],
    exportResult: ({result}) => {exports++; assert.equal(result.content, 'synthetic-only:T1=17:00'); return result.content;},
  });
  const outcome = await runtime.runTask(task.taskId, async ({signal}) => {
    const request = {name: source.descriptor.name, arguments: args, requestId: 'one', signal};
    assert.equal((await invoke({...request, taskId: 'forged'})).isError, true);
    assert.equal(executions, 0);
    const token = 'synthetic-loopback-test-token-only-123456789';
    const bridge = createAgentArtsMcpBridge({token, invoke, deadline, signal,
      tools: [{name: source.descriptor.name, description: 'Synthetic read only', inputSchema: source.descriptor.inputSchema}],
    });
    t.after(() => bridge.close());
    const {url} = await bridge.listen();
    const rpc = async message => {
      const response = await fetch(url, {method: 'POST', headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      }, body: JSON.stringify(message)});
      assert.ok(response.ok);
      return response.status === 202 ? undefined : response.json();
    };
    assert.equal((await rpc({jsonrpc: '2.0', id: 'init', method: 'initialize', params: {
      protocolVersion: '2025-03-26', capabilities: {}, clientInfo: {name: 'synthetic-test', version: '1'},
    }})).result.protocolVersion, '2025-03-26');
    await rpc({jsonrpc: '2.0', method: 'notifications/initialized'});
    assert.equal((await rpc({jsonrpc: '2.0', id: 'list', method: 'tools/list'})).result.tools[0].name, source.descriptor.name);
    const message = {jsonrpc: '2.0', id: 'one', method: 'tools/call', params: {name: request.name, arguments: args}};
    const first = (await rpc(message)).result;
    assert.equal(first.isError, false);
    assert.equal(first.content[0].text, 'synthetic-only:T1=17:00');
    assert.deepEqual((await rpc(message)).result, first);
    assert.equal((await invoke({...request, arguments: {path: 'different.txt'}})).isError, true);
    assert.equal(executions, 1);
    const records = runtime.readToolExecutions(task.taskId);
    assert.equal(records.length, 1);
    assert.equal(records[0].policyDecision, 'allow');
    assert.equal(records[0].state, 'confirmed');
    assert.equal(runtime.readEvidence(task.taskId).length, 1);
    await bridge.close();
    return {resultSummary: 'Synthetic read confirmed locally', evidenceRefs: [records[0].evidenceId]};
  }, {deadline, sideEffect: 'read', resume: true});
  assert.equal(outcome.state, 'succeeded');
  assert.equal(executions, 1);
  assert.equal(exports, 1);
  assert.equal(await readFile(file, 'utf8'), 'synthetic-only:T1=17:00');
});

test('pending, unknown and failed results never export content', async () => {
  let exports = 0;
  for (const state of ['pending', 'unknown', 'failed']) {
    const invoke = createAgentArtsRuntimeToolInvoker({
      client: {call: async () => ({state, result: 'private', evidenceRefs: ['e']})},
      taskId: 'host-task', deadline: new Date(Date.now() + 1000).toISOString(),
      tools: [{name: 'synthetic.read', version: '1', scopeRef: 'host-grant'}],
      exportResult: () => {exports++; return 'must-not-export';},
    });
    const result = await invoke({name: 'synthetic.read', arguments: {}, requestId: 1, signal: new AbortController().signal});
    assert.equal(result.isError, true);
    assert.doesNotMatch(JSON.stringify(result), /private|must-not-export/);
  }
  assert.equal(exports, 0);
});
