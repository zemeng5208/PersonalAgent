import {randomBytes, randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {basename, isAbsolute} from 'node:path';
import {ProtocolError} from '@personal-agent/contracts';
import type {RegisteredTool, ToolContext} from '@personal-agent/contracts';
import {toolArgumentsDigest} from '@personal-agent/tool-gateway';
import {
  WINDOWS_HOST_PROTOCOL_VERSION, WINDOWS_HOST_TOOL_NAME, encodeWindowsHostFrame, parseWindowsHostFrame,
  validateWindowsHostHandshake, validateWindowsHostObservation, validateWindowsHostResult,
  validateWindowsHostStatus,
} from '@personal-agent/contracts/windows-host';
import type {
  WindowsHostBind, WindowsHostExecute, WindowsHostHello,
  WindowsHostResult, WindowsHostStatus, WindowsHostStatusReply, WindowsHostFrame,
} from '@personal-agent/contracts/windows-host';

/** The trusted native bridge must verify the connected pipe server's OS process identity
 * before returning a frame stream. The Host independently verifies the bridge client. */
export interface VerifiedWindowsHostConnection {
  exchange(frame: WindowsHostFrame): Promise<unknown>;
  send(frame: WindowsHostFrame): Promise<void>;
  close(): Promise<void>;
}
export interface WindowsHostTransport {
  openVerifiedConnection(): Promise<VerifiedWindowsHostConnection>;
  close?(): Promise<void>;
}

/** Spawns the native bridge for one Host session. stderr is a fixed readiness channel;
 * stdin/stdout carry the unchanged Windows Host 0.1.0 JSONL frames. */
export function createWindowsHostBridgeTransport(options: {
  bridgePath: string;
  hostPath: string;
  timeoutMs?: number;
}): WindowsHostTransport & {close(): Promise<void>} {
  if (process.platform !== 'win32' || !isAbsolute(options.bridgePath)
    || !isAbsolute(options.hostPath)
    || basename(options.bridgePath).toLowerCase() !== 'windowshost.pipebridge.exe'
    || basename(options.hostPath).toLowerCase() !== 'windowshost.host.exe') {
    throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'Windows Host native bridge is unavailable');
  }
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs)
    || options.timeoutMs < 100 || options.timeoutMs > 10000)) {
    throw new ProtocolError('INVALID_ARGUMENT', 'Invalid Windows Host transport timeout');
  }
  const bridgePath = options.bridgePath;
  const hostPath = options.hostPath;
  const timeout = options.timeoutMs ?? 5000;
  const children = new Set<ChildProcessWithoutNullStreams>();
  let closed = false;
  const stop = async (child: ChildProcessWithoutNullStreams): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, timeout);
      child.once('close', () => { clearTimeout(timer); resolve(); });
      child.kill();
    });
  };
  return {
    async openVerifiedConnection() {
      if (closed) throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'Windows Host transport is closed');
      const child = spawn(bridgePath, ['--host', hostPath],
        {windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
      children.add(child);
      child.on('error', () => undefined);
      child.once('close', () => children.delete(child));
      try {
        await new Promise<void>((resolve, reject) => {
          let ready = '';
          const timer = setTimeout(() => finish(new ProtocolError('TIMEOUT', 'Windows Host bridge timed out')), timeout);
          const finish = (error?: Error): void => {
            clearTimeout(timer);
            child.stderr.off('data', onData);
            child.off('error', onError);
            child.off('close', onClose);
            error ? reject(error) : resolve();
          };
          const onData = (chunk: Buffer): void => {
            ready += chunk.toString('ascii');
            if (ready.length > 32 || ready.includes('\r') || (ready.includes('\n') && ready !== 'VERIFIED\n')) {
              finish(new ProtocolError('UNAUTHORIZED', 'Windows Host bridge refused peer verification'));
            } else if (ready === 'VERIFIED\n') finish();
          };
          const onError = (): void => finish(new ProtocolError('EXTERNAL_FAILURE', 'Windows Host bridge failed to start'));
          const onClose = (): void => finish(new ProtocolError('UNAUTHORIZED', 'Windows Host bridge exited before verification'));
          child.stderr.on('data', onData);
          child.once('error', onError);
          child.once('close', onClose);
        });
      } catch (error) { await stop(child); throw error; }
      let pending: ((value: unknown) => void) | undefined;
      let rejectPending: ((error: Error) => void) | undefined;
      let buffer = Buffer.alloc(0);
      let responseTimer: ReturnType<typeof setTimeout> | undefined;
      const fail = (error: Error): void => {
        if (responseTimer) clearTimeout(responseTimer);
        rejectPending?.(error); pending = undefined; rejectPending = undefined;
      };
      child.on('close', () => fail(new Error('Windows Host bridge disconnected')));
      child.stdin.on('error', fail);
      child.stdout.on('error', fail);
      child.stdout.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > 1024 * 1024) { child.kill(); fail(new Error('Windows Host frame too large')); return; }
        const end = buffer.indexOf(10);
        if (end < 0) return;
        const line = buffer.subarray(0, end);
        buffer = buffer.subarray(end + 1);
        if (buffer.length || !pending) { child.kill(); fail(new Error('Unsolicited Windows Host frame')); return; }
        try {
          if (line.includes(13) || line.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
            throw new Error('Windows Host frame has BOM or CRLF');
          }
          const value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(line)) as unknown;
          const resolve = pending;
          if (responseTimer) clearTimeout(responseTimer);
          pending = undefined; rejectPending = undefined;
          resolve(value);
        } catch { child.kill(); fail(new Error('Invalid Windows Host UTF-8 or JSON')); }
      });
      const send = async (frame: WindowsHostFrame): Promise<void> => {
        const bytes = encodeWindowsHostFrame(frame);
        if (child.stdin.destroyed || child.exitCode !== null) throw new Error('Windows Host bridge is closed');
        await new Promise<void>((resolve, reject) => child.stdin.write(bytes, error => error ? reject(error) : resolve()));
      };
      return {
        send,
        async exchange(frame: WindowsHostFrame): Promise<unknown> {
          if (pending) throw new ProtocolError('REVISION_CONFLICT', 'Windows Host request already pending');
          const answer = new Promise<unknown>((resolve, reject) => { pending = resolve; rejectPending = reject; });
          const deadline = 'deadline' in frame ? Date.parse(frame.deadline) - Date.now() : timeout;
          responseTimer = setTimeout(() => { child.kill(); fail(new Error('Windows Host response timed out')); },
            Math.min(Math.max(1, deadline), 300_000));
          try { await send(frame); return await answer; }
          catch (error) { fail(error as Error); throw error; }
        },
        async close() { await stop(child); },
      };
    },
    async close() { closed = true; await Promise.all([...children].map(stop)); },
  };
}

export type WindowsHostRunIdentity = Pick<WindowsHostExecute,
  'taskId' | 'runId' | 'toolName' | 'toolVersion' | 'argumentsDigest' | 'targetRef'>;

export interface WindowsHostAttemptStore {
  /** Durable, create-only record. Must reject reuse of a runId before Host execute. Never store text. */
  record(identity: WindowsHostRunIdentity): Promise<void>;
  read(taskId: string, runId: string): Promise<WindowsHostRunIdentity | undefined>;
}

export interface WindowsHostAdapterOptions {
  transport: WindowsHostTransport;
  attempts: WindowsHostAttemptStore;
  now?: () => number;
  /** Desktop derives live local presence for this task. Checked at observation and again before execution. */
  authorizePresence(input: {taskId: string; targetRef?: string; deadline: string;
    signal: AbortSignal}): Promise<boolean>;
  /** Independent trusted target readback after the Host's internal UIA receipt. */
  verifyTarget(input: {identity: WindowsHostRunIdentity; expectedText: string;
    replacementText: string; hostEvidenceRef: string; signal: AbortSignal; deadline: string}): Promise<boolean>;
}

export interface ObservedNotepad {
  targetRef: string;
  expiresAt: string;
}
export type WindowsHostRecovery = {state: 'unknown'; reason: 'in_progress' | 'not_found' | 'host_result';
  hostResult?: WindowsHostResult};

const VERSION = '1.0.0';
const SCOPE = 'computer:notepad:write';
type Input = {targetRef: string; expectedText: string; replacementText: string};
type Bound = {connection: VerifiedWindowsHostConnection; sessionId: string};
const id = (): string => randomUUID();
const frameBase = (sessionId: string) => ({protocolVersion: WINDOWS_HOST_PROTOCOL_VERSION,
  requestId: id(), sessionId});
function unknown(message: string): never { throw new ProtocolError('RESULT_UNKNOWN', message); }
function observationCode(code: string): string {
  if (code === 'TARGET_AMBIGUOUS') return 'UNAUTHORIZED';
  if (code === 'TARGET_STALE') return 'NOT_FOUND';
  return code;
}
function active(context: Pick<ToolContext, 'signal' | 'deadline'>, now: () => number): void {
  if (context.signal.aborted) throw new ProtocolError('CANCELLED', 'Windows Host request cancelled');
  if (now() >= Date.parse(context.deadline)) throw new ProtocolError('TIMEOUT', 'Windows Host deadline expired');
}
async function open(transport: WindowsHostTransport): Promise<Bound> {
  const connection = await transport.openVerifiedConnection();
  try {
    const hello: WindowsHostHello = {kind: 'hello', protocolVersion: WINDOWS_HOST_PROTOCOL_VERSION,
      requestId: id(), clientNonce: randomBytes(16).toString('hex')};
    const reply = parseWindowsHostFrame(await connection.exchange(hello));
    if (reply.kind !== 'hello_ack') throw new ProtocolError('PROTOCOL_MISMATCH', 'Windows Host hello was not acknowledged');
    const bind: WindowsHostBind = {kind: 'bind', protocolVersion: WINDOWS_HOST_PROTOCOL_VERSION,
      requestId: hello.requestId, sessionId: reply.sessionId, hostNonce: reply.hostNonce};
    validateWindowsHostHandshake(hello, reply, bind);
    await connection.send(bind);
    return {connection, sessionId: reply.sessionId};
  } catch (error) { await connection.close(); throw error; }
}

/** Adapter is only registered by trusted composition when both Host and readback are available. */
export function createWindowsHostNotepadAdapter(options: WindowsHostAdapterOptions): {
  tool: RegisteredTool;
  observe(taskId: string, deadline: string, signal: AbortSignal): Promise<ObservedNotepad>;
  recover(taskId: string, runId: string): Promise<WindowsHostRecovery>;
  close(): Promise<void>;
} {
  if (!options.transport || !options.attempts || typeof options.attempts.record !== 'function'
    || typeof options.attempts.read !== 'function' || typeof options.authorizePresence !== 'function'
    || typeof options.verifyTarget !== 'function') {
    throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'Trusted Host, durable attempt store, presence and target readback are required');
  }
  const observed = new Map<string, {bound: Bound; target: ObservedNotepad}>();
  const now = options.now ?? Date.now;
  let closed = false;
  let occupied = false;
  const ensureOpen = () => {
    if (closed) throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'Windows Host adapter is closed');
  };
  const presenceAllowed = async (input: Parameters<WindowsHostAdapterOptions['authorizePresence']>[0]): Promise<boolean> => {
    try { return await options.authorizePresence(input) === true; }
    catch { return false; } // The trusted host may include private desktop details in an error.
  };

  async function observe(taskId: string, deadline: string, signal: AbortSignal): Promise<ObservedNotepad> {
    ensureOpen();
    active({deadline, signal}, now);
    if (occupied) throw new ProtocolError('REVISION_CONFLICT', 'Windows Host session is occupied');
    if (!await presenceAllowed({taskId, deadline, signal})) {
      throw new ProtocolError('UNAUTHORIZED', 'Local user presence was not authorized');
    }
    active({deadline, signal}, now);
    occupied = true;
    let bound: Bound;
    try { bound = await open(options.transport); }
    catch (error) { occupied = false; throw error; }
    try {
      active({deadline, signal}, now);
      const request = {kind: 'observe' as const, ...frameBase(bound.sessionId), deadline,
        capability: 'notepad.replace_text' as const};
      const reply = parseWindowsHostFrame(await bound.connection.exchange(request));
      if (reply.kind !== 'observed' && reply.kind !== 'observation_refused') {
        throw new ProtocolError('PROTOCOL_MISMATCH', 'Windows Host observation reply mismatch');
      }
      validateWindowsHostObservation(request, reply);
      if (reply.kind === 'observation_refused') {
        throw new ProtocolError(observationCode(reply.errorCode), 'Windows Host refused Notepad observation');
      }
      if (Date.parse(reply.expiresAt) <= now()) throw new ProtocolError('TIMEOUT', 'Notepad target already expired');
      const target = {targetRef: reply.targetRef, expiresAt: reply.expiresAt};
      observed.set(taskId, {bound, target});
      return target;
    } catch (error) { await bound.connection.close(); occupied = false; throw error; }
  }

  async function poll(bound: Bound, identity: WindowsHostRunIdentity): Promise<WindowsHostResult | WindowsHostStatusReply> {
    const status: WindowsHostStatus = {kind: 'status', ...frameBase(bound.sessionId), ...identity};
    const reply = parseWindowsHostFrame(await bound.connection.exchange(status));
    if (reply.kind !== 'result' && reply.kind !== 'status_reply') {
      throw new ProtocolError('PROTOCOL_MISMATCH', 'Windows Host status reply mismatch');
    }
    validateWindowsHostStatus(status, reply);
    return reply;
  }

  async function reconcile(identity: WindowsHostRunIdentity): Promise<WindowsHostRecovery> {
    const bound = await open(options.transport);
    try {
      const reply = await poll(bound, identity);
      return reply.kind === 'result' ? {state: 'unknown', reason: 'host_result', hostResult: reply}
        : {state: 'unknown', reason: reply.state};
    }
    finally { await bound.connection.close(); }
    // A Host not_found reply means unknown, never permission to execute again.
  }

  async function recover(taskId: string, runId: string): Promise<WindowsHostRecovery> {
    ensureOpen();
    if (occupied) throw new ProtocolError('REVISION_CONFLICT', 'Windows Host session is occupied');
    occupied = true;
    try {
      const identity = await options.attempts.read(taskId, runId);
      if (!identity || identity.taskId !== taskId || identity.runId !== runId) {
        throw new ProtocolError('NOT_FOUND', 'Original Windows Host run identity is unavailable');
      }
      return await reconcile(identity);
    } finally { occupied = false; }
  }

  const tool: RegisteredTool = {
    descriptor: {
      name: WINDOWS_HOST_TOOL_NAME, version: VERSION,
      inputSchema: {type: 'object', required: ['targetRef', 'expectedText', 'replacementText'],
        additionalProperties: false, properties: {
          targetRef: {type: 'string', minLength: 16, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$'},
          expectedText: {type: 'string', maxLength: 4096},
          replacementText: {type: 'string', maxLength: 4096},
        }},
      outputSchema: {type: 'object', required: ['state', 'hostEvidenceRef'], additionalProperties: false,
        properties: {state: {const: 'verified'}, hostEvidenceRef: {type: 'string', minLength: 1}}},
      sideEffect: 'local_write', requiredScopes: [SCOPE], idempotencySupport: true,
      // Runtime's current wire tool.invoke does not carry trusted userPresent. This adapter
      // requires Desktop's task-bound live presence check and the short-lived Host target.
      recoverySupport: true, requiresPresence: false,
    },
    async execute(raw, context) {
      ensureOpen();
      const input = raw as Input;
      const entry = observed.get(context.taskId);
      if (!entry || input.targetRef !== entry.target.targetRef
        || now() >= Date.parse(entry.target.expiresAt)) {
        throw new ProtocolError('UNAUTHORIZED', 'Notepad target is absent, stale or belongs to another task');
      }
      observed.delete(context.taskId); // one observation, one attempt
      const {bound} = entry;
      const identity: WindowsHostRunIdentity = {taskId: context.taskId, runId: context.runId,
        toolName: WINDOWS_HOST_TOOL_NAME, toolVersion: VERSION,
        argumentsDigest: toolArgumentsDigest(input), targetRef: input.targetRef};
      let started = false;
      try {
        active(context, now);
        if (!await presenceAllowed({taskId: context.taskId, targetRef: input.targetRef,
          deadline: context.deadline, signal: context.signal})) {
          throw new ProtocolError('UNAUTHORIZED', 'Local user presence was not authorized');
        }
        active(context, now);
        if (input.expectedText === input.replacementText) {
          throw new ProtocolError('INVALID_ARGUMENT', 'Notepad replacement must change text');
        }
        if (await options.attempts.read(context.taskId, context.runId)) {
          unknown('Windows Host run already exists; reconcile it without replay');
        }
        await options.attempts.record(identity);
        active(context, now);
        const execute: WindowsHostExecute = {kind: 'execute', ...frameBase(bound.sessionId),
          ...identity, authorizationRef: context.authorizationRef, deadline: context.deadline,
          expectedText: input.expectedText, replacementText: input.replacementText};
        started = true;
        const onAbort = (): void => {
          const cancel = {kind: 'cancel' as const, ...frameBase(bound.sessionId), ...identity};
          void bound.connection.send(cancel).finally(() => bound.connection.close()).catch(() => undefined);
        };
        context.signal.addEventListener('abort', onAbort, {once: true});
        try {
          active(context, now); // no Host execute after a late abort or expired deadline
          const reply = parseWindowsHostFrame(await bound.connection.exchange(execute));
          if (reply.kind !== 'result') unknown('Windows Host did not return a terminal result');
          validateWindowsHostResult(execute, reply);
          if (context.signal.aborted) unknown('Windows Host cancellation requires status reconciliation');
          if (reply.state !== 'verified' || !reply.evidenceRef) unknown('Windows Host write requires reconciliation');
          active(context, now);
          const readback = await options.verifyTarget({identity, expectedText: input.expectedText,
            replacementText: input.replacementText, hostEvidenceRef: reply.evidenceRef,
            signal: context.signal, deadline: context.deadline});
          if (readback !== true || context.signal.aborted) unknown('Notepad target readback did not verify the write');
          return {state: 'verified', hostEvidenceRef: reply.evidenceRef};
        } finally { context.signal.removeEventListener('abort', onAbort); }
      } catch (error) {
        if (!started) throw error;
        // Never replay execute. A new authenticated Host session may query the journal.
        await bound.connection.close();
        try { await reconcile(identity); } catch { /* original unknown remains */ }
        throw error;
      } finally { await bound.connection.close(); occupied = false; }
    },
  };

  return {tool, observe, recover, async close() {
    if (closed) return;
    closed = true;
    occupied = false;
    const pending = [...observed.values()];
    observed.clear();
    await Promise.all(pending.map(item => item.bound.connection.close()));
    await options.transport.close?.();
  }};
}
