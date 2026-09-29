import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, renameSync, readdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {
  currentNodes,
  isEffective,
  type GraphSnapshot,
  type NodeRef,
  type NodeInput,
  type NodeVersion,
} from '@personal-agent/goals';
import {
  appendVersions,
  type AtomicCoordinationStorePort,
  type CoordinationStorePort,
} from '@personal-agent/goals/store';
import {analyzeImpact, CognitionError, type ImpactReport} from './impact.js';
import {
  LayaActionChoiceService,
  actionArgumentsDigest,
  type LayaActionCandidate,
  type LayaActionChoiceRequest,
  type LayaActionSelection,
} from './laya-action-choice.js';
import type {LayaInferencePort} from './laya-decision.js';

export interface MeetingActionChoicePort {
  choose(request: LayaActionChoiceRequest): Promise<LayaActionSelection>;
}

export interface MeetingRescheduleEvent {
  readonly eventId: string;
  readonly source: string;
  readonly meetingFactId: string;
  readonly originalSummary: string;
  readonly newSummary: string;
  readonly sourceRevision: string;
  readonly expectedBaseRevision?: string | undefined;
  readonly detectedAt: string;
  readonly deadline: string;
  readonly signal: AbortSignal;
}

export interface MeetingCandidate {
  readonly candidateId: string;
  readonly actionId: 'adjust_schedule' | 'defer_and_verify' | 'escalate_conflict';
  readonly description: string;
  readonly risk: 'low' | 'high';
  readonly reason: string;
  readonly proposedModifications?: readonly NodeInput[] | undefined;
}

export interface MeetingDecisionReceipt {
  readonly eventId: string;
  readonly source: string;
  readonly sourceRevision: string;
  readonly meetingFactId: string;
  readonly selectedCandidateId: string;
  readonly actionId: string;
  readonly status: 'applied' | 'proposal' | 'requires_review' | 'deferred' | 'already_processed' | 'conflict';
  readonly confidence: number | null;
  readonly reason: string;
  readonly graphRevisionBefore: number;
  readonly graphRevisionAfter: number;
  readonly evaluatedAt: string;
  readonly appliedNodeRevisions?: readonly NodeRef[] | undefined;
  readonly selection?: LayaActionSelection | undefined;
  readonly proposedModifications?: readonly NodeInput[] | undefined;
}

export interface MeetingReceiptRecord {
  readonly eventId: string;
  readonly namespace: string;
  readonly source: string;
  readonly sourceRevision: string;
  readonly inputDigest: string;
  readonly status: MeetingDecisionReceipt['status'];
  readonly receipt: MeetingDecisionReceipt;
  readonly updatedAt: string;
}

export interface MeetingReceiptQuery {
  readonly eventId: string;
  readonly namespace?: string | undefined;
  readonly source?: string | undefined;
}

export interface MeetingDecisionReceiptStorePort {
  loadReceipt(query: string | MeetingReceiptQuery): MeetingReceiptRecord | undefined | Promise<MeetingReceiptRecord | undefined>;
  saveReceipt(record: MeetingReceiptRecord): void | Promise<void>;
  listReceipts?(filter?: { readonly status?: string; readonly namespace?: string; readonly source?: string }): MeetingReceiptRecord[] | Promise<MeetingReceiptRecord[]>;
}

export class InMemoryMeetingDecisionReceiptStore implements MeetingDecisionReceiptStorePort {
  private readonly records = new Map<string, MeetingReceiptRecord>();

  private makeKey(namespace: string, source: string, eventId: string): string {
    return `${namespace}::${source}::${eventId}`;
  }

  loadReceipt(query: string | MeetingReceiptQuery): MeetingReceiptRecord | undefined {
    if (typeof query === 'string') {
      for (const record of this.records.values()) {
        if (record.eventId === query) return structuredClone(record);
      }
      return undefined;
    }
    if (query.namespace && query.source) {
      const key = this.makeKey(query.namespace, query.source, query.eventId);
      const record = this.records.get(key);
      return record ? structuredClone(record) : undefined;
    }
    for (const record of this.records.values()) {
      if (record.eventId === query.eventId) {
        if (query.namespace && record.namespace !== query.namespace) continue;
        if (query.source && record.source !== query.source) continue;
        return structuredClone(record);
      }
    }
    return undefined;
  }

  saveReceipt(record: MeetingReceiptRecord): void {
    const key = this.makeKey(record.namespace, record.source, record.eventId);
    this.records.set(key, structuredClone(record));
  }

  listReceipts(filter?: { readonly status?: string; readonly namespace?: string; readonly source?: string }): MeetingReceiptRecord[] {
    const results: MeetingReceiptRecord[] = [];
    for (const record of this.records.values()) {
      if (filter?.namespace && record.namespace !== filter.namespace) continue;
      if (filter?.source && record.source !== filter.source) continue;
      if (filter?.status && record.status !== filter.status) continue;
      results.push(structuredClone(record));
    }
    return results;
  }
}

export interface FileMeetingDecisionReceiptStoreOptions {
  readonly storageDir: string;
}

export class FileMeetingDecisionReceiptStore implements MeetingDecisionReceiptStorePort {
  private readonly storageDir: string;

  constructor(options: FileMeetingDecisionReceiptStoreOptions) {
    if (!options || typeof options.storageDir !== 'string' || !options.storageDir.trim()) {
      throw new CognitionError('INVALID_ARGUMENT');
    }
    this.storageDir = path.resolve(options.storageDir);
    mkdirSync(this.storageDir, { recursive: true });
  }

  private makeKey(namespace: string, source: string, eventId: string): string {
    return hash(`${namespace}::${source}::${eventId}`);
  }

  private getFilePath(namespace: string, source: string, eventId: string): string {
    return path.join(this.storageDir, `receipt-${this.makeKey(namespace, source, eventId)}.json`);
  }

  loadReceipt(query: string | MeetingReceiptQuery): MeetingReceiptRecord | undefined {
    if (typeof query === 'object' && query.namespace && query.source) {
      const file = this.getFilePath(query.namespace, query.source, query.eventId);
      if (!existsSync(file)) return undefined;
      try {
        const raw = readFileSync(file, 'utf8');
        return JSON.parse(raw) as MeetingReceiptRecord;
      } catch (err) {
        throw new Error(`Receipt file corrupt or unreadable (${file}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const targetEventId = typeof query === 'string' ? query : query.eventId;
    let files: string[];
    try {
      files = readdirSync(this.storageDir).filter(f => f.startsWith('receipt-') && f.endsWith('.json'));
    } catch (err) {
      throw new Error(`Failed to read receipt storage directory (${this.storageDir}): ${err instanceof Error ? err.message : String(err)}`);
    }
    for (const f of files) {
      const fullPath = path.join(this.storageDir, f);
      let record: MeetingReceiptRecord;
      try {
        record = JSON.parse(readFileSync(fullPath, 'utf8')) as MeetingReceiptRecord;
      } catch (err) {
        throw new Error(`Corrupted receipt file detected (${fullPath}): ${err instanceof Error ? err.message : String(err)}`);
      }
      if (record && record.eventId === targetEventId) {
        if (typeof query === 'object') {
          if (query.namespace && record.namespace !== query.namespace) continue;
          if (query.source && record.source !== query.source) continue;
        }
        return record;
      }
    }
    return undefined;
  }

  saveReceipt(record: MeetingReceiptRecord): void {
    const file = this.getFilePath(record.namespace, record.source, record.eventId);
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
    renameSync(tmp, file);
  }

  listReceipts(filter?: { readonly status?: string; readonly namespace?: string; readonly source?: string }): MeetingReceiptRecord[] {
    let files: string[];
    try {
      files = readdirSync(this.storageDir).filter(f => f.startsWith('receipt-') && f.endsWith('.json'));
    } catch {
      return [];
    }
    const results: MeetingReceiptRecord[] = [];
    for (const f of files) {
      try {
        const fullPath = path.join(this.storageDir, f);
        const record = JSON.parse(readFileSync(fullPath, 'utf8')) as MeetingReceiptRecord;
        if (!record) continue;
        if (filter?.namespace && record.namespace !== filter.namespace) continue;
        if (filter?.source && record.source !== filter.source) continue;
        if (filter?.status && record.status !== filter.status) continue;
        results.push(record);
      } catch {}
    }
    return results;
  }
}

export interface MeetingPlanExecutionPort {
  executeBatch(request: {
    readonly expectedRevision: number;
    readonly inputs: readonly NodeInput[];
    readonly eventId: string;
    readonly source: string;
    readonly sourceRevision: string;
    readonly deadline?: string | undefined;
    readonly signal?: AbortSignal | undefined;
  }): Promise<{
    readonly applied: boolean;
    readonly snapshot: GraphSnapshot;
    readonly error?: string | undefined;
    readonly notificationError?: string | undefined;
  }>;
}

export function createStoreExecutionPort(store: AtomicCoordinationStorePort): MeetingPlanExecutionPort {
  return {
    async executeBatch(request) {
      try {
        const next = store.appendBatch(request.expectedRevision, request.inputs);
        return { applied: true, snapshot: next };
      } catch (err) {
        return { applied: false, snapshot: store.read(), error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

export interface MeetingExecutionPolicyPort {
  evaluateExecution(request: {
    readonly eventId: string;
    readonly source: string;
    readonly inputs: readonly NodeInput[];
    readonly risk: 'low' | 'high';
  }): Promise<{ readonly allowed: boolean; readonly reason?: string }> | { readonly allowed: boolean; readonly reason?: string };
}

export interface PolicyGuardedExecutionPortOptions {
  readonly store: AtomicCoordinationStorePort;
  readonly policy: MeetingExecutionPolicyPort;
  readonly receiptStore?: MeetingDecisionReceiptStorePort | undefined;
  readonly namespace?: string | undefined;
  readonly onExecuted?: ((snapshot: GraphSnapshot) => void) | undefined;
}

export function createPolicyGuardedExecutionPort(options: PolicyGuardedExecutionPortOptions): MeetingPlanExecutionPort {
  if (!options || !options.store || typeof options.store.appendBatch !== 'function'
    || !options.policy || typeof options.policy.evaluateExecution !== 'function') {
    throw new CognitionError('INVALID_ARGUMENT');
  }
  return {
    async executeBatch(request) {
      if (request.signal?.aborted) {
        return { applied: false, snapshot: options.store.read(), error: '执行前已取消' };
      }
      if (request.deadline !== undefined) {
        const parsed = Date.parse(request.deadline);
        if (!Number.isFinite(parsed) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(request.deadline)) {
          return { applied: false, snapshot: options.store.read(), error: '非法截止时间' };
        }
        if (Date.now() >= parsed) {
          return { applied: false, snapshot: options.store.read(), error: '执行已超过截止时间' };
        }
      }

      const policyDecision = await options.policy.evaluateExecution({
        eventId: request.eventId,
        source: request.source,
        inputs: request.inputs,
        risk: 'low',
      });
      if (!policyDecision.allowed) {
        return { applied: false, snapshot: options.store.read(), error: `Policy 拒绝执行: ${policyDecision.reason ?? '未获授权'}` };
      }

      // Re-verify cancellation and deadline after asynchronous policy evaluation
      if (request.signal?.aborted) {
        return { applied: false, snapshot: options.store.read(), error: '执行前已取消（异步授权后中止）' };
      }
      if (request.deadline !== undefined) {
        const parsed = Date.parse(request.deadline);
        if (Date.now() >= parsed) {
          return { applied: false, snapshot: options.store.read(), error: '执行已超过截止时间（异步授权后超时）' };
        }
      }

      let next: GraphSnapshot;
      try {
        next = options.store.appendBatch(request.expectedRevision, request.inputs);
      } catch (err) {
        if (options.receiptStore) {
          try {
            const record = await options.receiptStore.loadReceipt({
              eventId: request.eventId,
              source: request.source,
              namespace: options.namespace,
            });
            if (record && record.status === 'applied' && record.sourceRevision === request.sourceRevision) {
              return { applied: true, snapshot: options.store.read() };
            }
          } catch {}
        }
        return { applied: false, snapshot: options.store.read(), error: err instanceof Error ? err.message : String(err) };
      }

      let notificationError: string | undefined;
      try {
        options.onExecuted?.(next);
      } catch (notifyErr) {
        notificationError = notifyErr instanceof Error ? notifyErr.message : String(notifyErr);
      }
      return {
        applied: true,
        snapshot: next,
        ...(notificationError ? { notificationError } : {}),
      };
    },
  };
}

export interface MeetingCoordinatorOptions {
  readonly store: CoordinationStorePort | AtomicCoordinationStorePort;
  readonly inference?: LayaInferencePort | undefined;
  readonly chooser?: MeetingActionChoicePort | undefined;
  readonly executionPort?: MeetingPlanExecutionPort | undefined;
  readonly receiptStore?: MeetingDecisionReceiptStorePort | undefined;
  readonly namespace?: string | undefined;
  readonly now?: (() => number) | undefined;
}

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

/**
 * End-to-end meeting reschedule decision coordinator.
 * Consumes meeting change facts, evaluates real graph impact without premature mutation,
 * presents multiple candidates to local Laya without self-signing authorizations,
 * and commits via a single atomic CAS batch through a trusted execution port if provided.
 */
export class MeetingRescheduleCoordinator {
  private readonly store: CoordinationStorePort;
  private readonly choiceService: MeetingActionChoicePort;
  private readonly executionPort?: MeetingPlanExecutionPort | undefined;
  private readonly receiptStore: MeetingDecisionReceiptStorePort;
  private readonly namespace: string;
  private readonly now: () => number;

  constructor(options: MeetingCoordinatorOptions) {
    if (!options || !options.store || typeof options.store.read !== 'function' || (!options.inference && !options.chooser)) {
      throw new CognitionError('INVALID_ARGUMENT');
    }
    this.store = options.store;
    this.choiceService = options.chooser ?? new LayaActionChoiceService(options.inference!);
    this.executionPort = options.executionPort;
    this.receiptStore = options.receiptStore ?? new InMemoryMeetingDecisionReceiptStore();
    this.namespace = options.namespace ?? 'default';
    this.now = options.now ?? Date.now;
  }

  /** Readback existing processed decision by event ID from durable receipt store. */
  async getReceipt(eventId: string, source?: string): Promise<MeetingDecisionReceipt | undefined> {
    const record = await this.receiptStore.loadReceipt({
      eventId,
      namespace: this.namespace,
      ...(source ? {source} : {}),
    });
    return record?.receipt;
  }

  /** List receipts by optional status or source from receipt store. */
  async listReceipts(filter?: { readonly status?: string; readonly source?: string }): Promise<readonly MeetingReceiptRecord[]> {
    if (typeof this.receiptStore.listReceipts === 'function') {
      return this.receiptStore.listReceipts({
        namespace: this.namespace,
        ...(filter?.source ? { source: filter.source } : {}),
        ...(filter?.status ? { status: filter.status } : {}),
      });
    }
    return [];
  }

  /**
   * Applies an approved proposal or requires_review receipt once authorization is granted.
   * Transitions receipt state from proposal/requires_review -> applied.
   */
  async applyApprovedProposal(
    query: { readonly eventId: string; readonly source: string; readonly namespace?: string | undefined },
    options: {
      readonly executionPort?: MeetingPlanExecutionPort | undefined;
      readonly deadline?: string | undefined;
      readonly signal?: AbortSignal | undefined;
    } = {}
  ): Promise<MeetingDecisionReceipt> {
    if (!query || !query.eventId || !query.source) throw new CognitionError('INVALID_ARGUMENT');
    if (options.signal?.aborted) throw new CognitionError('INVALID_ARGUMENT');
    if (options.deadline && this.now() >= Date.parse(options.deadline)) throw new CognitionError('INVALID_ARGUMENT');

    const ns = query.namespace ?? this.namespace;
    const record = await this.receiptStore.loadReceipt({ eventId: query.eventId, namespace: ns, source: query.source });
    if (!record) throw new CognitionError('NOT_APPLICABLE');

    if (record.receipt.status === 'applied') {
      return record.receipt;
    }
    if (record.receipt.status !== 'proposal' && record.receipt.status !== 'requires_review') {
      throw new CognitionError('NOT_APPLICABLE');
    }
    if (!record.receipt.proposedModifications || record.receipt.proposedModifications.length === 0) {
      throw new CognitionError('NOT_APPLICABLE');
    }

    const execPort = options.executionPort ?? this.executionPort;
    if (!execPort) throw new CognitionError('NOT_APPLICABLE');

    const currentGraph = this.store.read();
    const execResult = await execPort.executeBatch({
      expectedRevision: currentGraph.revision,
      inputs: record.receipt.proposedModifications,
      eventId: query.eventId,
      source: query.source,
      sourceRevision: record.receipt.sourceRevision,
      deadline: options.deadline,
      signal: options.signal,
    });

    if (execResult.applied) {
      const finalGraph = this.store.read();
      const appliedRevisions: NodeRef[] = record.receipt.proposedModifications.map(item => ({
        id: item.id,
        revision: finalGraph.history.findLast(n => n.id === item.id)!.revision,
      }));

      const appliedReceipt: MeetingDecisionReceipt = {
        ...record.receipt,
        status: 'applied',
        reason: '方案获批并经由受信执行端口完成原子批提交',
        graphRevisionBefore: currentGraph.revision,
        graphRevisionAfter: finalGraph.revision,
        appliedNodeRevisions: appliedRevisions,
        evaluatedAt: new Date(this.now()).toISOString(),
      };

      await this.receiptStore.saveReceipt({
        ...record,
        status: 'applied',
        receipt: appliedReceipt,
        updatedAt: new Date(this.now()).toISOString(),
      });

      return appliedReceipt;
    } else {
      const failedReceipt: MeetingDecisionReceipt = {
        ...record.receipt,
        status: 'requires_review',
        reason: `授权执行提交失败: ${execResult.error ?? '未知错误'}`,
        evaluatedAt: new Date(this.now()).toISOString(),
      };
      await this.receiptStore.saveReceipt({
        ...record,
        status: 'requires_review',
        receipt: failedReceipt,
        updatedAt: new Date(this.now()).toISOString(),
      });
      return failedReceipt;
    }
  }

  /**
   * Main vertical execution:
   * 1. Replay and conflict detection via durable receipt store (isolated by namespace, source, eventId)
   * 2. Crash window recovery: checks if graph was committed in prior crash before receipt save
   * 3. Opaque baseline revision verification
   * 4. Pure in-memory preflight of prospective fact update & impact analysis
   * 5. Kahn topological ordering for affected graph dependencies
   * 6. Multi-candidate selection via LayaActionChoiceService (no self-signed authorization)
   * 7. Execution through trusted port via atomic appendBatch or emission of proposal
   */
  async processEvent(event: MeetingRescheduleEvent): Promise<MeetingDecisionReceipt> {
    if (!event || typeof event.eventId !== 'string' || !event.eventId.trim()
      || typeof event.meetingFactId !== 'string' || !event.meetingFactId.trim()
      || typeof event.newSummary !== 'string' || !event.newSummary.trim()
      || typeof event.sourceRevision !== 'string' || !event.sourceRevision.trim()
      || !(event.signal instanceof AbortSignal) || !Number.isFinite(Date.parse(event.deadline))) {
      throw new CognitionError('INVALID_ARGUMENT');
    }
    if (event.signal.aborted) throw new CognitionError('INVALID_ARGUMENT');
    if (this.now() >= Date.parse(event.deadline)) throw new CognitionError('INVALID_ARGUMENT');

    const inputDigest = hash(JSON.stringify({
      eventId: event.eventId,
      source: event.source,
      meetingFactId: event.meetingFactId,
      originalSummary: event.originalSummary,
      newSummary: event.newSummary,
      sourceRevision: event.sourceRevision,
    }));

    // 1. Replay and conflict protection with source/namespace isolation
    const existingRecord = await this.receiptStore.loadReceipt({
      eventId: event.eventId,
      namespace: this.namespace,
      source: event.source,
    });
    if (existingRecord) {
      if (existingRecord.inputDigest === inputDigest) {
        if (existingRecord.receipt.status === 'applied') {
          return {...existingRecord.receipt, status: 'already_processed'};
        }
        return {...existingRecord.receipt};
      }
      // Same event ID from same source with different content or revision is an explicit conflict
      const conflictReceipt: MeetingDecisionReceipt = {
        eventId: event.eventId,
        source: event.source,
        sourceRevision: event.sourceRevision,
        meetingFactId: event.meetingFactId,
        selectedCandidateId: 'cand-conflict',
        actionId: 'conflict',
        status: 'conflict',
        confidence: null,
        reason: '相同 eventId 包含冲突的输入内容或源版本',
        graphRevisionBefore: this.store.read().revision,
        graphRevisionAfter: this.store.read().revision,
        evaluatedAt: event.detectedAt,
      };
      return conflictReceipt;
    }

    const initialSnapshot = this.store.read();
    const graphRevisionBefore = initialSnapshot.revision;

    // 2. Crash window recovery: check if graph was already updated with this exact event in a prior crash
    const alreadyCommittedFact = initialSnapshot.history.findLast(
      node => node.id === event.meetingFactId
        && node.kind === 'fact'
        && node.sourceRef === event.source
        && node.summary === event.newSummary
        && node.reason?.includes(`[eventId: ${event.eventId}]`)
        && node.reason?.includes(`[sourceRevision: ${event.sourceRevision}]`)
    );
    if (alreadyCommittedFact) {
      const committedNodes = initialSnapshot.history.filter(
        node => node.reason?.includes(`[eventId: ${event.eventId}]`)
          && node.reason?.includes(`[sourceRevision: ${event.sourceRevision}]`)
      );
      const recoveredReceipt: MeetingDecisionReceipt = {
        eventId: event.eventId,
        source: event.source,
        sourceRevision: event.sourceRevision,
        meetingFactId: event.meetingFactId,
        selectedCandidateId: 'cand-adjust-schedule',
        actionId: 'adjust_schedule',
        status: 'already_processed',
        confidence: 1.0,
        reason: '图谱已在历史事务中持久化该改期事件（崩溃恢复去重保护）',
        graphRevisionBefore: initialSnapshot.revision - 1,
        graphRevisionAfter: initialSnapshot.revision,
        evaluatedAt: event.detectedAt,
        appliedNodeRevisions: committedNodes.map(n => ({ id: n.id, revision: n.revision })),
      };
      await this.saveReceiptRecord(event, inputDigest, recoveredReceipt);
      return recoveredReceipt;
    }

    // Locate the current meeting node in graph
    const currentMeetingFact = initialSnapshot.history.findLast(
      node => node.id === event.meetingFactId && node.kind === 'fact'
    );
    if (!currentMeetingFact) {
      throw new CognitionError('NOT_APPLICABLE');
    }

    // 3. Baseline revision contract check
    if (event.expectedBaseRevision !== undefined) {
      const match = /\[sourceRevision:\s*([^\]]+)\]/.exec(currentMeetingFact.reason ?? '');
      const recordedRevision = match ? match[1]!.trim() : undefined;
      if (recordedRevision && recordedRevision !== event.expectedBaseRevision) {
        const baselineConflictReceipt: MeetingDecisionReceipt = {
          eventId: event.eventId,
          source: event.source,
          sourceRevision: event.sourceRevision,
          meetingFactId: event.meetingFactId,
          selectedCandidateId: 'cand-conflict',
          actionId: 'conflict',
          status: 'conflict',
          confidence: null,
          reason: `源事实基线版本不匹配: 期望基线 ${event.expectedBaseRevision}，当前图谱基线 ${recordedRevision}`,
          graphRevisionBefore,
          graphRevisionAfter: initialSnapshot.revision,
          evaluatedAt: event.detectedAt,
        };
        await this.saveReceiptRecord(event, inputDigest, baselineConflictReceipt);
        return baselineConflictReceipt;
      }
    }

    // 4. Pure in-memory preflight of updated fact (DO NOT mutate store yet)
    const updatedFactInput: NodeInput = {
      id: event.meetingFactId,
      kind: 'fact',
      summary: event.newSummary,
      sourceRef: event.source,
      sensitivity: currentMeetingFact.sensitivity,
      state: 'active',
      validFrom: currentMeetingFact.validFrom,
      validUntil: currentMeetingFact.validUntil,
      reason: `外部会议改期通知 [eventId: ${event.eventId}] [sourceRevision: ${event.sourceRevision}]`,
      dependencies: [],
    };

    let prospectiveGraph: GraphSnapshot;
    try {
      prospectiveGraph = appendVersions(initialSnapshot, initialSnapshot.revision, [updatedFactInput]);
    } catch {
      throw new CognitionError('REVISION_CONFLICT');
    }

    const prospectiveFact = prospectiveGraph.history.findLast(
      node => node.id === event.meetingFactId && node.kind === 'fact'
    )!;

    // 5. Impact analysis on prospective graph
    const impactReport = analyzeImpact(prospectiveGraph, event.detectedAt);
    const recheckItems = impactReport.items.filter(item => item.action === 'RECHECK');

    // 6. Generate candidates with topological dependency preservation
    const candidates = this.buildCandidates(prospectiveGraph, prospectiveFact, recheckItems, event);

    // Map to LayaActionCandidate (NO self-signed authorization)
    const actionCandidates: readonly LayaActionCandidate[] = candidates.map(cand => {
      const emptyDigest = actionArgumentsDigest({});
      return {
        id: cand.candidateId,
        revision: 1,
        kind: cand.actionId === 'escalate_conflict' ? 'escalate' : 'defer',
        description: cand.description,
        sources: [{id: prospectiveFact.id, revision: prospectiveFact.revision}],
        scopeRef: `meeting:${cand.actionId}`,
        expiresAt: event.deadline,
        risk: cand.risk,
        argumentsDigest: emptyDigest,
      };
    });

    // 7. Ask Laya to choose between the candidates
    const contextDescription = `会议事实更新：${event.originalSummary} -> ${event.newSummary}。受影响依赖项数：${recheckItems.length}。请在以下备选应对方案中决策。`;
    let selection: LayaActionSelection;
    try {
      selection = await this.choiceService.choose({
        context: contextDescription,
        candidates: actionCandidates,
        deadline: event.deadline,
        signal: event.signal,
      });
    } catch (error) {
      // Model failure or timeout leads to graceful review state without mutating graph
      const fallbackReceipt: MeetingDecisionReceipt = {
        eventId: event.eventId,
        source: event.source,
        sourceRevision: event.sourceRevision,
        meetingFactId: event.meetingFactId,
        selectedCandidateId: 'cand-review-fallback',
        actionId: 'escalate_conflict',
        status: 'requires_review',
        confidence: null,
        reason: error instanceof Error ? error.message : 'Laya 模型推理异常，降级等待人工确认',
        graphRevisionBefore,
        graphRevisionAfter: initialSnapshot.revision,
        evaluatedAt: event.detectedAt,
      };
      await this.saveReceiptRecord(event, inputDigest, fallbackReceipt);
      return fallbackReceipt;
    }

    // 8. Handle chosen action
    let receipt: MeetingDecisionReceipt;
    const selectedCandidate = candidates.find(c => c.candidateId === selection.selected?.id);

    if (selection.state === 'selected' && selectedCandidate && selectedCandidate.risk === 'low'
      && selectedCandidate.actionId === 'adjust_schedule' && selectedCandidate.proposedModifications) {
      const fullBatch: NodeInput[] = [updatedFactInput, ...selectedCandidate.proposedModifications];

      if (this.executionPort) {
        if (event.signal.aborted || this.now() >= Date.parse(event.deadline)) {
          throw new CognitionError('INVALID_ARGUMENT');
        }
        // Execute via trusted execution port with deadline and signal
        const execResult = await this.executionPort.executeBatch({
          expectedRevision: initialSnapshot.revision,
          inputs: fullBatch,
          eventId: event.eventId,
          source: event.source,
          sourceRevision: event.sourceRevision,
          deadline: event.deadline,
          signal: event.signal,
        });

        if (execResult.applied) {
          const finalGraph = this.store.read();
          const finalImpact = analyzeImpact(finalGraph, event.detectedAt);
          const remainingRechecks = finalImpact.items.filter(i => i.action === 'RECHECK'
            && selectedCandidate.proposedModifications!.some(m => m.id === i.node.id));

          const appliedRevisions: NodeRef[] = fullBatch.map(item => ({
            id: item.id,
            revision: finalGraph.history.findLast(n => n.id === item.id)!.revision,
          }));

          receipt = {
            eventId: event.eventId,
            source: event.source,
            sourceRevision: event.sourceRevision,
            meetingFactId: event.meetingFactId,
            selectedCandidateId: selectedCandidate.candidateId,
            actionId: selectedCandidate.actionId,
            status: remainingRechecks.length === 0 ? 'applied' : 'requires_review',
            confidence: selection.answerConfidence ?? null,
            reason: `Laya 选定调整方案并经由受信执行端口完成原子批提交；后验校验已${remainingRechecks.length === 0 ? '完全解决' : '有部分需进一步复核'}`,
            graphRevisionBefore,
            graphRevisionAfter: finalGraph.revision,
            evaluatedAt: event.detectedAt,
            appliedNodeRevisions: appliedRevisions,
            selection,
          };
        } else {
          receipt = {
            eventId: event.eventId,
            source: event.source,
            sourceRevision: event.sourceRevision,
            meetingFactId: event.meetingFactId,
            selectedCandidateId: selectedCandidate.candidateId,
            actionId: selectedCandidate.actionId,
            status: 'requires_review',
            confidence: selection.answerConfidence ?? null,
            reason: `执行端口提交失败: ${execResult.error ?? '未知错误'}`,
            graphRevisionBefore,
            graphRevisionAfter: initialSnapshot.revision,
            evaluatedAt: event.detectedAt,
            selection,
          };
        }
      } else {
        // No execution port: cognition layer emits proposal only, DOES NOT mutate store
        receipt = {
          eventId: event.eventId,
          source: event.source,
          sourceRevision: event.sourceRevision,
          meetingFactId: event.meetingFactId,
          selectedCandidateId: selectedCandidate.candidateId,
          actionId: selectedCandidate.actionId,
          status: 'proposal',
          confidence: selection.answerConfidence ?? null,
          reason: 'Laya 选定顺延调整方案，认知层已生成修复候选，待受信执行端口确认',
          graphRevisionBefore,
          graphRevisionAfter: initialSnapshot.revision,
          evaluatedAt: event.detectedAt,
          proposedModifications: fullBatch,
          selection,
        };
      }
    } else if (selection.state === 'selected' && selectedCandidate?.actionId === 'defer_and_verify') {
      receipt = {
        eventId: event.eventId,
        source: event.source,
        sourceRevision: event.sourceRevision,
        meetingFactId: event.meetingFactId,
        selectedCandidateId: selectedCandidate.candidateId,
        actionId: selectedCandidate.actionId,
        status: 'deferred',
        confidence: selection.answerConfidence ?? null,
        reason: 'Laya 决定暂缓自动调整，保持原计划并等待协同方二次确认',
        graphRevisionBefore,
        graphRevisionAfter: initialSnapshot.revision,
        evaluatedAt: event.detectedAt,
        selection,
      };
    } else {
      receipt = {
        eventId: event.eventId,
        source: event.source,
        sourceRevision: event.sourceRevision,
        meetingFactId: event.meetingFactId,
        selectedCandidateId: selectedCandidate?.candidateId ?? 'cand-review',
        actionId: selectedCandidate?.actionId ?? 'escalate_conflict',
        status: 'requires_review',
        confidence: selection.answerConfidence ?? null,
        reason: selection.reason === 'uncertain' ? 'Laya 置信度不足，等待人工确认' :
          selection.reason === 'high_risk' ? '方案涉及高风险日程冲突，需用户明确批准' :
          '决策状态为待复核',
        graphRevisionBefore,
        graphRevisionAfter: initialSnapshot.revision,
        evaluatedAt: event.detectedAt,
        selection,
      };
    }

    await this.saveReceiptRecord(event, inputDigest, receipt);
    return receipt;
  }

  private async saveReceiptRecord(
    event: MeetingRescheduleEvent,
    inputDigest: string,
    receipt: MeetingDecisionReceipt
  ): Promise<void> {
    await this.receiptStore.saveReceipt({
      eventId: event.eventId,
      namespace: this.namespace,
      source: event.source,
      sourceRevision: event.sourceRevision,
      inputDigest,
      status: receipt.status,
      receipt,
      updatedAt: new Date(this.now()).toISOString(),
    });
  }

  /**
   * Builds candidates using topological ordering and preserves all unmodified dependencies.
   */
  private buildCandidates(
    graph: GraphSnapshot,
    prospectiveFact: NodeRef,
    recheckItems: ImpactReport['items'],
    event: MeetingRescheduleEvent
  ): readonly MeetingCandidate[] {
    const nodes = new Map(currentNodes(graph).map(node => [node.id, node]));
    const targetIds = new Set(recheckItems.map(item => item.node.id));

    // Kahn topological ordering among affected nodes
    const pending = new Set(targetIds);
    const ordered: NodeVersion[] = [];
    while (pending.size > 0) {
      const ready = [...pending].filter(id => {
        const node = nodes.get(id);
        if (!node) return false;
        return node.dependencies.every(dep => !pending.has(dep.id));
      }).sort();

      if (ready.length === 0) break;
      for (const id of ready) {
        pending.delete(id);
        ordered.push(nodes.get(id)!);
      }
    }

    // Build topological adjustments preserving existing unaffected dependencies
    const newRevisions = new Map<string, number>();
    newRevisions.set(prospectiveFact.id, prospectiveFact.revision);

    const proposedModifications: NodeInput[] = [];
    for (const node of ordered) {
      if (!isEffective(node, event.detectedAt)) continue;

      const nextRev = node.revision + 1;
      newRevisions.set(node.id, nextRev);

      const updatedDeps: NodeRef[] = node.dependencies.map(dep => {
        const remappedRev = newRevisions.get(dep.id);
        return {
          id: dep.id,
          revision: remappedRev ?? dep.revision,
        };
      });

      let updatedSummary = node.summary;
      if (node.kind === 'goal') {
        updatedSummary = `准时参加改期后的会议 (${event.newSummary})`;
      } else if (node.kind === 'decision') {
        updatedSummary = `配合新会议时间调整出发安排 (${event.newSummary})`;
      } else if (node.kind === 'plan') {
        updatedSummary = `调整提前出发提醒时间以适配新会议 (${event.newSummary})`;
      }

      proposedModifications.push({
        id: node.id,
        kind: node.kind,
        summary: updatedSummary,
        sourceRef: node.sourceRef,
        sensitivity: node.sensitivity,
        state: 'active',
        validFrom: node.validFrom,
        validUntil: node.validUntil,
        reason: `按会议改期 [eventId: ${event.eventId}] 拓扑顺延`,
        dependencies: updatedDeps,
      });
    }

    const candAdjust: MeetingCandidate = {
      candidateId: 'cand-adjust-schedule',
      actionId: 'adjust_schedule',
      description: `自动顺延计划：依据会议推迟，同步调整行程、决策与出发提醒 (${event.newSummary})`,
      risk: 'low',
      reason: '会议改期时间明确，依赖链条清晰，调整计划可完全恢复有效状态',
      proposedModifications,
    };

    const candDefer: MeetingCandidate = {
      candidateId: 'cand-defer-verify',
      actionId: 'defer_and_verify',
      description: '保持现有计划暂不调整：等待发起人或协同与会者二次确认后再执行计划变更',
      risk: 'low',
      reason: '改期通知来源未经二次确认或处于待定状态，避免过早变更引发协同混乱',
    };

    const candEscalate: MeetingCandidate = {
      candidateId: 'cand-escalate-conflict',
      actionId: 'escalate_conflict',
      description: '报告日程潜在冲突：新会议时间可能挤压既定安排，生成决策卡片请求用户批准',
      risk: 'high',
      reason: '时间推迟存在日程跨段冲突风险，超出全自动处理安全边界',
    };

    return Object.freeze([candAdjust, candDefer, candEscalate]);
  }
}
