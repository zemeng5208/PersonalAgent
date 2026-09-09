import {ProtocolError} from '@personal-agent/contracts';

/** In-process, provisional text-only boundary. No Runtime, credentials or history. */
export interface CoordinationRequest {
  readonly taskId: string;
  readonly revision: number;
  readonly goal: string;
  readonly deadline: string;
  readonly signal: AbortSignal;
}

export interface CoordinationTextResult {
  kind: 'text';
  text: string;
  verification: 'mock' | 'unverified';
}

export interface CoordinationPort {
  execute(request: CoordinationRequest): Promise<CoordinationTextResult>;
}

/** Adapter owns deployment/identity and must not perform external writes in this slice. */
export interface CloudAgentPort {
  invoke(request: CoordinationRequest): Promise<CoordinationTextResult>;
}

/** Runtime validates even typed adapters. Text is not execution evidence. */
export function parseCoordinationTextResult(value: unknown): CoordinationTextResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolError('INVALID_ARGUMENT', 'Invalid coordination result');
  }
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !['kind', 'text', 'verification'].includes(key))
    || result.kind !== 'text' || typeof result.text !== 'string'
    || result.text.trim().length === 0 || result.text.length > 16_000
    || !['mock', 'unverified'].includes(result.verification as string)) {
    throw new ProtocolError('INVALID_ARGUMENT', 'Expected bounded text without tool proposals, evidence or task state');
  }
  return {kind: 'text', text: result.text, verification: result.verification as CoordinationTextResult['verification']};
}
