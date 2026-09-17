import {ProtocolError} from '@personal-agent/contracts';
import {createHash} from 'node:crypto';
import {parseCoordinationTextResult} from './index.js';
import type {CloudAgentPort, CoordinationRequest, CoordinationTextResult} from './index.js';

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_TEXT_CHARS = 16_000;
const MAX_AUTHORIZATION_CHARS = 4_096;
const MAX_REQUEST_ID_CHARS = 64;
const MAX_TIMER_DELAY = 2_147_483_647;
const RUNTIME_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_HEADER_VALUE_PATTERN = /^[A-Za-z0-9_-]+$/;
const FORBIDDEN_HEADER_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** The host owns the complete Authorization header value and supplies it per invocation. */
export interface AgentArtsAuthorizationProvider {
  read(signal: AbortSignal): Promise<string>;
}

export interface AgentArtsRuntimeConfig {
  gatewayUrl: string;
  runtimeName: string;
  invokeMode?: 'debug' | 'published';
}

export interface AgentArtsFetchInit {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
  redirect: 'error';
}

interface AgentArtsReader<T> {
  read(): Promise<{done: boolean; value?: T}>;
  releaseLock?(): void;
}

interface AgentArtsReaderBody {
  getReader(): AgentArtsReader<Uint8Array>;
}

type AgentArtsResponseBody = AsyncIterable<Uint8Array> | AgentArtsReaderBody | null;

/** Minimal response surface used by the adapter and by offline test fakes. */
export interface AgentArtsResponse {
  readonly status: number;
  readonly headers?: {get(name: string): string | null};
  readonly body?: AgentArtsResponseBody;
  arrayBuffer?: () => Promise<ArrayBuffer>;
  text?: () => Promise<string>;
}

/** Minimal fetch seam; the default implementation is the host's global fetch. */
export type AgentArtsFetch = (url: string, init: AgentArtsFetchInit) => Promise<AgentArtsResponse>;

type AbortCause = 'cancelled' | 'deadline';

interface CombinedSignal {
  readonly signal: AbortSignal;
  readonly cause: () => AbortCause | undefined;
  readonly deadlineMs: number;
  abort(cause: AbortCause): void;
  dispose(): void;
}

function invalid(message: string): never {
  throw new ProtocolError('INVALID_ARGUMENT', message);
}

function external(message: string, retryable = false): never {
  throw new ProtocolError('EXTERNAL_FAILURE', message, retryable);
}

function abortError(cause: AbortCause): ProtocolError {
  return cause === 'deadline'
    ? new ProtocolError('TIMEOUT', 'AgentArts deadline exceeded', true)
    : new ProtocolError('CANCELLED', 'AgentArts request cancelled');
}

function asPlainObject(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function validateRequest(request: CoordinationRequest): {deadlineMs: number; signal: AbortSignal} {
  const input = asPlainObject(request);
  if (!input) invalid('Invalid AgentArts coordination request');

  const taskId = input.taskId;
  if (typeof taskId !== 'string') invalid('Coordination taskId must be a string');

  const revision = input.revision;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
    invalid('Coordination revision must be a non-negative safe integer');
  }

  const goal = input.goal;
  if (typeof goal !== 'string' || goal.trim().length === 0) invalid('Coordination goal must not be empty');
  if (goal.length > MAX_TEXT_CHARS) invalid('Coordination goal exceeds the text limit');

  const deadline = input.deadline;
  if (typeof deadline !== 'string') invalid('Coordination deadline must be a date string');
  const deadlineMs = Date.parse(deadline);
  if (!Number.isFinite(deadlineMs)) invalid('Coordination deadline is invalid');

  const candidateSignal = input.signal;
  if (candidateSignal === null || typeof candidateSignal !== 'object'
    || typeof (candidateSignal as AbortSignal).addEventListener !== 'function'
    || typeof (candidateSignal as AbortSignal).removeEventListener !== 'function'
    || typeof (candidateSignal as AbortSignal).aborted !== 'boolean') {
    invalid('Coordination signal is invalid');
  }
  const signal = candidateSignal as AbortSignal;
  if (signal.aborted) throw abortError('cancelled');
  if (deadlineMs <= Date.now()) throw abortError('deadline');
  return {deadlineMs, signal};
}

function validateGatewayUrl(gatewayUrl: string): string {
  if (typeof gatewayUrl !== 'string' || gatewayUrl !== gatewayUrl.trim()
    || /\s/.test(gatewayUrl) || FORBIDDEN_HEADER_CHARACTERS.test(gatewayUrl)
    || gatewayUrl.includes('\\') || gatewayUrl.includes('?') || gatewayUrl.includes('#')) {
    invalid('AgentArts gatewayUrl must be an HTTPS origin');
  }
  let parsed: URL;
  try {
    parsed = new URL(gatewayUrl);
  } catch {
    invalid('AgentArts gatewayUrl must be an HTTPS origin');
  }
  const authorityStart = gatewayUrl.indexOf('://') + 3;
  const pathStart = gatewayUrl.slice(authorityStart).search(/[/?#]/);
  const rawPath = pathStart < 0 ? '' : gatewayUrl.slice(authorityStart + pathStart);
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== ''
    || parsed.search !== '' || parsed.hash !== '' || parsed.pathname !== '/'
    || (rawPath !== '' && rawPath !== '/')) {
    invalid('AgentArts gatewayUrl must be an HTTPS origin');
  }
  return parsed.origin;
}

function validateRuntimeConfig(config: AgentArtsRuntimeConfig): {
  gatewayOrigin: string;
  runtimeName: string;
  invokeMode: 'debug' | 'published';
} {
  const value = asPlainObject(config);
  if (!value) invalid('AgentArts runtime config is invalid');
  const gatewayOrigin = validateGatewayUrl(value.gatewayUrl as string);
  const runtimeName = value.runtimeName;
  if (typeof runtimeName !== 'string' || !RUNTIME_NAME_PATTERN.test(runtimeName)) {
    invalid('AgentArts runtimeName is invalid');
  }
  const invokeMode = value.invokeMode === undefined ? 'published' : value.invokeMode;
  if (invokeMode !== 'debug' && invokeMode !== 'published') invalid('AgentArts invokeMode is invalid');
  return {gatewayOrigin, runtimeName, invokeMode};
}

function makeCombinedSignal(parent: AbortSignal, deadlineMs: number): CombinedSignal {
  const controller = new AbortController();
  let abortCause: AbortCause | undefined;
  const abort = (cause: AbortCause): void => {
    if (abortCause === undefined) abortCause = cause;
    if (!controller.signal.aborted) controller.abort();
  };
  const onParentAbort = (): void => abort('cancelled');
  parent.addEventListener('abort', onParentAbort, {once: true});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const scheduleDeadline = (): void => {
    if (controller.signal.aborted) return;
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) {
      abort('deadline');
      return;
    }
    timer = setTimeout(scheduleDeadline, Math.min(MAX_TIMER_DELAY, remaining));
  };
  if (parent.aborted) onParentAbort();
  scheduleDeadline();
  return {
    signal: controller.signal,
    cause: () => abortCause,
    deadlineMs,
    abort,
    dispose(): void {
      if (timer !== undefined) clearTimeout(timer);
      parent.removeEventListener('abort', onParentAbort);
    },
  };
}

function currentAbortError(combined: CombinedSignal): ProtocolError | undefined {
  const cause = combined.cause();
  if (cause !== undefined) return abortError(cause);
  if (combined.signal.aborted) return abortError('cancelled');
  if (Date.now() >= combined.deadlineMs) {
    combined.abort('deadline');
    return abortError('deadline');
  }
  return undefined;
}

function callWithAbort<T>(
  operation: () => PromiseLike<T> | T,
  combined: CombinedSignal,
): Promise<T> {
  const alreadyAborted = currentAbortError(combined);
  if (alreadyAborted) return Promise.reject(alreadyAborted);

  let result: PromiseLike<T> | T;
  try {
    result = operation();
  } catch (error) {
    return Promise.reject(currentAbortError(combined) ?? error);
  }
  const promise = Promise.resolve(result);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => combined.signal.removeEventListener('abort', onAbort);
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(currentAbortError(combined) ?? abortError('cancelled'));
    };
    combined.signal.addEventListener('abort', onAbort, {once: true});
    promise.then(
      value => {
        if (settled) return;
        settled = true;
        cleanup();
        const abort = currentAbortError(combined);
        if (abort) reject(abort);
        else resolve(value);
      },
      error => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(currentAbortError(combined) ?? error);
      },
    );
    if (combined.signal.aborted) onAbort();
  });
}

function deriveSessionId(taskId: string): string {
  // AgentArts permits an arbitrary session identifier. Always hash the local
  // task ID so a stable correlation key is available without exporting the
  // Runtime's internal identifier.
  return `pa-${createSha256(taskId).slice(0, 32)}`;
}

function deriveRequestId(sessionId: string, revision: number): string {
  const candidate = `${sessionId}-${revision}`;
  if (candidate.length <= MAX_REQUEST_ID_CHARS && SAFE_HEADER_VALUE_PATTERN.test(candidate)) return candidate;
  return `pa-${createSha256(`${sessionId}:${revision}`).slice(0, 32)}`;
}

function validateAuthorization(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0
    || value.length > MAX_AUTHORIZATION_CHARS || FORBIDDEN_HEADER_CHARACTERS.test(value)) {
    external('AgentArts authorization is unavailable');
  }
  return value;
}

function createSha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function appendResponseChunk(chunks: Uint8Array[], value: Uint8Array, total: {value: number}): void {
  if (!(value instanceof Uint8Array)) external('AgentArts response body is malformed');
  total.value += value.byteLength;
  if (total.value > MAX_RESPONSE_BYTES) external('AgentArts response exceeds the byte limit');
  chunks.push(value);
}

async function readResponseText(response: AgentArtsResponse, combined: CombinedSignal): Promise<string> {
  const chunks: Uint8Array[] = [];
  const total = {value: 0};
  const body = response.body;
  if (body !== undefined && body !== null) {
    const readerBody = body as Partial<AgentArtsReaderBody>;
    if (typeof readerBody.getReader === 'function') {
      const reader = readerBody.getReader();
      try {
        while (true) {
          const result = await callWithAbort(() => reader.read(), combined);
          if (typeof result.done !== 'boolean') external('AgentArts response body is malformed');
          if (result.done) {
            if (result.value !== undefined) external('AgentArts response body is malformed');
            break;
          }
          if (result.value === undefined) external('AgentArts response body is malformed');
          appendResponseChunk(chunks, result.value, total);
        }
      } finally {
        try {
          reader.releaseLock?.();
        } catch {
          // The response has already been rejected or consumed; release is best effort.
        }
      }
    } else {
      const iterable = body as Partial<AsyncIterable<Uint8Array>>;
      if (typeof iterable[Symbol.asyncIterator] !== 'function') external('AgentArts response body is malformed');
      const iterator = iterable[Symbol.asyncIterator]!();
      try {
        while (true) {
          const result = await callWithAbort(() => iterator.next(), combined);
          if (result.done) {
            if (result.value !== undefined) external('AgentArts response body is malformed');
            break;
          }
          appendResponseChunk(chunks, result.value, total);
        }
      } finally {
        if (typeof iterator.return === 'function') {
          try {
            void Promise.resolve(iterator.return()).catch(() => undefined);
          } catch {
            // A test or transport iterator may throw while being closed; do not expose it.
          }
        }
      }
    }
  } else if (typeof response.arrayBuffer === 'function') {
    const buffer = await callWithAbort(() => response.arrayBuffer!(), combined);
    if (!(buffer instanceof ArrayBuffer)) external('AgentArts response body is malformed');
    appendResponseChunk(chunks, new Uint8Array(buffer), total);
  } else if (typeof response.text === 'function') {
    const value = await callWithAbort(() => response.text!(), combined);
    if (typeof value !== 'string') external('AgentArts response body is malformed');
    // A text-only response seam cannot expose the original bytes. Reject the
    // replacement character and lone surrogates so invalid UTF-8 cannot be
    // silently accepted by a decoder before this adapter sees it.
    if (value.includes('\uFFFD')) external('AgentArts response is not valid UTF-8');
    const encoded = new TextEncoder().encode(value);
    let roundTrip: string;
    try {
      roundTrip = new TextDecoder('utf-8', {fatal: true}).decode(encoded);
    } catch {
      external('AgentArts response is not valid UTF-8');
    }
    if (roundTrip !== value) external('AgentArts response is not valid UTF-8');
    appendResponseChunk(chunks, encoded, total);
  } else {
    external('AgentArts response body is unavailable');
  }

  const bytes = new Uint8Array(total.value);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  } catch {
    external('AgentArts response is not valid UTF-8');
  }
}

class TextCollector {
  private readonly indexed = new Map<number, string>();
  private readonly unindexed: string[] = [];
  private messageLength = 0;
  private workflowSeen = false;
  private finalWorkflowAnswer: string | undefined;
  private terminalPhase: 'open' | 'task-ended' | 'ended' | 'invalid' = 'open';

  add(text: string, index: number | undefined): void {
    if (index !== undefined) {
      if (this.indexed.has(index)) {
        if (this.indexed.get(index) !== text) external('AgentArts response contains conflicting text');
        return;
      }
      this.indexed.set(index, text);
    } else {
      this.unindexed.push(text);
    }
    this.messageLength += text.length;
    if (this.messageLength > MAX_TEXT_CHARS) external('AgentArts response exceeds the text limit');
  }

  startWorkflow(): void {
    if (this.terminalPhase !== 'open') external('AgentArts workflow event order is malformed');
    this.workflowSeen = true;
    this.finalWorkflowAnswer = undefined;
  }

  completeWorkflow(answer: string | null): void {
    // A multi-agent stream can expose intermediate workflow results. Keep only
    // the most recently completed workflow as a candidate; it does not become
    // the invocation result until task_end followed by end is observed.
    if (this.terminalPhase !== 'open') external('AgentArts workflow event order is malformed');
    this.workflowSeen = true;
    if (answer === null) {
      this.finalWorkflowAnswer = undefined;
      return;
    }
    if (answer.length > MAX_TEXT_CHARS) external('AgentArts response exceeds the text limit');
    this.finalWorkflowAnswer = answer;
  }

  markTaskEnd(): void {
    if (this.terminalPhase !== 'open') {
      this.terminalPhase = 'invalid';
      if (this.workflowSeen) external('AgentArts workflow event order is malformed');
      return;
    }
    this.terminalPhase = 'task-ended';
  }

  markEnd(): void {
    if (this.terminalPhase === 'task-ended') {
      this.terminalPhase = 'ended';
      return;
    }
    this.terminalPhase = 'invalid';
    if (this.workflowSeen) external('AgentArts workflow event order is malformed');
  }

  finish(): string {
    const indexedText = [...this.indexed.entries()]
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([, text]) => text);
    const messageText = indexedText.concat(this.unindexed).join('');
    if (this.workflowSeen) {
      if (this.terminalPhase !== 'ended' || this.finalWorkflowAnswer?.trim().length === 0
        || this.finalWorkflowAnswer === undefined) {
        external('AgentArts response contains no text');
      }
      return this.finalWorkflowAnswer;
    }
    if (messageText.trim().length > 0) return messageText;
    external('AgentArts response contains no text');
  }
}

function consumeEvent(value: unknown, collector: TextCollector): void {
  const event = asPlainObject(value);
  if (!event) external('AgentArts response event is malformed');

  // A successful HTTP status does not mean the AgentArts invocation succeeded.
  // Gateways may report an error in the event name or in a status/type field,
  // sometimes after emitting one or more partial message events.  Fail closed
  // before inspecting the event payload so provider details are never exposed.
  const failureFields = ['event', 'type', 'status'];
  const indicatesFailure = (candidate: unknown): boolean => {
    if (typeof candidate !== 'string') return false;
    const tokens = candidate.trim().toLowerCase().split(/[^a-z]+/).filter(Boolean);
    return tokens.some(token => token === 'error' || token === 'failed' || token === 'failure');
  };
  if (failureFields.some(field => indicatesFailure(event[field]))) {
    external('AgentArts response reported a failure');
  }
  const data = asPlainObject(event.data);
  if (data && failureFields.some(field => indicatesFailure(data[field]))) {
    external('AgentArts response reported a failure');
  }

  const eventName = event.event;
  if (typeof eventName !== 'string') external('AgentArts response event is malformed');
  if (eventName === 'workflow_start') {
    collector.startWorkflow();
    return;
  }
  if (eventName === 'workflow_end') {
    if (!data || (typeof data.answer !== 'string' && data.answer !== null)) {
      external('AgentArts workflow_end event is malformed');
    }
    collector.completeWorkflow(data.answer);
    return;
  }
  if (eventName === 'task_end') {
    collector.markTaskEnd();
    return;
  }
  if (eventName === 'end') {
    collector.markEnd();
    return;
  }
  if (eventName !== 'message') return;
  if (!data || (typeof data.text !== 'string' && data.text !== null)) {
    external('AgentArts message event is malformed');
  }
  // Huawei's current response example contains message events with text:null.
  // They carry node metadata but no user-visible result, so ignore them and
  // still require at least one bounded string before the response can succeed.
  if (data.text === null) return;
  let index: number | undefined;
  if (Object.prototype.hasOwnProperty.call(data, 'index')) {
    if (typeof data.index !== 'number' || !Number.isSafeInteger(data.index) || data.index < 0) {
      external('AgentArts message index is malformed');
    }
    index = data.index;
  }
  collector.add(data.text, index);
}

function consumeJson(value: unknown, collector: TextCollector): void {
  if (Array.isArray(value)) {
    for (const event of value) consumeEvent(event, collector);
    return;
  }
  consumeEvent(value, collector);
}

function parseJsonPayload(payload: string, collector: TextCollector): void {
  let value: unknown;
  try {
    value = JSON.parse(payload) as unknown;
  } catch {
    external('AgentArts response JSON is malformed');
  }
  consumeJson(value, collector);
}

function flushSseData(data: string[], collector: TextCollector): boolean {
  if (data.length === 0) return false;
  const payload = data.join('\n');
  data.length = 0;
  if (payload.trim() === '[DONE]') return true;
  parseJsonPayload(payload, collector);
  return false;
}

function parseSseStandard(payload: string, collector: TextCollector): void {
  const data: string[] = [];
  const lines = payload.split(/\r\n|\r|\n/);
  for (const line of lines) {
    if (line === '') {
      if (flushSseData(data, collector)) return;
      continue;
    }
    if (line.startsWith(':')) continue;
    if (!line.startsWith('data:')) external('AgentArts SSE response is malformed');
    let value = line.slice('data:'.length);
    if (value.startsWith(' ')) value = value.slice(1);
    data.push(value);
  }
  flushSseData(data, collector);
}

function parseSseWithoutSeparators(payload: string): TextCollector {
  const collector = new TextCollector();
  const lines = payload.split(/\r\n|\r|\n/);
  let done = false;
  for (const line of lines) {
    if (done || line === '' || line.startsWith(':')) continue;
    if (!line.startsWith('data:')) external('AgentArts SSE response is malformed');
    let value = line.slice('data:'.length);
    if (value.startsWith(' ')) value = value.slice(1);
    if (value.trim() === '[DONE]') {
      done = true;
      continue;
    }
    // Compatibility is intentionally limited to gateways that send one complete
    // JSON event per data line. Anything else remains governed by standard SSE
    // multiline semantics and is rejected if its event is not valid JSON.
    try {
      JSON.parse(value);
    } catch {
      external('AgentArts SSE response is malformed');
    }
    parseJsonPayload(value, collector);
  }
  return collector;
}

function parseSsePayload(payload: string): TextCollector {
  const standard = new TextCollector();
  try {
    parseSseStandard(payload, standard);
    return standard;
  } catch {
    // Some gateways omit the blank separator between self-contained JSON events.
    // Retry only with the conservative line-oriented form; a valid standard
    // multiline event is returned above without ever being split.
    return parseSseWithoutSeparators(payload);
  }
}

function parseResponsePayload(payload: string, contentType: string | undefined): string {
  const mediaType = contentType?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType === 'text/event-stream') return parseSsePayload(payload).finish();
  if (mediaType === 'application/json') {
    const collector = new TextCollector();
    parseJsonPayload(payload, collector);
    return collector.finish();
  }
  external('AgentArts response content type is unsupported');
}

function defaultFetch(url: string, init: AgentArtsFetchInit): Promise<AgentArtsResponse> {
  return globalThis.fetch(url, init);
}

/** Offline-testable text adapter for the huawei_ict_agentarts Competition Profile. */
export class AgentArtsCloudAgentPort implements CloudAgentPort {
  private readonly gatewayOrigin: string;
  private readonly runtimeName: string;
  private readonly invokeMode: 'debug' | 'published';
  private readonly authorizationProvider: AgentArtsAuthorizationProvider;
  private readonly fetchImpl: AgentArtsFetch;

  constructor(
    config: AgentArtsRuntimeConfig,
    authorizationProvider: AgentArtsAuthorizationProvider,
    fetchImpl?: AgentArtsFetch,
  ) {
    const validated = validateRuntimeConfig(config);
    if (!authorizationProvider || typeof authorizationProvider.read !== 'function') {
      invalid('AgentArts authorization provider is invalid');
    }
    if (fetchImpl !== undefined && typeof fetchImpl !== 'function') invalid('AgentArts fetch implementation is invalid');
    this.gatewayOrigin = validated.gatewayOrigin;
    this.runtimeName = validated.runtimeName;
    this.invokeMode = validated.invokeMode;
    this.authorizationProvider = authorizationProvider;
    this.fetchImpl = fetchImpl ?? defaultFetch;
  }

  async invoke(request: CoordinationRequest): Promise<CoordinationTextResult> {
    const {deadlineMs, signal} = validateRequest(request);
    const combined = makeCombinedSignal(signal, deadlineMs);
    try {
      const initialAbort = currentAbortError(combined);
      if (initialAbort) throw initialAbort;

      let authorization: unknown;
      try {
        authorization = await callWithAbort(() => this.authorizationProvider.read(combined.signal), combined);
      } catch (error) {
        throw currentAbortError(combined) ?? new ProtocolError('EXTERNAL_FAILURE', 'AgentArts authorization is unavailable');
      }
      const authorizationAbort = currentAbortError(combined);
      if (authorizationAbort) throw authorizationAbort;
      const authorizationHeader = validateAuthorization(authorization);
      const headerAbort = currentAbortError(combined);
      if (headerAbort) throw headerAbort;

      const sessionId = deriveSessionId(request.taskId);
      const requestId = deriveRequestId(sessionId, request.revision);
      const url = `${this.gatewayOrigin}/runtimes/${encodeURIComponent(this.runtimeName)}/invocations`;
      const init: AgentArtsFetchInit = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json,text/event-stream',
          Authorization: authorizationHeader,
          'x-hw-agentarts-session-id': sessionId,
          'X-Invoke-Mode': this.invokeMode,
          'X-Request-Id': requestId,
        },
        body: JSON.stringify({query: request.goal}),
        signal: combined.signal,
        redirect: 'error',
      };

      let response: AgentArtsResponse;
      try {
        response = await callWithAbort(() => this.fetchImpl(url, init), combined);
      } catch (error) {
        throw currentAbortError(combined) ?? new ProtocolError('EXTERNAL_FAILURE', 'AgentArts request failed', true);
      }
      const fetchAbort = currentAbortError(combined);
      if (fetchAbort) throw fetchAbort;
      let status: unknown;
      let responseObject = false;
      try {
        responseObject = response !== null && typeof response === 'object' && !Array.isArray(response);
        status = responseObject ? response.status : undefined;
      } catch {
        external('AgentArts response is malformed');
      }
      if (!responseObject || typeof status !== 'number' || !Number.isInteger(status)) {
        external('AgentArts response is malformed');
      }
      if (status < 200 || status >= 300) {
        throw new ProtocolError('EXTERNAL_FAILURE', 'AgentArts request returned a non-success HTTP status', status >= 500);
      }

      let text: string;
      try {
        text = parseResponsePayload(
          await readResponseText(response, combined),
          response.headers?.get('content-type') ?? undefined,
        );
      } catch (error) {
        throw currentAbortError(combined) ?? new ProtocolError('EXTERNAL_FAILURE', 'AgentArts response validation failed');
      }
      const bodyAbort = currentAbortError(combined);
      if (bodyAbort) throw bodyAbort;
      try {
        return parseCoordinationTextResult({kind: 'text', text, verification: 'unverified'});
      } catch (error) {
        throw currentAbortError(combined) ?? new ProtocolError('EXTERNAL_FAILURE', 'AgentArts response validation failed');
      }
    } finally {
      combined.dispose();
    }
  }
}
