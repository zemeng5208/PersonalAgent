import {KnowledgeError} from '@personal-agent/knowledge';
import type {ReadOnlyVaultPort} from '@personal-agent/knowledge/filesystem';
import type {MemoryReadContext} from '@personal-agent/memory';
import type {SqliteMemoryHost} from '@personal-agent/memory/sqlite';

/** Trusted, explicit public-demo import; not a registered Runtime capability. */
export async function ingestPublicSource(options: {
  readonly vault: ReadOnlyVaultPort;
  readonly memory: Pick<SqliteMemoryHost, 'readPublicSourceHead' | 'appendPublicSource'>;
  readonly namespace: string;
  readonly vaultId: string;
  readonly path: string;
  readonly factId: string;
  readonly query: string;
  readonly observedAt: string;
  readonly validFrom: string;
  readonly validUntil: string;
}, context: MemoryReadContext) {
  const key = {vaultId: options.vaultId, path: options.path, factId: options.factId};
  const expectedFactRevision = options.memory.readPublicSourceHead(options.namespace, key);
  const result = await options.vault.search({query: options.query, limit: 2, ...context});
  const hit = result.hits[0];
  if (result.truncated || result.hits.length !== 1 || !hit) {
    throw new KnowledgeError('SOURCE_UNAVAILABLE');
  }
  if (hit.source.vaultId !== key.vaultId || hit.source.path !== key.path) {
    throw new KnowledgeError('SOURCE_UNAVAILABLE');
  }
  const excerpt = await options.vault.readCitation({source: hit.source, ...context});
  if (excerpt !== hit.excerpt) throw new KnowledgeError('SOURCE_CHANGED');
  return options.memory.appendPublicSource(options.namespace, {
    ...key,
    sourceRevision: hit.source.revision,
    line: hit.source.line,
    summary: excerpt,
    observedAt: options.observedAt,
    validFrom: options.validFrom,
    validUntil: options.validUntil,
    expectedFactRevision,
    ...context,
  });
}
