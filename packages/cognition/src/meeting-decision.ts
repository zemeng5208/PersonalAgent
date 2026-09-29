import {createHash} from 'node:crypto';
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
  type LayaActionSelection,
} from './laya-action-choice.js';
import type {LayaInferencePort} from './laya-decision.js';

export interface MeetingRescheduleEvent {
  readonly eventId: string;
  readonly source: string;
  readonly meetingFactId: string;
  readonly originalSummary: string;
  readonly newSummary: string;
  readonly sourceRevision: string;
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

export interface MeetingDecisionReceiptStorePort {
  loadReceipt(eventId: string): MeetingReceiptRecord | undefined | Promise<MeetingReceiptRecord | undefined>;
  saveReceipt(record: MeetingReceiptRecord): void | Promise<void>;
}

export class InMemoryMeetingDecisionReceiptStore implements MeetingDecisionReceiptStorePort {
  private readonly records = new Map<string, MeetingReceiptRecord>();
  loadReceipt(eventId: string): MeetingReceiptRecord | undefined {
    const record = this.records.get(eventId);
    return record ? structuredClone(record) : undefined;
  }
  saveReceipt(record: MeetingReceiptRecord): void {
    this.records.set(record.eventId, structuredClone(record));
  }
}

export interface MeetingPlanExecutionPort {
  executeBatch(request: {
    readonly expectedRevision: number;
    readonly inputs: readonly NodeInput[];
    readonly eventId: string;
    readonly source: string;
    readonly sourceRevision: string;
  }): Promise<{ readonly applied: boolean; readonly snapshot: GraphSnapshot; readonly error?: string }>;
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

export interface MeetingCoordinatorOptions {
  readonly store: CoordinationStorePort | AtomicCoordinationStorePort;
  readonly inference: LayaInferencePort;
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
  private readonly choiceService: LayaActionChoiceService;
  private readonly executionPort?: MeetingPlanExecutionPort | undefined;
  private readonly receiptStore: MeetingDecisionReceiptStorePort;
  private readonly namespace: string;
  private readonly now: () => number;

  constructor(options: MeetingCoordinatorOptions) {
    if (!options || !options.store || typeof options.store.read !== 'function' || !options.inference) {
      throw new CognitionError('INVALID_ARGUMENT');
    }
    this.store = options.store;
    this.choiceService = new LayaActionChoiceService(options.inference);
    this.executionPort = options.executionPort;
    this.receiptStore = options.receiptStore ?? new InMemoryMeetingDecisionReceiptStore();
    this.namespace = options.namespace ?? 'default';
    this.now = options.now ?? Date.now;
  }

  /** Readback existing processed decision by event ID from durable receipt store. */
  async getReceipt(eventId: string): Promise<MeetingDecisionReceipt | undefined> {
    const record = await this.receiptStore.loadReceipt(eventId);
    return record?.receipt;
  }

  /**
   * Main vertical execution:
   * 1. Replay and conflict detection via durable receipt store
   * 2. Pure in-memory preflight of prospective fact update & impact analysis
   * 3. Kahn topological ordering for affected graph dependencies
   * 4. Multi-candidate selection via LayaActionChoiceService (no self-signed authorization)
   * 5. Execution through trusted port via atomic appendBatch or emission of proposal
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

    // 1. Replay and conflict protection
    const existingRecord = await this.receiptStore.loadReceipt(event.eventId);
    if (existingRecord) {
      if (existingRecord.inputDigest === inputDigest) {
        return {...existingRecord.receipt, status: 'already_processed'};
      }
      // Same event ID with different content or revision is an explicit conflict
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

    // Locate the current meeting node in graph
    const currentMeetingFact = initialSnapshot.history.findLast(
      node => node.id === event.meetingFactId && node.kind === 'fact'
    );
    if (!currentMeetingFact) {
      throw new CognitionError('NOT_APPLICABLE');
    }

    // 2. Pure in-memory preflight of updated fact (DO NOT mutate store yet)
    const updatedFactInput: NodeInput = {
      id: event.meetingFactId,
      kind: 'fact',
      summary: event.newSummary,
      sourceRef: event.source,
      sensitivity: currentMeetingFact.sensitivity,
      state: 'active',
      validFrom: currentMeetingFact.validFrom,
      validUntil: currentMeetingFact.validUntil,
      reason: `外部会议改期通知 [eventId: ${event.eventId}]`,
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

    // 3. Impact analysis on prospective graph
    const impactReport = analyzeImpact(prospectiveGraph, event.detectedAt);
    const recheckItems = impactReport.items.filter(item => item.action === 'RECHECK');

    // 4. Generate candidates with topological dependency preservation
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

    // 5. Ask Laya to choose between the candidates
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

    // 6. Handle chosen action
    let receipt: MeetingDecisionReceipt;
    const selectedCandidate = candidates.find(c => c.candidateId === selection.selected?.id);

    if (selection.state === 'selected' && selectedCandidate && selectedCandidate.risk === 'low'
      && selectedCandidate.actionId === 'adjust_schedule' && selectedCandidate.proposedModifications) {
      const fullBatch: NodeInput[] = [updatedFactInput, ...selectedCandidate.proposedModifications];

      if (this.executionPort) {
        // Execute via trusted execution port
        const execResult = await this.executionPort.executeBatch({
          expectedRevision: initialSnapshot.revision,
          inputs: fullBatch,
          eventId: event.eventId,
          source: event.source,
          sourceRevision: event.sourceRevision,
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
