import {ProtocolError} from '@personal-agent/contracts';

const textResultFields = ['kind', 'text', 'verification'] as const;

function hasExactEnumerableKeys(value: object, fields: readonly string[]): boolean {
  try {
    const keys = Reflect.ownKeys(value);
    return keys.length === fields.length
      && keys.every(key => typeof key === 'string' && fields.includes(key))
      && fields.every(field => Object.prototype.propertyIsEnumerable.call(value, field));
  } catch {
    return false;
  }
}

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

export {AgentArtsCloudAgentPort} from './agentarts.js';
export type {
  AgentArtsAuthorizationProvider,
  AgentArtsFetch,
  AgentArtsFetchInit,
  AgentArtsResponse,
  AgentArtsRuntimeConfig,
} from './agentarts.js';

/** Runtime validates even typed adapters. Text is not execution evidence. */
export function parseCoordinationTextResult(value: unknown): CoordinationTextResult {
  let array = false;
  try {
    array = Array.isArray(value);
  } catch {
    throw new ProtocolError('INVALID_ARGUMENT', 'Invalid coordination result');
  }
  if (value === null || typeof value !== 'object' || array) {
    throw new ProtocolError('INVALID_ARGUMENT', 'Invalid coordination result');
  }
  const result = value as Record<string, unknown>;
  if (!hasExactEnumerableKeys(result, textResultFields)) {
    throw new ProtocolError('INVALID_ARGUMENT', 'Expected bounded text without tool proposals, evidence or task state');
  }
  let kind: unknown;
  let text: unknown;
  let verification: unknown;
  try {
    kind = result.kind;
    text = result.text;
    verification = result.verification;
  } catch {
    // A provider-controlled getter/proxy must not leak its exception message.
    throw new ProtocolError('INVALID_ARGUMENT', 'Invalid coordination result');
  }
  if (kind !== 'text' || typeof text !== 'string'
    || text.trim().length === 0 || text.length > 16_000
    || !['mock', 'unverified'].includes(verification as string)) {
    throw new ProtocolError('INVALID_ARGUMENT', 'Expected bounded text without tool proposals, evidence or task state');
  }
  return {kind: 'text', text, verification: verification as CoordinationTextResult['verification']};
}

export {CompetitionCoordinator, UnavailableCloudAgentPort} from './coordinator.js';
