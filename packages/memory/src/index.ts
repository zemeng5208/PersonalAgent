/** Provisional in-process fact query boundary. It is not a wire protocol. */
export * from './feed.js';
export type FactSensitivity = 'public' | 'private' | 'restricted';
export type FactState = 'active' | 'withdrawn';
export type FactConfirmation = 'external_observation' | 'model_inference' | 'user_confirmed';

export interface FactRef {
  id: string;
  revision: number;
}

export interface FactVersion {
  ref: FactRef;
  summary: string;
  sourceRef: string;
  observedAt: string;
  validFrom: string;
  validUntil: string;
  sensitivity: FactSensitivity;
  state: FactState;
  confirmation: FactConfirmation;
  corrects?: FactRef;
}

export interface MemoryReadContext {
  deadline: string;
  signal: AbortSignal;
}

export interface ListCurrentFactsRequest extends MemoryReadContext {
  at: string;
  limit: number;
  factId?: string;
  sourceRef?: string;
  snapshot?: string;
  cursor?: string;
}

export interface ListFactHistoryRequest extends MemoryReadContext {
  factId: string;
  limit: number;
  snapshot?: string;
  cursor?: string;
}

export interface GetFactVersionRequest extends MemoryReadContext {
  fact: FactRef;
}

export interface FactPage {
  snapshot: string;
  facts: FactVersion[];
  nextCursor?: string;
}

export interface MemoryQueryPort {
  listCurrent(request: ListCurrentFactsRequest): Promise<FactPage>;
  listHistory(request: ListFactHistoryRequest): Promise<FactPage>;
  getVersion(request: GetFactVersionRequest): Promise<FactVersion>;
}

export type MemoryQueryErrorCode =
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'REVISION_CONFLICT'
  | 'SCOPE_DENIED'
  | 'TIMEOUT'
  | 'CANCELLED';

const errorMessages: Readonly<Record<MemoryQueryErrorCode, string>> = Object.freeze({
  INVALID_ARGUMENT: 'Invalid memory query',
  NOT_FOUND: 'Memory namespace is unavailable',
  REVISION_CONFLICT: 'Memory source revision changed',
  SCOPE_DENIED: 'Memory fact is unavailable',
  TIMEOUT: 'Memory query deadline expired',
  CANCELLED: 'Memory query cancelled',
});

export class MemoryQueryError extends Error {
  constructor(readonly code: MemoryQueryErrorCode) {
    super(errorMessages[code]);
    this.name = 'MemoryQueryError';
  }
}

/**
 * Minimal public consumer proving that cognition can request one exact immutable
 * FactRef without importing a host, storage implementation or task scheduler.
 */
export async function readFactForImpact(
  memory: MemoryQueryPort,
  fact: FactRef,
  context: MemoryReadContext,
): Promise<FactVersion> {
  const requested = structuredClone(fact);
  const result = await memory.getVersion({
    fact: requested,
    deadline: context.deadline,
    signal: context.signal,
  });
  try {
    if (result.ref.id !== requested.id || result.ref.revision !== requested.revision) {
      throw new MemoryQueryError('INVALID_ARGUMENT');
    }
    return structuredClone(result);
  } catch (error) {
    if (error instanceof MemoryQueryError) throw error;
    throw new MemoryQueryError('INVALID_ARGUMENT');
  }
}
