import {MemoryQueryError, type FactRef, type FactVersion, type MemoryQueryPort, type MemoryReadContext} from './index.js';

export interface MemoryCitation extends FactVersion {
  readonly dataClass: 'confirmed_memory';
  readonly consumedAt: string;
  readonly destination: 'local' | 'cloud';
}
export interface MemoryUseRequest extends MemoryReadContext {
  readonly fact: FactRef;
  readonly destination: 'local' | 'cloud';
  readonly purpose: string;
}
export interface MemoryUseAuthorization {
  readonly allowed: boolean;
  /** Only a trusted user-consent port may assert this for private/restricted facts. */
  readonly sensitiveCloudConsent?: boolean;
}

/** Exact current-head read, then user authorization, then current-head recheck. No tokens or outbound API. */
export function createControlledMemoryReader(options: {
  readonly query: MemoryQueryPort;
  readonly authorize: (input: {fact: FactVersion; destination: 'local' | 'cloud'; purpose: string},
    context: MemoryReadContext) => Promise<MemoryUseAuthorization>;
  readonly now?: () => Date;
}): {read(request: MemoryUseRequest): Promise<MemoryCitation>} {
  const now = options.now ?? (() => new Date());
  const check = (request: MemoryReadContext): void => {
    if (request.signal?.aborted) throw new MemoryQueryError('CANCELLED');
    if (!Number.isFinite(Date.parse(request.deadline))) throw new MemoryQueryError('INVALID_ARGUMENT');
    if (Date.parse(request.deadline) <= now().getTime()) throw new MemoryQueryError('TIMEOUT');
  };
  return Object.freeze({async read(request: MemoryUseRequest): Promise<MemoryCitation> {
    const scope = {deadline: request.deadline, signal: request.signal};
    const ref = structuredClone(request.fact);
    const destination = request.destination;
    const purpose = request.purpose;
    if (!ref || typeof ref.id !== 'string' || !ref.id.trim()
      || !Number.isSafeInteger(ref.revision) || ref.revision < 1
      || !['local', 'cloud'].includes(destination) || typeof purpose !== 'string'
      || !purpose.trim() || purpose.length > 500) throw new MemoryQueryError('INVALID_ARGUMENT');
    const current = async (): Promise<FactVersion> => {
      check(scope);
      const at = now().toISOString();
      const page = await options.query.listCurrent({factId: ref.id, at, limit: 1, ...scope});
      check(scope);
      const fact = page.facts[0];
      if (!fact || fact.ref.id !== ref.id || fact.ref.revision !== ref.revision || fact.state !== 'active'
        || fact.confirmation !== 'user_confirmed' || Date.parse(fact.validFrom) > now().getTime()
        || Date.parse(fact.validUntil) <= now().getTime()) throw new MemoryQueryError('SCOPE_DENIED');
      return structuredClone(fact);
    };
    const before = await current();
    const decision = await options.authorize({fact: structuredClone(before), destination, purpose}, scope);
    check(scope);
    if (decision?.allowed !== true || destination === 'cloud' && before.sensitivity !== 'public'
      && decision.sensitiveCloudConsent !== true) throw new MemoryQueryError('SCOPE_DENIED');
    const after = await current();
    if (JSON.stringify(after) !== JSON.stringify(before)) throw new MemoryQueryError('REVISION_CONFLICT');
    return {...after, dataClass: 'confirmed_memory', consumedAt: now().toISOString(), destination};
  }});
}
