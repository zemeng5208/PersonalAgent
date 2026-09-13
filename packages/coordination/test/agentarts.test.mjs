import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ProtocolError} from '@personal-agent/contracts';
import {AgentArtsCloudAgentPort} from '../dist/index.js';

const GATEWAY = 'https://agentarts.example.test';
const RUNTIME = 'agent-arts-demo';

function request(overrides = {}) {
  return {
    taskId: 'task-1',
    revision: 3,
    goal: '检查项目状态',
    deadline: new Date(Date.now() + 5_000).toISOString(),
    signal: new AbortController().signal,
    ...overrides,
  };
}

function message(text, index) {
  const data = {text};
  if (index !== undefined) data.index = index;
  return {event: 'message', data};
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {'content-type': 'application/json; charset=utf-8'},
  });
}

function sseResponse(value, status = 200) {
  return new Response(value, {
    status,
    headers: {'content-type': 'text/event-stream'},
  });
}

function provider(value = 'Bearer test-token') {
  let calls = 0;
  return {
    get calls() { return calls; },
    read: async signal => {
      assert.equal(signal.aborted, false);
      calls += 1;
      return value;
    },
  };
}

function port(fetchImpl, authorizationProvider = provider(), config = {}) {
  return new AgentArtsCloudAgentPort({
    gatewayUrl: GATEWAY,
    runtimeName: RUNTIME,
    ...config,
  }, authorizationProvider, fetchImpl);
}

async function rejectsCode(promise, code, forbidden = []) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof ProtocolError);
    assert.equal(error.code, code);
    for (const value of forbidden) assert.equal(error.message.includes(value), false);
    return true;
  });
}

test('published JSON sends the exact bounded request and reads authorization per call', async () => {
  const calls = [];
  const auth = provider();
  const cloud = port(async (url, init) => {
    calls.push({url, init});
    return jsonResponse(message('已完成', 0));
  }, auth);
  const input = request({taskId: 'task/with-private-id', revision: 7, deadline: new Date(Date.now() + 5_000).toISOString()});

  assert.deepEqual(await cloud.invoke(input), {kind: 'text', text: '已完成', verification: 'unverified'});
  assert.deepEqual(await cloud.invoke(input), {kind: 'text', text: '已完成', verification: 'unverified'});
  assert.equal(auth.calls, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, `${GATEWAY}/runtimes/${RUNTIME}/invocations`);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.redirect, 'error');
  assert.deepEqual(calls[0].init.headers, {
    'Content-Type': 'application/json',
    Accept: 'application/json,text/event-stream',
    Authorization: 'Bearer test-token',
    'x-hw-agentarts-session-id': calls[0].init.headers['x-hw-agentarts-session-id'],
    'X-Invoke-Mode': 'published',
    'X-Request-Id': `${calls[0].init.headers['x-hw-agentarts-session-id']}-7`,
  });
  assert.match(calls[0].init.headers['x-hw-agentarts-session-id'], /^pa-[0-9a-f]{32}$/);
  assert.equal(calls[0].init.headers['x-hw-agentarts-session-id'].includes('task'), false);
  assert.deepEqual(JSON.parse(calls[0].init.body), {query: input.goal});
  assert.equal(calls[0].init.body.includes(input.taskId), false);
  assert.equal(calls[0].init.body.includes(String(input.revision)), false);
  assert.equal(calls[0].init.body.includes(input.deadline), false);
});

test('JSON failure events reject instead of returning a partial message', async () => {
  const secret = 'provider failure details must stay private';
  const cloud = port(async () => jsonResponse([
    message('partial answer', 0),
    {event: 'status', type: 'failed', data: {message: secret}},
  ]));
  await rejectsCode(cloud.invoke(request()), 'EXTERNAL_FAILURE', [secret, 'partial answer']);
});

test('SSE error events reject instead of returning a partial message', async () => {
  const secret = 'sse failure details must stay private';
  const body = [
    `data: ${JSON.stringify(message('partial answer', 0))}`,
    '',
    `data: ${JSON.stringify({event: 'error', data: {message: secret}})}`,
    '',
  ].join('\n');
  const cloud = port(async () => sseResponse(body));
  await rejectsCode(cloud.invoke(request()), 'EXTERNAL_FAILURE', [secret, 'partial answer']);
});

test('redirect responses never become successful adapter results', async () => {
  let redirect;
  const cloud = port(async (_url, init) => {
    redirect = init.redirect;
    return new Response('redirect response body', {
      status: 307,
      headers: {
        location: 'https://outside.example.test/target',
        'content-type': 'application/json',
      },
    });
  });
  await rejectsCode(cloud.invoke(request()), 'EXTERNAL_FAILURE', [
    'redirect response body',
    'outside.example.test',
  ]);
  assert.equal(redirect, 'error');
});

test('SSE sorts indexed fragments, de-duplicates equal indexes, and stops at DONE', async () => {
  const body = [
    ': provider comment',
    '',
    `data: ${JSON.stringify(message('B', 1))}`,
    '',
    `data: ${JSON.stringify(message('A', 0))}`,
    '',
    `data: ${JSON.stringify(message('B', 1))}`,
    '',
    'data: [DONE]',
    '',
    `data: ${JSON.stringify(message('ignored', 2))}`,
  ].join('\n');
  const cloud = port(async () => sseResponse(body));
  assert.deepEqual(await cloud.invoke(request()), {kind: 'text', text: 'AB', verification: 'unverified'});
});

test('SSE data lines without indexes retain receive order', async () => {
  const body = [
    `data: ${JSON.stringify(message('first'))}`,
    `data: ${JSON.stringify(message(' second'))}`,
    'data: [DONE]',
  ].join('\n');
  const cloud = port(async () => sseResponse(body));
  assert.equal((await cloud.invoke(request())).text, 'first second');
});

test('message events with null text are metadata-only and do not invalidate later text', async () => {
  const cloud = port(async () => jsonResponse([
    {event: 'message', data: {text: null, index: 0, node_id: 'node-start'}},
    message('final', 1),
  ]));
  assert.deepEqual(await cloud.invoke(request()), {
    kind: 'text', text: 'final', verification: 'unverified',
  });
});

test('SSE multiline data uses the standard newline join before compatibility fallback', async () => {
  const serialized = JSON.stringify(message('multiline', 0));
  // Standard SSE joins multiple data lines with a newline, so split only at
  // a JSON whitespace boundary rather than in the middle of a string token.
  const splitAt = serialized.indexOf(',"data"') + 1;
  const body = [
    `data: ${serialized.slice(0, splitAt)}`,
    `data: ${serialized.slice(splitAt)}`,
    '',
  ].join('\n');
  const cloud = port(async () => sseResponse(body));
  assert.deepEqual(await cloud.invoke(request()), {kind: 'text', text: 'multiline', verification: 'unverified'});
});

test('debug mode is sent in the explicit invoke header', async () => {
  let seen;
  const cloud = port(async (_url, init) => {
    seen = init.headers;
    return jsonResponse(message('debug'));
  }, provider(), {invokeMode: 'debug'});
  await cloud.invoke(request());
  assert.equal(seen['X-Invoke-Mode'], 'debug');
});

test('constructor rejects non-origin gateway URLs, runtime names, and modes', () => {
  const validAuth = provider();
  const validFetch = async () => jsonResponse(message('ok'));
  for (const gatewayUrl of [
    'http://agentarts.example.test',
    'https://user:pass@agentarts.example.test',
    'https://agentarts.example.test/path',
    'https://agentarts.example.test/.',
    'https://agentarts.example.test//',
    'https://agentarts.example.test\\path',
    'https://agentarts.example.test/?query=1',
    'https://agentarts.example.test/#hash',
    ' https://agentarts.example.test',
  ]) {
    assert.throws(
      () => new AgentArtsCloudAgentPort({gatewayUrl, runtimeName: RUNTIME}, validAuth, validFetch),
      error => error instanceof ProtocolError && error.code === 'INVALID_ARGUMENT',
    );
  }
  for (const runtimeName of ['', 'bad/name', 'bad name', 'x'.repeat(65)]) {
    assert.throws(
      () => new AgentArtsCloudAgentPort({gatewayUrl: GATEWAY, runtimeName}, validAuth, validFetch),
      error => error instanceof ProtocolError && error.code === 'INVALID_ARGUMENT',
    );
  }
  assert.throws(
    () => new AgentArtsCloudAgentPort({gatewayUrl: GATEWAY, runtimeName: RUNTIME, invokeMode: 'release'}, validAuth, validFetch),
    error => error instanceof ProtocolError && error.code === 'INVALID_ARGUMENT',
  );
  assert.throws(
    () => new AgentArtsCloudAgentPort({gatewayUrl: GATEWAY, runtimeName: RUNTIME, invokeMode: null}, validAuth, validFetch),
    error => error instanceof ProtocolError && error.code === 'INVALID_ARGUMENT',
  );
});

test('already cancelled and expired requests stop before authorization or fetch', async () => {
  let authCalls = 0;
  let fetchCalls = 0;
  const auth = {read: async () => { authCalls += 1; return 'Bearer secret'; }};
  const cloud = port(async () => { fetchCalls += 1; return jsonResponse(message('never')); }, auth);
  const cancelled = new AbortController();
  cancelled.abort();
  await rejectsCode(cloud.invoke(request({signal: cancelled.signal})), 'CANCELLED');
  await rejectsCode(cloud.invoke(request({deadline: new Date(Date.now() - 1).toISOString()})), 'TIMEOUT');
  assert.equal(authCalls, 0);
  assert.equal(fetchCalls, 0);
});

test('abort during an in-flight fetch maps to CANCELLED and passes the combined signal', async () => {
  const controller = new AbortController();
  let combinedSignal;
  const cloud = port((_url, init) => {
    combinedSignal = init.signal;
    return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('transport aborted')), {once: true});
    });
  });
  const pending = cloud.invoke(request({signal: controller.signal}));
  await new Promise(resolve => setTimeout(resolve, 10));
  controller.abort();
  await rejectsCode(pending, 'CANCELLED');
  assert.ok(combinedSignal instanceof AbortSignal);
  assert.notEqual(combinedSignal, controller.signal);
  assert.equal(combinedSignal.aborted, true);
});

test('deadline wins when the transport rejects as its combined signal aborts', async () => {
  const secret = 'transport-deadline-secret';
  const cloud = port((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      queueMicrotask(() => reject(new Error(secret)));
    }, {once: true});
  }));
  await rejectsCode(cloud.invoke(request({
    deadline: new Date(Date.now() + 15).toISOString(),
  })), 'TIMEOUT', [secret]);
});

test('authorization and network failures are external failures without sensitive details', async () => {
  const token = 'Bearer very-secret-token';
  const goal = 'private goal must never be echoed';
  const authFailure = port(async () => { throw new Error(token); }, {read: async () => { throw new Error(token); }});
  await rejectsCode(authFailure.invoke(request({goal})), 'EXTERNAL_FAILURE', [token, goal]);

  const networkFailure = port(async () => { throw new Error(`${token} ${goal}`); });
  await rejectsCode(networkFailure.invoke(request({goal})), 'EXTERNAL_FAILURE', [token, goal]);
});

test('authorization rejects header control characters before fetch', async () => {
  let fetchCalls = 0;
  const cloud = port(async () => {
    fetchCalls += 1;
    return jsonResponse(message('never'));
  }, {read: async () => 'Bearer safe\r\nX-Leak: yes'});
  await rejectsCode(cloud.invoke(request()), 'EXTERNAL_FAILURE', ['X-Leak', 'yes']);
  assert.equal(fetchCalls, 0);
});

test('underlying ProtocolError values are not trusted or leaked', async () => {
  const secret = 'provider-error-secret';
  const authFailure = port(async () => jsonResponse(message('never')), {
    read: async () => { throw new ProtocolError('CANCELLED', secret); },
  });
  await rejectsCode(authFailure.invoke(request()), 'EXTERNAL_FAILURE', [secret]);

  const fetchFailure = port(async () => {
    throw new ProtocolError('INVALID_ARGUMENT', secret);
  });
  await rejectsCode(fetchFailure.invoke(request()), 'EXTERNAL_FAILURE', [secret]);
});

test('401 and 500 are external failures without response-body disclosure', async () => {
  const token = 'Bearer hidden-token';
  const goal = 'hidden goal';
  for (const status of [401, 500]) {
    const cloud = port(async () => new Response(`provider secret ${token} ${goal}`, {
      status,
      headers: {'content-type': 'application/json'},
    }));
    await rejectsCode(cloud.invoke(request({goal})), 'EXTERNAL_FAILURE', [token, goal, 'provider secret']);
  }
});

test('response byte and text limits are enforced at their exact boundaries', async () => {
  const atLimit = 'a'.repeat(16_000);
  const good = port(async () => jsonResponse(message(atLimit)));
  const result = await good.invoke(request());
  assert.equal(result.text, atLimit);

  const tooMuchText = port(async () => jsonResponse(message('a'.repeat(16_001))));
  await rejectsCode(tooMuchText.invoke(request()), 'EXTERNAL_FAILURE');

  const tooManyBytes = port(async () => new Response(new Uint8Array(1024 * 1024 + 1), {
    status: 200,
    headers: {'content-type': 'application/json'},
  }));
  await rejectsCode(tooManyBytes.invoke(request()), 'EXTERNAL_FAILURE');
});

test('streaming body byte limit rejects before requesting another chunk', async () => {
  let reads = 0;
  const body = {
    async *[Symbol.asyncIterator]() {
      reads += 1;
      yield new Uint8Array(1024 * 1024 + 1);
      reads += 1;
      yield new Uint8Array();
    },
  };
  const cloud = port(async () => ({
    status: 200,
    headers: {get: () => 'application/json'},
    body,
  }));
  await rejectsCode(cloud.invoke(request()), 'EXTERNAL_FAILURE');
  assert.equal(reads, 1);
});

test('invalid UTF-8 is rejected for raw body and text seams', async () => {
  const invalidBytes = port(async () => new Response(new Uint8Array([0xc3, 0x28]), {
    status: 200,
    headers: {'content-type': 'application/json'},
  }));
  await rejectsCode(invalidBytes.invoke(request()), 'EXTERNAL_FAILURE');

  const replacementText = port(async () => ({
    status: 200,
    headers: {get: () => 'application/json'},
    body: null,
    text: async () => '\uFFFD',
  }));
  await rejectsCode(replacementText.invoke(request()), 'EXTERNAL_FAILURE');
});

test('missing content type is rejected instead of guessed from the payload', async () => {
  const cloud = port(async () => new Response(JSON.stringify(message('ok')), {status: 200}));
  await rejectsCode(cloud.invoke(request()), 'EXTERNAL_FAILURE');
});

test('malformed JSON, conflicting indexes, and empty text are rejected', async () => {
  const malformed = port(async () => new Response('{not-json', {
    status: 200,
    headers: {'content-type': 'application/json'},
  }));
  await rejectsCode(malformed.invoke(request()), 'EXTERNAL_FAILURE');

  const conflicting = port(async () => jsonResponse([message('A', 0), message('B', 0)]));
  await rejectsCode(conflicting.invoke(request()), 'EXTERNAL_FAILURE');

  const empty = port(async () => jsonResponse({event: 'status', data: {text: 'ignored'}}));
  await rejectsCode(empty.invoke(request()), 'EXTERNAL_FAILURE');
});

test('all task ids use a stable hashed, header-safe session id', async () => {
  const calls = [];
  const cloud = port(async (_url, init) => {
    calls.push(init.headers);
    return jsonResponse(message('ok'));
  });
  const taskId = 'private/task?id=with spaces/'.repeat(4);
  await cloud.invoke(request({taskId}));
  await cloud.invoke(request({taskId}));
  const first = calls[0]['x-hw-agentarts-session-id'];
  assert.match(first, /^[A-Za-z0-9_-]{1,64}$/);
  assert.match(first, /^pa-[0-9a-f]{32}$/);
  assert.equal(first, calls[1]['x-hw-agentarts-session-id']);
  assert.equal(first.includes('private'), false);
  assert.equal(calls[0]['X-Request-Id'], `${first}-3`);
});

test('short task ids are also hashed instead of exported in a header', async () => {
  let headers;
  const cloud = port(async (_url, init) => {
    headers = init.headers;
    return jsonResponse(message('ok'));
  });
  await cloud.invoke(request({taskId: 'task-1'}));
  assert.match(headers['x-hw-agentarts-session-id'], /^pa-[0-9a-f]{32}$/);
  assert.equal(headers['x-hw-agentarts-session-id'].includes('task-1'), false);
});

test('request id remains bounded for the largest accepted revision', async () => {
  let headers;
  const cloud = port(async (_url, init) => {
    headers = init.headers;
    return jsonResponse(message('ok'));
  });
  await cloud.invoke(request({taskId: 'a'.repeat(48), revision: Number.MAX_SAFE_INTEGER}));
  assert.match(headers['x-hw-agentarts-session-id'], /^[A-Za-z0-9_-]{1,64}$/);
  assert.match(headers['X-Request-Id'], /^[A-Za-z0-9_-]{1,64}$/);
  assert.ok(headers['X-Request-Id'].length <= 64);
});

test('parent cancellation interrupts an authorization read', async () => {
  const controller = new AbortController();
  let authSignal;
  let fetchCalls = 0;
  const auth = {
    read: signal => {
      authSignal = signal;
      return new Promise(() => {});
    },
  };
  const cloud = port(async () => {
    fetchCalls += 1;
    return jsonResponse(message('never'));
  }, auth);
  const pending = cloud.invoke(request({signal: controller.signal}));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(authSignal instanceof AbortSignal);
  controller.abort();
  await rejectsCode(pending, 'CANCELLED');
  assert.equal(fetchCalls, 0);
});

test('an empty sanitized task id also uses the deterministic hash fallback', async () => {
  let headers;
  const cloud = port(async (_url, init) => {
    headers = init.headers;
    return jsonResponse(message('ok'));
  });
  await cloud.invoke(request({taskId: ''}));
  assert.match(headers['x-hw-agentarts-session-id'], /^pa-[0-9a-f]{32}$/);
});
