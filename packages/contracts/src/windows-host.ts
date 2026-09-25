import {Ajv2020} from 'ajv/dist/2020.js';
import schema from '../schema/windows-host.json' with {type: 'json'};
import {MAX_FRAME_BYTES, ProtocolError} from './index.js';

export const WINDOWS_HOST_PROTOCOL_VERSION = '0.1.0';
export const WINDOWS_HOST_TOOL_NAME = 'computer.notepad.replace_text';

type Base = {kind: string; protocolVersion: string; requestId: string};
type Session = Base & {sessionId: string};
export type WindowsHostHello = Base & {kind: 'hello'; clientNonce: string};
export type WindowsHostHelloAck = Base & {kind: 'hello_ack'; clientNonce: string; hostNonce: string; sessionId: string};
export type WindowsHostBind = Session & {kind: 'bind'; hostNonce: string};
export type WindowsHostObserve = Session & {kind: 'observe'; deadline: string; capability: 'notepad.replace_text'};
export type WindowsHostObserved = Session & {kind: 'observed'; targetRef: string; expiresAt: string; source: 'windows-uia'};
export type WindowsHostExecute = Session & {
  kind: 'execute'; taskId: string; runId: string; toolName: typeof WINDOWS_HOST_TOOL_NAME;
  toolVersion: '1.0.0'; authorizationRef: string; argumentsDigest: string;
  targetRef: string; deadline: string; expectedText: string; replacementText: string;
};
type RunIdentity = {taskId: string; runId: string; toolName: typeof WINDOWS_HOST_TOOL_NAME;
  toolVersion: '1.0.0'; argumentsDigest: string; targetRef: string};
export type WindowsHostCancel = Session & RunIdentity & {kind: 'cancel'};
export type WindowsHostStatus = Session & RunIdentity & {kind: 'status'};
export type WindowsHostStatusReply = Session & {kind: 'status_reply'; taskId: string; runId: string;
  state: 'in_progress' | 'not_found'};
export type WindowsHostResult = Session & {
  kind: 'result'; taskId: string; runId: string; toolName: typeof WINDOWS_HOST_TOOL_NAME;
  toolVersion: '1.0.0'; argumentsDigest: string; targetRef: string;
  state: 'verified' | 'refused' | 'cancelled' | 'result_unknown';
  startedAt: string; finishedAt: string; evidenceRef?: string; errorCode?: string;
};
export type WindowsHostFrame = WindowsHostHello | WindowsHostHelloAck | WindowsHostBind
  | WindowsHostObserve | WindowsHostObserved | WindowsHostExecute | WindowsHostCancel
  | WindowsHostStatus | WindowsHostStatusReply | WindowsHostResult;

const ajv = new Ajv2020({allErrors: true, strict: false});
const validate = ajv.compile(schema);

function invalid(message: string): never { throw new ProtocolError('INVALID_ARGUMENT', message); }
function isUtc(value: string): boolean {
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

/** Validates the private Host wire frame. This does not authenticate the pipe peer or authorize an action. */
export function parseWindowsHostFrame(value: unknown): WindowsHostFrame {
  if (!validate(value)) invalid('Windows Host frame does not match schema');
  const frame = value as WindowsHostFrame;
  const times = frame.kind === 'execute' || frame.kind === 'observe' ? [frame.deadline]
    : frame.kind === 'observed' ? [frame.expiresAt]
      : frame.kind === 'result' ? [frame.startedAt, frame.finishedAt] : [];
  if (times.some((time) => !isUtc(time))) invalid('Windows Host frame has an invalid UTC time');
  if (frame.kind === 'result') {
    if (Date.parse(frame.finishedAt) < Date.parse(frame.startedAt)) invalid('Windows Host result time order is invalid');
    if (frame.state === 'verified') {
      if (!frame.evidenceRef || frame.errorCode) invalid('Verified result requires evidence and no error');
    } else if (!frame.errorCode) invalid('Nonverified result requires an error code');
  }
  return frame;
}

export function encodeWindowsHostFrame(value: WindowsHostFrame): Uint8Array {
  parseWindowsHostFrame(value);
  const bytes = new TextEncoder().encode(JSON.stringify(value) + '\n');
  if (bytes.length > MAX_FRAME_BYTES) invalid('Windows Host frame exceeds 1 MiB');
  return bytes;
}

/** Call only after verifying the pipe peer belongs to the expected current-user process. */
export function validateWindowsHostHandshake(hello: WindowsHostHello, ack: WindowsHostHelloAck, bind: WindowsHostBind): void {
  parseWindowsHostFrame(hello); parseWindowsHostFrame(ack); parseWindowsHostFrame(bind);
  if (hello.requestId !== ack.requestId || hello.clientNonce !== ack.clientNonce
    || ack.sessionId !== bind.sessionId || ack.hostNonce !== bind.hostNonce
    || hello.protocolVersion !== ack.protocolVersion || ack.protocolVersion !== bind.protocolVersion) {
    invalid('Windows Host handshake correlation mismatch');
  }
}

export function validateWindowsHostObservation(request: WindowsHostObserve, reply: WindowsHostObserved): void {
  parseWindowsHostFrame(request); parseWindowsHostFrame(reply);
  if (request.requestId !== reply.requestId || request.sessionId !== reply.sessionId
    || request.protocolVersion !== reply.protocolVersion) invalid('Windows Host observation correlation mismatch');
}

/** A status poll may use a new requestId; pass it explicitly while retaining the original execute frame. */
export function validateWindowsHostResult(request: WindowsHostExecute, reply: WindowsHostResult, responseRequestId = request.requestId): void {
  parseWindowsHostFrame(request); parseWindowsHostFrame(reply);
  if (reply.requestId !== responseRequestId || reply.sessionId !== request.sessionId
    || reply.protocolVersion !== request.protocolVersion || reply.taskId !== request.taskId
    || reply.runId !== request.runId || reply.toolName !== request.toolName
    || reply.toolVersion !== request.toolVersion || reply.argumentsDigest !== request.argumentsDigest
    || reply.targetRef !== request.targetRef) {
    invalid('Windows Host result correlation mismatch');
  }
}

export function validateWindowsHostStatus(request: WindowsHostStatus, reply: WindowsHostStatusReply | WindowsHostResult): void {
  parseWindowsHostFrame(request); parseWindowsHostFrame(reply);
  if (reply.requestId !== request.requestId || reply.sessionId !== request.sessionId
    || reply.protocolVersion !== request.protocolVersion || reply.taskId !== request.taskId
    || reply.runId !== request.runId || (reply.kind === 'result' && (
      reply.toolName !== request.toolName || reply.toolVersion !== request.toolVersion
      || reply.argumentsDigest !== request.argumentsDigest || reply.targetRef !== request.targetRef))) {
    invalid('Windows Host status correlation mismatch');
  }
}

/** Reconnected polling uses a new session; the original targetRef is only a historical run identity. */
export function validateWindowsHostRecoveredResult(original: WindowsHostExecute,
  poll: WindowsHostStatus, reply: WindowsHostResult): void {
  parseWindowsHostFrame(original);
  validateWindowsHostStatus(poll, reply);
  if (poll.sessionId === original.sessionId || poll.taskId !== original.taskId
    || poll.runId !== original.runId || poll.toolName !== original.toolName
    || poll.toolVersion !== original.toolVersion || poll.argumentsDigest !== original.argumentsDigest
    || poll.targetRef !== original.targetRef) {
    invalid('Windows Host recovered run identity mismatch');
  }
}
