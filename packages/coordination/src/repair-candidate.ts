import {ProtocolError} from '@personal-agent/contracts';
import {parseCoordinationContinuation} from './index.js';

/** Provisional in-process candidate. Structurally matches StoredRepairRequest. */
export interface CoordinationRepairCandidateResult {
  kind: 'repair_candidate';
  candidateVersion: '1.0';
  candidate: {
    expectedGraphRevision: number;
    changes: {
      node: {id: string; revision: number};
      summary: string;
      reason: string;
      dependencies: {id: string; revision: number}[];
    }[];
  };
  verification: 'unverified';
}

function invalid(): never {
  throw new ProtocolError('INVALID_ARGUMENT', 'Invalid versioned repair candidate');
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid();
  return value as Record<string, unknown>;
}

function text(value: unknown, max: number): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max
    || /[\u0000-\u001f\u007f]/.test(value)) invalid();
}

function ref(value: unknown): {id: string; revision: number} {
  const item = object(value, ['id', 'revision']);
  text(item.id, 128);
  if (!Number.isSafeInteger(item.revision) || (item.revision as number) < 1) invalid();
  return {id: item.id, revision: item.revision as number};
}

/** Host verification is mandatory; the cloud adapter must reject a cloud-supplied label. */
export function parseCoordinationRepairCandidate(value: unknown): CoordinationRepairCandidateResult {
  // Reuse the existing getter-free, bounded-depth JSON clone, including symbols
  // and sparse-array rejection. No provider code runs during validation.
  const copy = parseCoordinationContinuation({proposalId: 'repair-candidate', state: 'confirmed', result: value}).result;
  if (Buffer.byteLength(JSON.stringify(copy), 'utf8') > 8192) invalid();
  const result = object(copy, ['kind', 'candidateVersion', 'candidate', 'verification']);
  if (result.kind !== 'repair_candidate' || result.candidateVersion !== '1.0'
    || result.verification !== 'unverified') invalid();
  const candidate = object(result.candidate, ['expectedGraphRevision', 'changes']);
  if (!Number.isSafeInteger(candidate.expectedGraphRevision) || (candidate.expectedGraphRevision as number) < 0
    || !Array.isArray(candidate.changes) || candidate.changes.length < 1 || candidate.changes.length > 16) invalid();
  const targets = new Set<string>();
  for (const raw of candidate.changes) {
    const change = object(raw, ['node', 'summary', 'reason', 'dependencies']);
    const node = ref(change.node);
    if (targets.has(node.id)) invalid();
    targets.add(node.id);
    text(change.summary, 1024);
    text(change.reason, 1024);
    if (!Array.isArray(change.dependencies) || change.dependencies.length > 16) invalid();
    const dependencies = new Set<string>();
    for (const rawDependency of change.dependencies) {
      const dependency = ref(rawDependency);
      if (dependency.id === node.id || dependencies.has(dependency.id)) invalid();
      dependencies.add(dependency.id);
    }
  }
  return copy as CoordinationRepairCandidateResult;
}
