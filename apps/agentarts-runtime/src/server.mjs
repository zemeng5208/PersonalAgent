import {createServer} from 'node:http';
import {timingSafeEqual, randomUUID} from 'node:crypto';
import {ProtocolError} from '@personal-agent/contracts';

const MAX_BYTES = 1_200_000;
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const json = (response, status, data) => {
  response.writeHead(status, {'content-type':'application/json; charset=utf-8', 'cache-control':'no-store'});
  response.end(JSON.stringify(data));
};
function equalToken(actual, expected) {
  if (typeof actual !== 'string') return false;
  const a = Buffer.from(actual), b = Buffer.from(`Bearer ${expected}`);
  return a.length === b.length && timingSafeEqual(a,b);
}
function parsePayload(payload, workflowGoalInput) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ProtocolError('INVALID_ARGUMENT','Invalid invocation payload');
  const keys = Object.keys(payload);
  let query;
  if (keys.length === 1 && keys[0] === 'query') query = payload.query;
  else if (keys.length === 1 && keys[0] === 'inputs' && workflowGoalInput
    && payload.inputs && typeof payload.inputs === 'object' && !Array.isArray(payload.inputs)
    && Object.keys(payload.inputs).length === 1 && Object.hasOwn(payload.inputs,workflowGoalInput)) query = payload.inputs[workflowGoalInput];
  if (typeof query !== 'string' || !query.trim()) throw new ProtocolError('INVALID_ARGUMENT','Invalid invocation query');
  return query;
}
/** Both modes serve the same code. Only trusted startup selects mode/authentication. */
export function createAgentServer({orchestrator, mode, authToken, workflowGoalInput, timeoutMs = 60_000, maxConcurrency = 8}) {
  if (!['agentarts','standalone-validation'].includes(mode)
    || !orchestrator || typeof orchestrator.invoke !== 'function'
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647
    || !Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1
    || (authToken !== undefined && (typeof authToken !== 'string' || authToken.length < 32))) {
    throw new ProtocolError('INVALID_ARGUMENT','Invalid server configuration');
  }
  let active = 0;
  const server = createServer(async (request,response) => {
    if (request.method === 'GET' && request.url === '/ping') {
      return json(response,200,{status:active ? 'HealthyBusy':'Healthy', time_of_last_update:Math.floor(Date.now()/1000)});
    }
    if (request.method !== 'POST' || request.url !== '/invocations') return json(response,404,{error:{code:'NOT_FOUND'}});
    if (authToken !== undefined && !equalToken(request.headers.authorization,authToken)) return json(response,401,{error:{code:'UNAUTHORIZED'}});
    if (active >= maxConcurrency) return json(response,429,{error:{code:'RATE_LIMITED'}});
    active++;
    const controller = new AbortController();
    const abort = () => { if (!response.writableEnded) controller.abort(new ProtocolError('CANCELLED','Invocation disconnected')); };
    request.once('aborted',abort); response.once('close',abort);
    const receivedAt = Date.now();
    let expiresAt = receivedAt + timeoutMs;
    let timer;
    let cancel;
    try {
      const supplied = request.headers['x-pa-deadline'];
      if (supplied !== undefined) {
        if (typeof supplied !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(supplied)
          || !Number.isFinite(Date.parse(supplied))) throw new ProtocolError('INVALID_ARGUMENT','Invalid invocation deadline');
        expiresAt = Math.min(expiresAt,Date.parse(supplied));
      }
      if (expiresAt <= Date.now()) throw new ProtocolError('TIMEOUT','Invocation deadline expired');
      // Covers uploads, non-cooperative providers and serialization, not only model calls.
      const expired = new Promise((_,reject) => {
        timer = setTimeout(() => {const error = new ProtocolError('TIMEOUT','Invocation deadline expired'); controller.abort(error); reject(error);}, expiresAt-Date.now());
      });
      const cancelled = new Promise((_,reject) => {
        cancel = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort',cancel,{once:true});
        if (controller.signal.aborted) cancel();
      });
      const execute = async () => {
        if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') throw new ProtocolError('INVALID_ARGUMENT','JSON content type required');
        const chunks = []; let size = 0;
        for await (const chunk of request) {
          controller.signal.throwIfAborted();
          size += chunk.length;
          if (size > MAX_BYTES) throw new ProtocolError('INVALID_ARGUMENT','Invocation exceeds body limit');
          chunks.push(chunk);
        }
        controller.signal.throwIfAborted();
        let payload;
        try { payload = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))); }
        catch { throw new ProtocolError('INVALID_ARGUMENT','Invalid invocation JSON'); }
        const query = parsePayload(payload,workflowGoalInput);
        const incomingSession = request.headers['x-hw-agentarts-session-id'];
        const incomingId = request.headers['x-request-id'];
        if ((incomingSession !== undefined && !safeId(incomingSession)) || (incomingId !== undefined && !safeId(incomingId))) throw new ProtocolError('INVALID_ARGUMENT','Invalid request correlation');
        const result = await orchestrator.invoke({query,deadline:new Date(expiresAt).toISOString(),signal:controller.signal,
          sessionId:incomingSession ?? `pa-${randomUUID()}`,requestId:incomingId ?? randomUUID()});
        if (controller.signal.aborted || Date.now() >= expiresAt) throw new ProtocolError('TIMEOUT','Invocation deadline expired');
        const text = JSON.stringify(result);
        if (Buffer.byteLength(text)>64_000) throw new ProtocolError('EXTERNAL_FAILURE','Agent output exceeds limit');
        return [{event:'message',data:{text}},{event:'task_end'},{event:'end'}];
      };
      const result = await Promise.race([execute(),expired,cancelled]);
      if (!response.destroyed) json(response,200,result);
    } catch (error) {
      const code = error instanceof ProtocolError && ['INVALID_ARGUMENT','UNAUTHORIZED','UNSUPPORTED_CAPABILITY','TIMEOUT','CANCELLED','RATE_LIMITED'].includes(error.code)
        ? error.code : 'EXTERNAL_FAILURE';
      if (!response.destroyed) json(response,code==='INVALID_ARGUMENT'?400:code==='TIMEOUT'?504:code==='CANCELLED'?499:502,
        {event:'error',data:{error_code:code,status:'failed'}});
    } finally {
      clearTimeout(timer); if (cancel) controller.signal.removeEventListener('abort',cancel);
      request.removeListener('aborted',abort); response.removeListener('close',abort); active--;
    }
  });
  server.requestTimeout = timeoutMs;
  server.headersTimeout = Math.min(timeoutMs,60_000);
  return server;
}
