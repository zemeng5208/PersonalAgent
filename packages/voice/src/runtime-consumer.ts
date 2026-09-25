import {createHash} from 'node:crypto';

import type {CallOptions, Client} from '@personal-agent/client';

import {VoiceSessionError} from './errors.js';
import {
  MAX_SPEECH_CHARACTERS,
  MAX_TRANSCRIPT_CHARACTERS,
} from './ports.js';
import type {
  TranscriptConsumerPort,
  TranscriptConsumptionRequest,
  TranscriptConsumptionResult,
  VoiceOperation,
  VoiceOperationStopReason,
} from './ports.js';

const DEFAULT_POLL_INTERVAL_MS = 100;
const MAX_TIMER_MS = 2_147_483_647;
const MAX_TRACKED_IDENTITIES = 1_024;

type RuntimeTaskClient = Pick<Client, 'call'>;

interface IdentityBinding {
  readonly textDigest: string;
  readonly idempotencyKey: string;
}

interface OperationControl {
  readonly controller: AbortController;
  abortCode: 'CANCELLED' | 'TIMEOUT';
  abortMessage: string;
}

export interface RuntimeClientTranscriptConsumerOptions {
  /** A connected public Client with negotiated task.submit and task.get capabilities. */
  readonly client: RuntimeTaskClient;
  readonly conversationId: string;
  readonly pollIntervalMs?: number;
}

function invalid(message = 'Invalid Runtime transcript consumer input'): never {
  throw new VoiceSessionError('INVALID_ARGUMENT', message);
}

function fixedExternalFailure(): VoiceSessionError {
  return new VoiceSessionError('EXTERNAL_FAILURE', 'Runtime transcript consumption failed');
}

function fixedUnavailable(): VoiceSessionError {
  return new VoiceSessionError('UNSUPPORTED_CAPABILITY', 'Runtime transcript consumption is unavailable');
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function dataProperty(value: unknown, key: string): unknown {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function validSignal(value: unknown): value is AbortSignal {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
  try {
    const signal = value as AbortSignal;
    return typeof signal.aborted === 'boolean'
      && typeof signal.addEventListener === 'function'
      && typeof signal.removeEventListener === 'function';
  } catch {
    return false;
  }
}

function parseDeadline(value: unknown): number {
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    invalid('Invalid Runtime transcript deadline');
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) invalid('Invalid Runtime transcript deadline');
  return parsed;
}

function abortError(control: OperationControl): VoiceSessionError {
  return new VoiceSessionError(control.abortCode, control.abortMessage);
}

function captureRequest(request: TranscriptConsumptionRequest): {
  readonly value: TranscriptConsumptionRequest;
  readonly deadlineMs: number;
} {
  if (!request || typeof request !== 'object') invalid();
  let sessionId: unknown;
  let transcriptId: unknown;
  let text: unknown;
  let locale: unknown;
  let deadline: unknown;
  let signal: unknown;
  try {
    ({sessionId, transcriptId, text, locale, deadline, signal} = request);
  } catch {
    invalid();
  }
  if (typeof sessionId !== 'string' || sessionId.length === 0) invalid();
  if (typeof transcriptId !== 'string' || transcriptId.length === 0) invalid();
  if (typeof text !== 'string'
    || text.trim().length === 0
    || text.length > MAX_TRANSCRIPT_CHARACTERS) invalid();
  if (typeof locale !== 'string' || locale.length === 0) invalid();
  if (!validSignal(signal)) invalid();
  const captured: TranscriptConsumptionRequest = Object.freeze({
    sessionId,
    transcriptId,
    text,
    locale,
    deadline: deadline as string,
    signal,
  });
  return {value: captured, deadlineMs: parseDeadline(deadline)};
}

/**
 * Trusted-host adapter from explicit transcript consumption to the connected
 * public Runtime Client. It never owns Runtime execution or task terminal state.
 */
export class RuntimeClientTranscriptConsumer implements TranscriptConsumerPort {
  private readonly client: RuntimeTaskClient;
  private readonly conversationId: string;
  private readonly pollIntervalMs: number;
  private readonly identities = new Map<string, IdentityBinding>();

  constructor(options: RuntimeClientTranscriptConsumerOptions) {
    if (!options || typeof options !== 'object'
      || !options.client
      || typeof options.client.call !== 'function'
      || typeof options.conversationId !== 'string'
      || options.conversationId.length === 0) invalid();
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0 || pollIntervalMs > MAX_TIMER_MS) invalid();
    this.client = options.client;
    this.conversationId = options.conversationId;
    this.pollIntervalMs = pollIntervalMs;
  }

  consume(request: TranscriptConsumptionRequest): VoiceOperation<TranscriptConsumptionResult> {
    const captured = captureRequest(request);
    const deadlineMs = captured.deadlineMs;
    const input = captured.value;
    const binding = this.bindIdentity(input);
    const control: OperationControl = {
      controller: new AbortController(),
      abortCode: 'CANCELLED',
      abortMessage: 'Runtime transcript wait cancelled',
    };
    let settled = false;
    const abort = (code: 'CANCELLED' | 'TIMEOUT', message: string): void => {
      if (settled || control.controller.signal.aborted) return;
      control.abortCode = code;
      control.abortMessage = message;
      control.controller.abort();
    };
    const onParentAbort = (): void => abort('CANCELLED', 'Runtime transcript wait cancelled');
    try {
      input.signal.addEventListener('abort', onParentAbort, {once: true});
    } catch {
      invalid();
    }
    if (input.signal.aborted) onParentAbort();

    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleDeadline = (): void => {
      const remaining = deadlineMs - Date.now();
      if (remaining <= 0) {
        abort('TIMEOUT', 'Runtime transcript deadline expired');
        return;
      }
      deadlineTimer = setTimeout(scheduleDeadline, Math.min(remaining, MAX_TIMER_MS));
    };
    scheduleDeadline();

    const result = Promise.resolve()
      .then(() => this.run(input, binding.idempotencyKey, deadlineMs, control))
      .finally(() => {
        settled = true;
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
        try { input.signal.removeEventListener('abort', onParentAbort); } catch { /* Best-effort detach. */ }
      });

    return {
      result,
      stop: async (reason: VoiceOperationStopReason): Promise<void> => {
        if (reason === 'deadline') abort('TIMEOUT', 'Runtime transcript deadline expired');
        else abort('CANCELLED', 'Runtime transcript wait cancelled');
        try { await result; } catch { /* Local release never surfaces task or transport errors. */ }
      },
    };
  }

  private bindIdentity(request: TranscriptConsumptionRequest): IdentityBinding {
    const identityDigest = digest(
      `${request.sessionId.length}:${request.sessionId}\u0000${request.transcriptId.length}:${request.transcriptId}`,
    );
    const textDigest = digest(request.text);
    const existing = this.identities.get(identityDigest);
    if (existing) {
      if (existing.textDigest !== textDigest) {
        throw new VoiceSessionError('INVALID_STATE', 'Runtime transcript identity input changed');
      }
      return existing;
    }
    if (this.identities.size >= MAX_TRACKED_IDENTITIES) {
      throw new VoiceSessionError('INVALID_STATE', 'Runtime transcript identity capacity reached');
    }
    const binding: IdentityBinding = Object.freeze({
      textDigest,
      idempotencyKey: `voice-transcript-v1-${identityDigest.slice(0, 40)}`,
    });
    this.identities.set(identityDigest, binding);
    return binding;
  }

  private async run(
    request: TranscriptConsumptionRequest,
    idempotencyKey: string,
    deadlineMs: number,
    control: OperationControl,
  ): Promise<TranscriptConsumptionResult> {
    this.assertActive(control, deadlineMs);
    const submitted = await this.awaitClientCall(
      () => this.client.call(
        'task.submit',
        {goal: request.text, conversationId: this.conversationId},
        this.callOptions(control, deadlineMs, idempotencyKey),
      ),
      control,
      deadlineMs,
    );
    if (!submitted || typeof submitted.taskId !== 'string' || submitted.taskId.length === 0) {
      throw fixedExternalFailure();
    }

    while (true) {
      this.assertActive(control, deadlineMs);
      const snapshot = await this.awaitClientCall(
        () => this.client.call(
          'task.get',
          {taskId: submitted.taskId},
          this.callOptions(control, deadlineMs),
        ),
        control,
        deadlineMs,
      );
      // A fulfilled call can win the race after same-turn cancellation or expiry.
      // Recheck before accepting the snapshot or publishing any reply.
      this.assertActive(control, deadlineMs);
      if (!snapshot || snapshot.taskId !== submitted.taskId) throw fixedExternalFailure();
      if (snapshot.state === 'succeeded') {
        if (typeof snapshot.resultSummary !== 'string' || snapshot.resultSummary.trim().length === 0) {
          throw fixedExternalFailure();
        }
        return {
          replyText: snapshot.resultSummary.slice(0, MAX_SPEECH_CHARACTERS),
          locale: request.locale,
        };
      }
      if (snapshot.state === 'failed' || snapshot.state === 'cancelled') throw fixedExternalFailure();
      if (snapshot.state !== 'created'
        && snapshot.state !== 'planning'
        && snapshot.state !== 'running'
        && snapshot.state !== 'waiting_approval'
        && snapshot.state !== 'waiting_external'
        && snapshot.state !== 'waiting_reconciliation'
        && snapshot.state !== 'verifying'
        && snapshot.state !== 'cancelling') throw fixedExternalFailure();
      await this.waitForNextQuery(control, deadlineMs);
    }
  }

  private callOptions(
    control: OperationControl,
    deadlineMs: number,
    idempotencyKey?: string,
  ): CallOptions {
    const timeoutMs = this.remainingTimeout(deadlineMs);
    return {
      signal: control.controller.signal,
      timeoutMs,
      ...(idempotencyKey === undefined ? {} : {idempotencyKey}),
    };
  }

  private remainingTimeout(deadlineMs: number): number {
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) throw new VoiceSessionError('TIMEOUT', 'Runtime transcript deadline expired');
    return Math.min(MAX_TIMER_MS, Math.max(1, Math.ceil(remaining)));
  }

  private assertActive(control: OperationControl, deadlineMs: number): void {
    if (control.controller.signal.aborted) throw abortError(control);
    if (deadlineMs <= Date.now()) {
      control.abortCode = 'TIMEOUT';
      control.abortMessage = 'Runtime transcript deadline expired';
      control.controller.abort();
      throw abortError(control);
    }
  }

  private async awaitClientCall<T>(
    start: () => Promise<T>,
    control: OperationControl,
    deadlineMs: number,
  ): Promise<T> {
    this.assertActive(control, deadlineMs);
    let rejectStopped: (error: VoiceSessionError) => void = () => {};
    const stopped = new Promise<never>((_, reject) => { rejectStopped = reject; });
    const onAbort = (): void => rejectStopped(abortError(control));
    control.controller.signal.addEventListener('abort', onAbort, {once: true});
    if (control.controller.signal.aborted) onAbort();
    let call: Promise<T>;
    try {
      call = Promise.resolve(start());
    } catch (error) {
      control.controller.signal.removeEventListener('abort', onAbort);
      throw this.normalizeClientError(error, control);
    }
    try {
      return await Promise.race([call, stopped]);
    } catch (error) {
      throw this.normalizeClientError(error, control);
    } finally {
      control.controller.signal.removeEventListener('abort', onAbort);
    }
  }

  private normalizeClientError(error: unknown, control: OperationControl): VoiceSessionError {
    if (control.controller.signal.aborted) return abortError(control);
    const code = dataProperty(error, 'code');
    if (code === 'TIMEOUT') return new VoiceSessionError('TIMEOUT', 'Runtime transcript deadline expired');
    if (code === 'UNSUPPORTED_CAPABILITY') return fixedUnavailable();
    return fixedExternalFailure();
  }

  private async waitForNextQuery(control: OperationControl, deadlineMs: number): Promise<void> {
    this.assertActive(control, deadlineMs);
    const delayMs = Math.min(this.pollIntervalMs, this.remainingTimeout(deadlineMs));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        control.controller.signal.removeEventListener('abort', onAbort);
        resolve();
      }, delayMs);
      const onAbort = (): void => {
        clearTimeout(timer);
        control.controller.signal.removeEventListener('abort', onAbort);
        reject(abortError(control));
      };
      control.controller.signal.addEventListener('abort', onAbort, {once: true});
      if (control.controller.signal.aborted) onAbort();
    });
  }
}

export function createRuntimeClientTranscriptConsumer(
  options: RuntimeClientTranscriptConsumerOptions,
): RuntimeClientTranscriptConsumer {
  return new RuntimeClientTranscriptConsumer(options);
}
