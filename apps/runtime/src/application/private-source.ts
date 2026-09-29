import {KnowledgeError, type KnowledgeSource} from '@personal-agent/knowledge';
import type {ReadOnlyVaultPort} from '@personal-agent/knowledge/filesystem';
import type {MemoryReadContext} from '@personal-agent/memory';
import type {SqliteMemoryHost} from '@personal-agent/memory/sqlite';

export interface ConfirmedPrivateFact {
  readonly operationId: string;
  readonly summary: string;
}

/** Trusted host only; the callback must obtain a real user decision for this exact citation. */
export async function ingestConfirmedPrivateCitation(options: {
  readonly vault: ReadOnlyVaultPort;
  readonly memory: Pick<SqliteMemoryHost, 'createUserFact' | 'reviseUserFact'>;
  readonly namespace: string;
  readonly factId: string;
  readonly expectedRevision: number | null;
  readonly source: KnowledgeSource;
  readonly observedAt: string;
  readonly validFrom: string;
  readonly validUntil: string;
  readonly confirm: (citation: string) => Promise<ConfirmedPrivateFact | null>;
}, context: MemoryReadContext) {
  const citation = await options.vault.readCitation({source: options.source, ...context});
  const decision = await options.confirm(citation);
  if (decision === null) return null;
  if (await options.vault.readCitation({source: options.source, ...context}) !== citation) {
    throw new KnowledgeError('SOURCE_CHANGED');
  }
  const sourceRef = `${options.source.vaultId}/${options.source.path}`
    + `#L${options.source.line}@${options.source.revision}`;
  const fields = {factId: options.factId, operationId: decision.operationId,
    summary: decision.summary, sourceRef, observedAt: options.observedAt,
    validFrom: options.validFrom, validUntil: options.validUntil, ...context};
  return options.expectedRevision === null
    ? options.memory.createUserFact(options.namespace, fields)
    : options.memory.reviseUserFact(options.namespace,
      {...fields, expectedRevision: options.expectedRevision, sensitivity: 'private', state: 'active'});
}
