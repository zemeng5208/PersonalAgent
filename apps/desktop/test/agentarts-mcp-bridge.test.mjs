import assert from 'node:assert/strict';
import test from 'node:test';
import {createAgentArtsMcpBridge} from '../electron/agentarts-mcp-bridge.js';

const TOKEN = 'local-agentarts-mcp-test-token-000000000000';
const tools = [{
  name: 'workspace.read_text',
  description: 'Read an explicitly granted workspace text file',
  inputSchema: {type: 'object', properties: {path: {type: 'string'}}, required: ['path']},
}];

async function request(url, message, {token = TOKEN, origin} = {}) {
  const headers = {
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  if (origin !== undefined) headers.Origin = origin;
  const response = await fetch(url, {method: 'POST', headers, body: JSON.stringify(message)});
  return {response, body: await response.json()};
}

async function initialize(url) {
  const initialized = await request(url, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2099-01-01',
      capabilities: {},
      clientInfo: {name: 'bridge-test', version: '1.0.0'},
    },
  });
  assert.equal(initialized.body.result.protocolVersion, '2025-03-26');
  const notification = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}),
  });
  assert.equal(notification.status, 202);
}

test('rejects missing auth and every Origin before invoking tools', async t => {
  let invokes = 0;
  const bridge = createAgentArtsMcpBridge({
    token: TOKEN,
    tools,
    deadline: Date.now() + 60_000,
    invoke: async () => { invokes += 1; return {content: []}; },
  });
  t.after(() => bridge.close());
  const {url} = await bridge.listen();
  const message = {jsonrpc: '2.0', id: 1, method: 'ping'};

  assert.equal((await request(url, message, {token: 'x'.repeat(32)})).response.status, 401);
  assert.equal((await request(url, message, {origin: 'https://example.com'})).response.status, 403);
  const get = await fetch(url, {headers: {Authorization: `Bearer ${TOKEN}`}});
  assert.equal(get.status, 405);
  assert.equal(invokes, 0);
});

test('negotiates initialization, lists static tools, and replays one call without double invoke', async t => {
  let invokes = 0;
  let release;
  const bridge = createAgentArtsMcpBridge({
    token: TOKEN,
    tools,
    deadline: Date.now() + 60_000,
    invoke: async input => {
      invokes += 1;
      assert.equal(input.name, 'workspace.read_text');
      assert.deepEqual(input.arguments, {path: 'README.md'});
      return new Promise(resolve => { release = resolve; });
    },
  });
  t.after(() => bridge.close());
  const {url} = await bridge.listen();
  await initialize(url);

  const listed = await request(url, {jsonrpc: '2.0', id: 2, method: 'tools/list', params: {}});
  assert.deepEqual(listed.body.result.tools, tools);

  const call = {
    jsonrpc: '2.0',
    id: 'call-1',
    method: 'tools/call',
    params: {name: 'workspace.read_text', arguments: {path: 'README.md'}},
  };
  const first = request(url, call);
  while (invokes === 0) await new Promise(resolve => setImmediate(resolve));
  const replay = request(url, call);
  release({content: [{type: 'text', text: 'confirmed content'}]});
  const [firstResult, replayResult] = await Promise.all([first, replay]);
  assert.deepEqual(firstResult.body.result, {content: [{type: 'text', text: 'confirmed content'}], isError: false});
  assert.deepEqual(replayResult.body, firstResult.body);
  assert.equal(invokes, 1);

  const conflict = await request(url, {
    ...call,
    params: {name: 'workspace.read_text', arguments: {path: 'other.md'}},
  });
  assert.deepEqual(conflict.body.error, {code: -32600, message: 'Request id conflict'});
  assert.equal(invokes, 1);
});

test('outer abort cancels an active invoke, and deadline closes the localhost listener', async () => {
  const outer = new AbortController();
  let invoked;
  const invokedPromise = new Promise(resolve => { invoked = resolve; });
  let aborted;
  const abortedPromise = new Promise(resolve => { aborted = resolve; });
  const bridge = createAgentArtsMcpBridge({
    token: TOKEN,
    tools,
    signal: outer.signal,
    deadline: Date.now() + 60_000,
    invoke: ({signal}) => new Promise((resolve, reject) => {
      invoked();
      signal.addEventListener('abort', () => {
        aborted();
        reject(signal.reason);
      }, {once: true});
    }),
  });
  const {url} = await bridge.listen();
  await initialize(url);
  const pending = request(url, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {name: 'workspace.read_text', arguments: {path: 'README.md'}},
  }).catch(error => error);
  await invokedPromise;
  outer.abort(Error('test abort'));
  await abortedPromise;
  await bridge.close();
  await pending;
  await assert.rejects(fetch(url), /fetch failed|ECONNREFUSED/iu);

  const deadlineBridge = createAgentArtsMcpBridge({
    token: TOKEN,
    tools,
    deadline: Date.now() + 30,
    invoke: async () => ({content: []}),
  });
  const deadlineUrl = (await deadlineBridge.listen()).url;
  let refused = false;
  for (let attempt = 0; attempt < 50 && !refused; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
    try { await fetch(deadlineUrl); } catch { refused = true; }
  }
  assert.equal(refused, true);
  await deadlineBridge.close();
});
