import {createHash} from 'node:crypto';

/** Trusted host composition only. MCP callers cannot select tasks or grants. */
export function createAgentArtsRuntimeToolInvoker({client, taskId, tools, deadline, exportResult}) {
  const end = Date.parse(deadline);
  if (!client || typeof client.call !== 'function' || typeof taskId !== 'string' || !taskId
    || !Number.isFinite(end) || end <= Date.now() || typeof exportResult !== 'function'
    || !Array.isArray(tools) || tools.length === 0 || tools.length > 16) {
    throw Error('Invalid trusted MCP Runtime binding');
  }
  const bindings = new Map();
  for (const tool of tools) {
    if (!tool || ['name', 'version', 'scopeRef'].some(key => typeof tool[key] !== 'string' || !tool[key])
      || bindings.has(tool.name)) throw Error('Invalid trusted MCP tool binding');
    bindings.set(tool.name, Object.freeze({version: tool.version, scopeRef: tool.scopeRef}));
  }
  return async request => {
    try {
      if (!request || Object.keys(request).some(key => !['name', 'arguments', 'requestId', 'signal'].includes(key))) {
        throw Error();
      }
      const binding = bindings.get(request.name);
      const id = request.requestId;
      if (!binding || !(typeof id === 'string' && id.length > 0 && id.length <= 128
        || typeof id === 'number' && Number.isSafeInteger(id)) || !request.signal
        || request.signal.aborted || end <= Date.now()) throw Error();
      const args = structuredClone(request.arguments);
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw Error();
      // A stable caller request identity is still checked against input by Runtime.
      const runId = 'agentarts-mcp-' + createHash('sha256')
        .update(JSON.stringify([taskId, typeof id, id])).digest('hex');
      const result = await client.call('tool.invoke', {
        toolName: request.name, toolVersion: binding.version,
        arguments: args, scopeRef: binding.scopeRef,
      }, {taskId, idempotencyKey: runId, signal: request.signal,
        timeoutMs: Math.min(end - Date.now(), 2_147_483_647)});
      if (request.signal.aborted || end <= Date.now() || result.state !== 'confirmed'
        || !Array.isArray(result.evidenceRefs) || result.evidenceRefs.length === 0) throw Error();
      // Local execution approval is NOT export permission. The trusted host must
      // explicitly provide this projection; never default to JSON.stringify(result).
      const text = await exportResult({toolName: request.name, result: result.result,
        evidenceRefs: [...result.evidenceRefs], signal: request.signal});
      if (request.signal.aborted || end <= Date.now() || typeof text !== 'string'
        || !text.trim() || Buffer.byteLength(text, 'utf8') > 8192) throw Error();
      return {content: [{type: 'text', text}], isError: false};
    } catch {
      // Do not expose file paths, raw Runtime errors, arguments or credentials.
      return {content: [{type: 'text', text: 'Local tool is unavailable, not approved, or its result cannot be exported.'}], isError: true};
    }
  };
}
