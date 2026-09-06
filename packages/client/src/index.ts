import {parseRequest, parseResponse, parseEvent, ProtocolError, PROTOCOL_VERSION} from '@personal-agent/contracts';
import type {Operation, Payload, Result, Request, Event} from '@personal-agent/contracts';

export interface Transport {
  send(request: Request, signal: AbortSignal): Promise<unknown>;
}
export interface CallOptions { signal?: AbortSignal; timeoutMs?: number; idempotencyKey?: string }
export class Client {
  private capabilities = new Set<string>();
  private connected = false;
  constructor(private readonly transport: Transport, private readonly now: () => number = Date.now) {}
  async connect(): Promise<Result<'system.handshake'>> {
    this.connected = false;
    const result = await this.call('system.handshake', {supportedMajor: 1, clientCapabilities: []});
    if (!/^1\.\d+\.\d+$/.test(result.protocolVersion)) throw new ProtocolError('PROTOCOL_MISMATCH', 'Handshake version mismatch');
    this.capabilities = new Set(result.capabilities);
    this.connected = true;
    return result;
  }
  async call<K extends Operation>(operation: K, payload: Payload<K>, options: CallOptions = {}): Promise<Result<K>> {
    if (operation !== 'system.handshake' && (!this.connected || !this.capabilities.has(operation))) {
      throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'Operation not negotiated');
    }
    const timeoutMs = options.timeoutMs ?? 10000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw new ProtocolError('INVALID_ARGUMENT', 'Invalid timeout');
    const request = parseRequest({
      kind: 'request', protocolVersion: PROTOCOL_VERSION, requestId: crypto.randomUUID(),
      operation, deadline: new Date(this.now() + timeoutMs).toISOString(), payload,
      ...(options.idempotencyKey ? {idempotencyKey: options.idempotencyKey} : {}),
    });
    if (options.signal?.aborted) throw new ProtocolError('CANCELLED', 'Call aborted');
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel = () => {};
    const stopped = new Promise<never>((_, reject) => {
      cancel = () => {
        controller.abort();
        reject(new ProtocolError('CANCELLED', 'Call aborted; task state must be reconciled separately'));
      };
      options.signal?.addEventListener('abort', cancel, {once: true});
      timer = setTimeout(() => {
        controller.abort();
        reject(new ProtocolError('TIMEOUT', 'Call deadline exceeded; no automatic retry'));
      }, timeoutMs);
    });
    try {
      const response = parseResponse(await Promise.race([this.transport.send(request, controller.signal), stopped]), operation, request.requestId);
      if (response.outcome === 'error') throw new ProtocolError(response.error.code, response.error.message, response.error.retryable, response.error.retryAfterMs);
      return response.data as Result<K>;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', cancel);
    }
  }
}

// One instance per subscription stream. Gaps require replay or an explicit snapshot resync.
export class EventCursor {
  private sequence = 0;
  private ids = new Map<number, string>();
  constructor(readonly streamId: string, afterSequence = 0) { this.reset(afterSequence); }
  get afterSequence(): number { return this.sequence; }
  reset(afterSequence: number): void {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new ProtocolError('INVALID_ARGUMENT', 'Invalid cursor');
    this.sequence = afterSequence; this.ids.clear();
  }
  accept(values: unknown[]): Event[] {
    const events = values.map(parseEvent).sort((a,b) => a.sequence - b.sequence);
    const accepted: Event[] = [];
    const ids = new Map(this.ids);
    let sequence = this.sequence;
    for (const event of events) {
      if (event.streamId !== this.streamId) throw new ProtocolError('INVALID_ARGUMENT', 'Wrong stream');
      if (event.sequence <= sequence) {
        const id = ids.get(event.sequence);
        if (id && id !== event.eventId) throw new ProtocolError('INVALID_ARGUMENT', 'Conflicting event sequence');
        continue;
      }
      if (event.sequence !== sequence + 1) throw new ProtocolError('CURSOR_EXPIRED', 'Event gap; replay or resync required');
      if ([...ids.values()].includes(event.eventId)) throw new ProtocolError('INVALID_ARGUMENT', 'Event ID reused');
      sequence = event.sequence; ids.set(sequence, event.eventId); accepted.push(event);
      if (ids.size > 512) ids.delete(ids.keys().next().value!);
    }
    this.sequence = sequence; this.ids = ids;
    return accepted;
  }
}
