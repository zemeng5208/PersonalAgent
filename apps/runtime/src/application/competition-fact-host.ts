import {ProtocolError} from '@personal-agent/contracts';
import type {FactVersion, MemoryReadContext} from '@personal-agent/memory';
import {openSqliteMemoryHost} from '@personal-agent/memory/sqlite';
import {isAbsolute} from 'node:path';
import type {RuntimeApplication} from './runtime-application.js';
import {createSqliteFactProjectionHost} from './sqlite-fact-projection.js';
import type {SqliteFactProjectionHost} from './sqlite-fact-projection.js';

export interface CompetitionFactHostOptions {
  /** A separate, trusted host-owned SQLite file; never the Runtime database. */
  readonly memoryPath: string;
  readonly memoryNamespace: string;
  readonly graphNamespace: string;
  readonly consumerKey: string;
}

export interface PublicSourceKey {
  readonly vaultId: string;
  readonly path: string;
  readonly factId: string;
}

export interface TrustedPublicSource extends PublicSourceKey {
  /** SHA-256 revision obtained by independently reading the approved local source. */
  readonly sourceRevision: string;
  readonly line: number;
  readonly summary: string;
  readonly observedAt: string;
  readonly validFrom: string;
  readonly validUntil: string;
  readonly expectedFactRevision: number | null;
}

export interface TrustedPublicWithdrawal extends PublicSourceKey {
  readonly withdrawalId: string;
  readonly expectedFactRevision: number;
  readonly observedAt: string;
}

export interface CompetitionFactHost extends SqliteFactProjectionHost {
  readPublicSourceHead(key: PublicSourceKey): number | null;
  recordPublicSource(source: TrustedPublicSource, context: MemoryReadContext):
    {readonly fact: FactVersion; readonly appended: boolean};
  withdrawPublicSource(source: TrustedPublicWithdrawal, context: MemoryReadContext):
    {readonly fact: FactVersion; readonly appended: boolean};
  close(): void;
}

/** Trusted Competition composition. Only the host may assert a local source was read and checked. */
export function createCompetitionFactHost(
  application: RuntimeApplication, options: CompetitionFactHostOptions
): CompetitionFactHost {
  // Capture the host scope once; later caller config mutation cannot redirect
  // source reads or writes away from the already-bound projection.
  const {memoryPath, memoryNamespace, graphNamespace, consumerKey} = options;
  if (application.profile !== 'huawei_ict_agentarts'
    || !isAbsolute(memoryPath)
    || !memoryNamespace?.trim() || !graphNamespace?.trim() || !consumerKey?.trim()) {
    throw new ProtocolError('INVALID_ARGUMENT', 'Invalid Competition Fact host configuration');
  }
  const memory = openSqliteMemoryHost(memoryPath);
  let closed = false;
  const active = () => {
    if (closed) throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'Competition Fact host is closed');
  };
  try {
    memory.provision(memoryNamespace);
    const projection = createSqliteFactProjectionHost({memory, runtime: application.runtime,
      memoryNamespace, graphNamespace, consumerKey});
    return Object.freeze({
      readPublicSourceHead: (key: PublicSourceKey) => {
        active();
        return memory.readPublicSourceHead(memoryNamespace, key);
      },
      recordPublicSource: (source: TrustedPublicSource, context: MemoryReadContext) => {
        active();
        return memory.appendPublicSource(memoryNamespace,
          {...source, deadline: context.deadline, signal: context.signal});
      },
      withdrawPublicSource: (source: TrustedPublicWithdrawal, context: MemoryReadContext) => {
        active();
        return memory.withdrawPublicSource(memoryNamespace,
          {...source, deadline: context.deadline, signal: context.signal});
      },
      consume: (request: Parameters<SqliteFactProjectionHost['consume']>[0]) => {
        active();
        return projection.consume(request);
      },
      drain: (request: Parameters<SqliteFactProjectionHost['drain']>[0]) => {
        active();
        return projection.drain(request);
      },
      processImpacts: (request: Parameters<SqliteFactProjectionHost['processImpacts']>[0]) => {
        active();
        return projection.processImpacts(request);
      },
      readCompletedImpact: (batchToken: string) => {
        active();
        return projection.readCompletedImpact(batchToken);
      },
      listImpactReceipts: (request: Parameters<SqliteFactProjectionHost['listImpactReceipts']>[0]) => {
        active();
        return projection.listImpactReceipts(request);
      },
      close: () => {
        if (closed) return;
        closed = true;
        memory.close();
      },
    });
  } catch (error) {
    memory.close();
    throw error;
  }
}
