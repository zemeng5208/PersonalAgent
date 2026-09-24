/** Provisional, read-only contract. A trusted host binds one vault and scope. */
export interface KnowledgeSearchRequest {
  readonly query: string;
  readonly limit: number;
  readonly deadline: string;
  readonly signal: AbortSignal;
}

export interface KnowledgeSource {
  readonly vaultId: string;
  readonly path: string;
  readonly line: number;
  readonly revision: string;
}

export interface KnowledgeHit {
  readonly source: KnowledgeSource;
  readonly excerpt: string;
}

export interface KnowledgeSearchResult {
  readonly hits: readonly KnowledgeHit[];
  readonly truncated: boolean;
}

export interface KnowledgePort {
  search(request: KnowledgeSearchRequest): Promise<KnowledgeSearchResult>;
}

export class KnowledgeError extends Error {
  constructor(readonly code: 'INVALID_ARGUMENT' | 'CANCELLED' | 'TIMEOUT'
    | 'SCOPE_DENIED' | 'SOURCE_UNAVAILABLE' | 'SOURCE_CHANGED' | 'LIMIT_EXCEEDED') {
    super('Knowledge ' + code.toLowerCase());
    this.name = 'KnowledgeError';
  }
}
