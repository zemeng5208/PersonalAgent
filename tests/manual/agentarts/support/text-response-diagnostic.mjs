import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {runInNewContext} from 'node:vm';

const LIMIT = 1024 * 1024;
const EVENT_NAMES = ['task_start', 'workflow_start', 'message', 'workflow_end', 'task_end', 'end', 'error', 'status'];
const REASONS = new Map([
  ['AgentArts response contains conflicting text', 'index_conflict'],
  ['AgentArts response exceeds the text limit', 'text_limit'],
  ['AgentArts workflow event order is malformed', 'workflow_order'],
  ['AgentArts response contains no text', 'no_final_text'],
  ['AgentArts response event is malformed', 'event_shape'],
  ['AgentArts response reported a failure', 'provider_failure'],
  ['AgentArts workflow_end event is malformed', 'answer_type'],
  ['AgentArts message event is malformed', 'message_type'],
  ['AgentArts message index is malformed', 'index_type'],
  ['AgentArts response JSON is malformed', 'json_shape'],
  ['AgentArts SSE response is malformed', 'sse_framing'],
  ['AgentArts response content type is unsupported', 'content_type'],
]);

// Execute only this worktree's locally built parser, never provider code. The
// fragment retains its actual fallback/validation paths; no acceptance rules
// are copied or relaxed. This is diagnostic replay, not a second cloud call.
function parserSnapshot() {
  const source = readFileSync(new URL('../../../../packages/coordination/dist/agentarts.js', import.meta.url), 'utf8');
  const start = source.indexOf('class TextCollector');
  const end = source.indexOf('function defaultFetch', start);
  const objectStart = source.indexOf('function asPlainObject');
  const objectEnd = source.indexOf('function validateRequest', objectStart);
  const limit = source.match(/const MAX_TEXT_CHARS = (\d[\d_]*);/);
  if (start < 0 || end < start || objectStart < 0 || objectEnd < objectStart || !limit) {
    throw new Error('Built AgentArts parser layout is unsupported');
  }
  const program = `const MAX_TEXT_CHARS = ${limit[1]};\n`
    + 'function external(message) { throw new Error(message); }\n'
    + source.slice(objectStart, objectEnd) + source.slice(start, end)
    + '\nparseResponsePayload(payload, contentType).length;';
  return {program, sha256: createHash('sha256').update(source).digest('hex')};
}

function structuralSummary(payload, contentType) {
  const result = {
    framing: 'complete', eventCounts: Object.fromEntries([...EVENT_NAMES, 'other'].map(name => [name, 0])),
    tail: [], messageTypes: {}, answerTypes: {}, globalIndexConflicts: 0, workflowIndexConflicts: 0,
    messageCharacters: 0, maxAnswerCharacters: 0,
  };
  let events = [];
  try {
    if (contentType === 'application/json') {
      const value = JSON.parse(payload);
      events = Array.isArray(value) ? value : [value];
    } else {
      // Structural counters intentionally support only complete JSON data lines.
      // The exact parser replay below separately handles standard multiline SSE.
      for (const line of payload.split(/\r\n|\r|\n/)) {
        if (!line || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) { result.framing = 'not_fully_inspected'; continue; }
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        const value = JSON.parse(data);
        events.push(...(Array.isArray(value) ? value : [value]));
      }
    }
  } catch { result.framing = 'not_fully_inspected'; }
  const globalIndexes = new Map();
  const workflowIndexes = new Map();
  const type = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const countType = (counts, value) => { const name = type(value); counts[name] = (counts[name] ?? 0) + 1; };
  for (const event of events) {
    const name = EVENT_NAMES.includes(event?.event) ? event.event : 'other';
    result.eventCounts[name]++;
    result.tail.push(name);
    if (result.tail.length > 8) result.tail.shift();
    if (name === 'workflow_start') workflowIndexes.clear();
    if (name === 'workflow_end') {
      countType(result.answerTypes, event.data?.answer);
      if (typeof event.data?.answer === 'string') result.maxAnswerCharacters = Math.max(result.maxAnswerCharacters, event.data.answer.length);
    }
    if (name !== 'message') continue;
    const data = event.data;
    countType(result.messageTypes, data?.text);
    if (typeof data?.text !== 'string') continue;
    result.messageCharacters += data.text.length;
    if (!Number.isSafeInteger(data.index) || data.index < 0) continue;
    for (const [indexes, field] of [[globalIndexes, 'globalIndexConflicts'], [workflowIndexes, 'workflowIndexConflicts']]) {
      if (indexes.has(data.index) && indexes.get(data.index) !== data.text) result[field]++;
      indexes.set(data.index, data.text);
    }
  }
  return result;
}

export function inspectTextResponse(bytes, rawContentType) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > LIMIT) return {outcome: 'inspection_limit'};
  let payload;
  try { payload = new TextDecoder('utf-8', {fatal: true}).decode(bytes); }
  catch { return {outcome: 'invalid_utf8'}; }
  const contentType = rawContentType?.split(';', 1)[0]?.trim().toLowerCase();
  const report = {
    outcome: 'inspected', bytes: bytes.byteLength,
    contentType: ['application/json', 'text/event-stream'].includes(contentType) ? contentType : 'other',
  };
  const parser = parserSnapshot();
  report.parserSha256 = parser.sha256;
  report.structure = structuralSummary(payload, report.contentType);
  try {
    report.resultCharacters = runInNewContext(parser.program, {payload, contentType}, {timeout: 1000});
    report.parserOutcome = 'accepted';
  } catch (error) {
    report.parserOutcome = 'rejected';
    report.rejection = REASONS.get(error?.message) ?? 'diagnostic_internal';
  }
  return report;
}

/** Pass to AgentArtsCloudAgentPort only in a manual diagnostic run. No logging,
 * disk writes, secret reads, retry, or raw response escapes through snapshot(). */
export function createTextDiagnosticFetch(innerFetch) {
  let report = {networkCalls: 0};
  return {
    snapshot: () => structuredClone(report),
    fetch: async (url, init) => {
      report = {networkCalls: report.networkCalls + 1, bodyOutcome: 'pending'};
      let response;
      try { response = await innerFetch(url, init); }
      catch (error) { report.transport = 'rejected'; throw error; }
      report.status = Number.isInteger(response.status) ? response.status : null;
      const contentType = response.headers?.get('content-type');
      return {
        status: response.status, headers: response.headers,
        body: {
          async *[Symbol.asyncIterator]() {
            const reader = response.body.getReader();
            let size = 0;
            const chunks = [];
            try {
              while (true) {
                const item = await reader.read();
                if (item.done) break;
                size += item.value.byteLength;
                if (size <= LIMIT) chunks.push(item.value.slice());
                yield item.value;
              }
              report.bodyOutcome = 'complete';
              if (size > LIMIT) report.diagnostic = {outcome: 'inspection_limit'};
              else {
                const bytes = new Uint8Array(size);
                let offset = 0;
                for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
                try { report.diagnostic = inspectTextResponse(bytes, contentType); }
                catch { report.diagnostic = {outcome: 'diagnostic_internal'}; }
              }
            } catch (error) { report.bodyOutcome = 'rejected'; throw error; }
            finally {
              if (report.bodyOutcome === 'pending') report.bodyOutcome = 'interrupted';
              reader.releaseLock();
            }
          },
        },
      };
    },
  };
}
