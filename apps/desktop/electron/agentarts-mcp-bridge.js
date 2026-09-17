import {timingSafeEqual} from 'node:crypto';
import {createServer} from 'node:http';

const HOST = '127.0.0.1';
const PATH = '/mcp';
const PROTOCOL_VERSION = '2025-03-26';
const MAX_BODY_BYTES = 64 * 1024;
const MAX_REQUEST_CACHE = 128;
const FORBIDDEN_AUTHORITY_FIELDS = new Set(['taskId', 'scopeRef', 'approval']);
const TOOL_FAILURE = Object.freeze({
  content: Object.freeze([{type: 'text', text: 'Tool execution failed'}]),
  isError: true,
});

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function jsonRpcError(id, code, message) {
  return {jsonrpc: '2.0', id: id ?? null, error: {code, message}};
}

function jsonRpcResult(id, result) {
  return {jsonrpc: '2.0', id, result};
}

function cloneJson(value, label) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw Error(`${label} must be JSON serializable`);
  }
  if (encoded === undefined) throw Error(`${label} must be JSON serializable`);
  return JSON.parse(encoded);
}

function normalizeTools(tools) {
  if (!Array.isArray(tools)) throw Error('AgentArts MCP tools must be an array');
  const names = new Set();
  return Object.freeze(tools.map(tool => {
    if (!isObject(tool)
      || typeof tool.name !== 'string' || !tool.name
      || typeof tool.description !== 'string'
      || !isObject(tool.inputSchema)) {
      throw Error('AgentArts MCP tool descriptor is invalid');
    }
    if (names.has(tool.name)) throw Error('AgentArts MCP tool names must be unique');
    names.add(tool.name);
    return Object.freeze(cloneJson({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }, 'AgentArts MCP tool descriptor'));
  }));
}

function parseDeadline(deadline) {
  const timestamp = deadline instanceof Date
    ? deadline.getTime()
    : typeof deadline === 'number'
      ? deadline
      : Date.parse(deadline);
  if (!Number.isFinite(timestamp) || timestamp <= Date.now()) {
    throw Error('AgentArts MCP bridge deadline must be a finite future time');
  }
  return timestamp;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function containsForbiddenAuthorityField(value) {
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== 'object') continue;
    for (const [key, child] of Object.entries(current)) {
      if (FORBIDDEN_AUTHORITY_FIELDS.has(key)) return true;
      pending.push(child);
    }
  }
  return false;
}

function normalizeToolResult(value) {
  if (!isObject(value)) throw Error('invalid tool result');
  const keys = Object.keys(value);
  if (keys.some(key => key !== 'content' && key !== 'isError')
    || !Array.isArray(value.content)
    || value.content.length > 8
    || (value.isError !== undefined && typeof value.isError !== 'boolean')) {
    throw Error('invalid tool result');
  }
  let contentBytes = 0;
  for (const item of value.content) {
    if (!isObject(item)
      || Object.keys(item).some(key => key !== 'type' && key !== 'text')
      || item.type !== 'text'
      || typeof item.text !== 'string') {
      throw Error('invalid tool result');
    }
    contentBytes += Buffer.byteLength(item.text, 'utf8');
  }
  if (contentBytes > 8192) throw Error('invalid tool result');
  return cloneJson({content: value.content, isError: value.isError === true}, 'AgentArts MCP tool result');
}

function authorized(header, expected) {
  const prefix = 'Bearer ';
  const supplied = typeof header === 'string' && header.startsWith(prefix)
    ? Buffer.from(header.slice(prefix.length), 'utf8')
    : Buffer.alloc(0);
  const candidate = supplied.length === expected.length ? supplied : Buffer.alloc(expected.length);
  return timingSafeEqual(expected, candidate) && supplied.length === expected.length;
}

function acceptsJsonAndSse(header) {
  if (typeof header !== 'string') return false;
  const mediaTypes = header.toLowerCase().split(',').map(value => value.trim().split(';', 1)[0]);
  return mediaTypes.includes('application/json') && mediaTypes.includes('text/event-stream');
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    request.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
      } else if (!tooLarge) {
        chunks.push(chunk);
      }
    });
    request.once('end', () => {
      if (tooLarge) reject(Object.assign(Error('request body too large'), {statusCode: 413}));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    request.once('aborted', () => reject(Error('request aborted')));
    request.once('error', reject);
  });
}

function sendJson(response, statusCode, body) {
  if (response.writableEnded || response.destroyed) return;
  const encoded = JSON.stringify(body);
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(encoded),
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(encoded);
}

function sendEmpty(response, statusCode, headers = {}) {
  if (response.writableEnded || response.destroyed) return;
  response.writeHead(statusCode, {'Cache-Control': 'no-store', ...headers});
  response.end();
}

/**
 * A deliberately limited MCP 2025-03-26 Streamable HTTP subset: one JSON-RPC
 * message per POST, JSON responses only, and no sessions, batches, or SSE.
 */
export function createAgentArtsMcpBridge({token, tools, invoke, deadline, signal} = {}) {
  if (typeof token !== 'string' || Buffer.byteLength(token, 'utf8') < 32) {
    throw Error('AgentArts MCP bridge token must contain at least 32 bytes');
  }
  if (typeof invoke !== 'function') throw Error('AgentArts MCP bridge invoke function is required');
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw Error('AgentArts MCP bridge signal is invalid');
  }

  const expectedToken = Buffer.from(token, 'utf8');
  const advertisedTools = normalizeTools(tools);
  const toolNames = new Set(advertisedTools.map(tool => tool.name));
  const deadlineAt = parseDeadline(deadline);
  const lifetime = new AbortController();
  const requestCache = new Map();
  let invokeTail = Promise.resolve();
  let initialized = false;
  let initializedNotification = false;
  let listening;
  let expectedHost;
  let closed = false;
  let closePromise;
  let deadlineTimer;

  const server = createServer((request, response) => {
    void handleRequest(request, response).catch(() => {
      sendJson(response, 500, {error: 'Internal server error'});
    });
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;

  function abortLifetime(reason) {
    if (!lifetime.signal.aborted) lifetime.abort(reason);
  }

  function scheduleDeadline() {
    if (closed) return;
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      void close(Error('AgentArts MCP bridge deadline exceeded'));
      return;
    }
    deadlineTimer = setTimeout(scheduleDeadline, Math.min(remaining, 2_147_483_647));
    deadlineTimer.unref?.();
  }

  const outerAbort = () => { void close(signal.reason ?? Error('AgentArts MCP bridge aborted')); };
  if (signal?.aborted) {
    closed = true;
    abortLifetime(signal.reason);
  }
  else signal?.addEventListener('abort', outerAbort, {once: true});
  scheduleDeadline();

  function trimRequestCache() {
    if (requestCache.size < MAX_REQUEST_CACHE) return true;
    for (const [key, entry] of requestCache) {
      if (entry.settled) {
        requestCache.delete(key);
        return true;
      }
    }
    return false;
  }

  function invokeTool(name, args, requestId) {
    const idKey = `${typeof requestId}:${stableJson(requestId)}`;
    const signature = `${name}:${stableJson(args)}`;
    const existing = requestCache.get(idKey);
    if (existing) {
      if (existing.signature !== signature) return {error: jsonRpcError(requestId, -32600, 'Request id conflict')};
      return {promise: existing.promise};
    }
    if (!trimRequestCache()) return {error: jsonRpcError(requestId, -32003, 'Request cache full')};

    const entry = {signature, settled: false};
    const run = async () => {
      if (lifetime.signal.aborted) throw lifetime.signal.reason ?? Error('bridge closed');
      return normalizeToolResult(await invoke({
        name,
        arguments: args,
        requestId,
        signal: lifetime.signal,
      }));
    };
    const pending = invokeTail.then(run, run);
    invokeTail = pending.catch(() => {});
    entry.promise = pending.catch(() => cloneJson(TOOL_FAILURE, 'AgentArts MCP tool failure'));
    entry.promise.finally(() => { entry.settled = true; });
    requestCache.set(idKey, entry);
    return {promise: entry.promise};
  }

  async function dispatch(message) {
    if (!isObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return {response: jsonRpcError(null, -32600, 'Invalid Request')};
    }
    const hasId = Object.hasOwn(message, 'id');
    const validId = typeof message.id === 'string' || (typeof message.id === 'number' && Number.isFinite(message.id));
    if (hasId && !validId) return {response: jsonRpcError(null, -32600, 'Invalid Request')};
    const id = hasId ? message.id : null;

    if (message.method === 'initialize') {
      if (!hasId || !isObject(message.params)
        || typeof message.params.protocolVersion !== 'string'
        || !isObject(message.params.capabilities)
        || !isObject(message.params.clientInfo)
        || typeof message.params.clientInfo.name !== 'string'
        || typeof message.params.clientInfo.version !== 'string') {
        return {response: jsonRpcError(id, -32602, 'Invalid initialize parameters')};
      }
      initialized = true;
      initializedNotification = false;
      return {response: jsonRpcResult(id, {
        protocolVersion: message.params.protocolVersion === PROTOCOL_VERSION
          ? message.params.protocolVersion
          : PROTOCOL_VERSION,
        capabilities: {tools: {listChanged: false}},
        serverInfo: {name: 'personal-agent-agentarts-mcp-bridge', version: '0.1.0'},
        instructions: 'Local authenticated bridge; single-message JSON responses only (no batches, sessions, GET streams, or SSE).',
      })};
    }

    if (message.method === 'notifications/initialized') {
      if (hasId || !initialized) return {response: jsonRpcError(id, -32600, 'Invalid initialization notification')};
      initializedNotification = true;
      return {notification: true};
    }

    if (message.method === 'ping') {
      return hasId ? {response: jsonRpcResult(id, {})} : {notification: true};
    }

    if (!initialized || !initializedNotification) {
      return {response: jsonRpcError(id, -32002, 'Server not initialized')};
    }
    if (!hasId) return {response: jsonRpcError(null, -32600, 'Request id required')};

    if (message.method === 'tools/list') {
      if (message.params !== undefined
        && (!isObject(message.params) || Object.keys(message.params).some(key => key !== 'cursor')
          || message.params.cursor !== undefined)) {
        return {response: jsonRpcError(id, -32602, 'Invalid tools/list parameters')};
      }
      return {response: jsonRpcResult(id, {tools: cloneJson(advertisedTools, 'AgentArts MCP tools')})};
    }

    if (message.method === 'tools/call') {
      if (!isObject(message.params)
        || Object.keys(message.params).some(key => key !== 'name' && key !== 'arguments')
        || typeof message.params.name !== 'string'
        || (message.params.arguments !== undefined && !isObject(message.params.arguments))) {
        return {response: jsonRpcError(id, -32602, 'Invalid tool call')};
      }
      const args = message.params.arguments ?? {};
      if (containsForbiddenAuthorityField(args)) {
        return {response: jsonRpcError(id, -32602, 'Authority fields are not accepted')};
      }
      if (!toolNames.has(message.params.name)) {
        return {response: jsonRpcError(id, -32602, 'Unknown tool')};
      }
      const invocation = invokeTool(message.params.name, args, message.id);
      if (invocation.error) return {response: invocation.error};
      return {response: jsonRpcResult(id, await invocation.promise)};
    }

    return {response: jsonRpcError(id, -32601, 'Method not found')};
  }

  async function handleRequest(request, response) {
    if (request.url !== PATH) {
      sendJson(response, 404, {error: 'Not found'});
      return;
    }
    if (request.headers.host !== expectedHost) {
      sendJson(response, 400, {error: 'Invalid host'});
      return;
    }
    if (request.headers.origin !== undefined) {
      sendJson(response, 403, {error: 'Origin is not accepted'});
      return;
    }
    if (!authorized(request.headers.authorization, expectedToken)) {
      sendJson(response, 401, {error: 'Unauthorized'});
      return;
    }
    if (request.method === 'GET') {
      sendEmpty(response, 405, {Allow: 'POST'});
      return;
    }
    if (request.method !== 'POST') {
      sendEmpty(response, 405, {Allow: 'POST'});
      return;
    }
    if (!acceptsJsonAndSse(request.headers.accept)) {
      sendJson(response, 406, {error: 'Not acceptable'});
      return;
    }
    const contentType = request.headers['content-type'];
    if (typeof contentType !== 'string' || contentType.toLowerCase().split(';', 1)[0].trim() !== 'application/json') {
      sendJson(response, 415, {error: 'Unsupported media type'});
      return;
    }
    const declaredLength = Number(request.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      sendJson(response, 413, {error: 'Request body too large'});
      request.resume();
      return;
    }

    let message;
    try {
      const body = await readBody(request);
      message = JSON.parse(body);
    } catch (error) {
      if (error?.statusCode === 413) sendJson(response, 413, {error: 'Request body too large'});
      else sendJson(response, 400, jsonRpcError(null, -32700, 'Parse error'));
      return;
    }
    if (Array.isArray(message)) {
      sendJson(response, 200, jsonRpcError(null, -32600, 'Batch requests are not supported'));
      return;
    }
    const outcome = await dispatch(message);
    if (outcome.notification) sendEmpty(response, 202);
    else sendJson(response, 200, outcome.response);
  }

  async function listen() {
    if (closed || lifetime.signal.aborted) throw Error('AgentArts MCP bridge is closed');
    if (listening) return listening;
    listening = new Promise((resolve, reject) => {
      const onError = error => {
        server.off('listening', onListening);
        listening = undefined;
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        const address = server.address();
        expectedHost = `${HOST}:${address.port}`;
        resolve(Object.freeze({url: `http://${expectedHost}${PATH}`}));
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(0, HOST);
    });
    return listening;
  }

  function close(reason = Error('AgentArts MCP bridge closed')) {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      closed = true;
      clearTimeout(deadlineTimer);
      signal?.removeEventListener('abort', outerAbort);
      abortLifetime(reason);
      if (!server.listening) return;
      await new Promise(resolve => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    })();
    return closePromise;
  }

  return Object.freeze({listen, close});
}
