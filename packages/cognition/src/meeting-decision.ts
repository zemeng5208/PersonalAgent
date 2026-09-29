import {createHash} from 'node:crypto';
import {
  parseGraph,
  appendVersion,
  type GraphSnapshot,
  type NodeRef,
  type NodeInput,
} from '@personal-agent/goals';
import type {AtomicCoordinationStorePort, CoordinationStorePort} from '@personal-agent/goals/store';
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
  readonly proposedModifications?: readonly {
    readonly id: string;
    readonly kind: 'goal' | 'decision' | 'plan';
    readonly summary: string;
    readonly dependencies: readonly NodeRef[];
  }[];
}

export interface MeetingDecisionReceipt {
  readonly eventId: string;
  readonly source: string;
  readonly meetingFactId: string;
  readonly selectedCandidateId: string;
  readonly actionId: string;
  readonly status: 'applied' | 'requires_review' | 'deferred' | 'already_processed';
  readonly confidence: number | null;
  readonly reason: string;
  readonly graphRevisionBefore: number;
  readonly graphRevisionAfter: number;
  readonly evaluatedAt: string;
  readonly appliedNodeRevisions?: readonly NodeRef[];
  readonly selection?: LayaActionSelection;
}

export interface MeetingCoordinatorOptions {
  readonly store: CoordinationStorePort | AtomicCoordinationStorePort;
  readonly inference: LayaInferencePort;
  readonly namespace?: string;
  readonly now?: () => number;
}

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

/**
 * End-to-end meeting reschedule decision loop.
 * Consumes meeting change facts, evaluates real graph impact, presents multiple candidates
 * to local Laya, safely writes back low-risk plans via CAS, and enforces replay deduplication.
 */
export class MeetingRescheduleCoordinator {
  private readonly store: CoordinationStorePort;
  private readonly choiceService: LayaActionChoiceService;
  private readonly processed = new Map<string, MeetingDecisionReceipt>();
  private readonly now: () => number;

  constructor(options: MeetingCoordinatorOptions) {
    if (!options || !options.store || typeof options.store.read !== 'function'
      || typeof options.store.append !== 'function' || !options.inference) {
      throw new CognitionError('INVALID_ARGUMENT');
    }
    this.store = options.store;
    this.choiceService = new LayaActionChoiceService(options.inference);
    this.now = options.now ?? Date.now;
  }

  /** Readback existing processed decision by event ID. */
  getReceipt(eventId: string): MeetingDecisionReceipt | undefined {
    return this.processed.get(eventId);
  }

  /**
   * Main vertical execution:
   * 1. Replay check (idempotency)
   * 2. Append updated meeting fact
   * 3. Evaluate impact across dependencies
   * 4. Build multiple candidates
   * 5. Invoke Laya for choice
   * 6. Write back low-risk action or hold for review
   */
  async processEvent(event: MeetingRescheduleEvent): Promise<MeetingDecisionReceipt> {
    if (!event || typeof event.eventId !== 'string' || !event.eventId.trim()
      || typeof event.meetingFactId !== 'string' || !event.meetingFactId.trim()
      || typeof event.newSummary !== 'string' || !event.newSummary.trim()
      || !(event.signal instanceof AbortSignal) || !Number.isFinite(Date.parse(event.deadline))) {
      throw new CognitionError('INVALID_ARGUMENT');
    }
    if (event.signal.aborted) throw new CognitionError('INVALID_ARGUMENT');
    if (this.now() >= Date.parse(event.deadline)) throw new CognitionError('INVALID_ARGUMENT');

    // 1. Replay protection (deduplication)
    const existing = this.processed.get(event.eventId);
    if (existing) {
      return {...existing, status: 'already_processed'};
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

    // 2. Append new fact version to graph
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

    const graphAfterFact = this.store.append(initialSnapshot.revision, updatedFactInput);
    const newMeetingFact = graphAfterFact.history.findLast(
      node => node.id === event.meetingFactId && node.kind === 'fact'
    )!;

    // 3. Impact Analysis
    const impactReport = analyzeImpact(graphAfterFact, event.detectedAt);
    const recheckItems = impactReport.items.filter(item => item.action === 'RECHECK');

    // 4. Generate multiple feasible candidates based on affected nodes
    const candidates = this.buildCandidates(graphAfterFact, newMeetingFact, recheckItems, event);

    // Map to LayaActionCandidate structure for Laya model choice
    const actionCandidates: readonly LayaActionCandidate[] = candidates.map(cand => {
      if (cand.actionId === 'adjust_schedule') {
        const toolArgs = {action: cand.actionId, candidateId: cand.candidateId, eventId: event.eventId};
        const argsDigest = actionArgumentsDigest(toolArgs);
        return {
          id: cand.candidateId,
          revision: 1,
          kind: 'tool',
          tool: {name: 'goals.revise', version: '1.0.0', arguments: toolArgs},
          description: cand.description,
          sources: [{id: newMeetingFact.id, revision: newMeetingFact.revision}],
          scopeRef: `meeting:${cand.actionId}`,
          expiresAt: event.deadline,
          risk: cand.risk,
          argumentsDigest: argsDigest,
          authorization: {
            state: 'granted',
            refDigest: hash(`${event.eventId}:${cand.candidateId}`),
            scopeRef: `meeting:${cand.actionId}`,
            argumentsDigest: argsDigest,
            expiresAt: event.deadline,
          },
        };
      }
      const emptyDigest = actionArgumentsDigest({});
      return {
        id: cand.candidateId,
        revision: 1,
        kind: cand.actionId === 'defer_and_verify' ? 'defer' : 'escalate',
        description: cand.description,
        sources: [{id: newMeetingFact.id, revision: newMeetingFact.revision}],
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
      // Model failure or timeout leads to graceful review state without crashing
      const fallbackReceipt: MeetingDecisionReceipt = {
        eventId: event.eventId,
        source: event.source,
        meetingFactId: event.meetingFactId,
        selectedCandidateId: 'cand-review-fallback',
        actionId: 'escalate_conflict',
        status: 'requires_review',
        confidence: null,
        reason: error instanceof Error ? error.message : 'Laya 模型推理异常，降级等待人工确认',
        graphRevisionBefore,
        graphRevisionAfter: graphAfterFact.revision,
        evaluatedAt: event.detectedAt,
      };
      this.processed.set(event.eventId, fallbackReceipt);
      return fallbackReceipt;
    }

    // 6. Execute selected action or record review requirement
    let receipt: MeetingDecisionReceipt;
    const selectedCandidate = candidates.find(c => c.candidateId === selection.selected?.id);

    if (selection.state === 'selected' && selectedCandidate && selectedCandidate.risk === 'low'
      && selectedCandidate.actionId === 'adjust_schedule' && selectedCandidate.proposedModifications) {
      // Low risk plan revision: perform atomic CAS write to Goal Store
      let currentRev = graphAfterFact.revision;
      const appliedRevisions: NodeRef[] = [];

      for (const mod of selectedCandidate.proposedModifications) {
        const existingNode = graphAfterFact.history.findLast(n => n.id === mod.id);
        const nodeInput: NodeInput = {
          id: mod.id,
          kind: mod.kind,
          summary: mod.summary,
          sourceRef: existingNode?.sourceRef ?? event.source,
          sensitivity: existingNode?.sensitivity ?? 'private',
          state: 'active',
          validFrom: existingNode?.validFrom ?? event.detectedAt,
          validUntil: existingNode?.validUntil ?? event.deadline,
          reason: `按 Laya 决策 [${selectedCandidate.candidateId}] 自动调整时间与依赖`,
          dependencies: [...mod.dependencies],
        };
        const nextGraph = this.store.append(currentRev, nodeInput);
        currentRev = nextGraph.revision;
        appliedRevisions.push({id: mod.id, revision: nextGraph.history.findLast(n => n.id === mod.id)!.revision});
      }

      // Verify that after application, impact is resolved
      const finalImpact = analyzeImpact(this.store.read(), event.detectedAt);
      const remainingRechecks = finalImpact.items.filter(i => i.action === 'RECHECK'
        && appliedRevisions.some(a => a.id === i.node.id));

      receipt = {
        eventId: event.eventId,
        source: event.source,
        meetingFactId: event.meetingFactId,
        selectedCandidateId: selectedCandidate.candidateId,
        actionId: selectedCandidate.actionId,
        status: remainingRechecks.length === 0 ? 'applied' : 'requires_review',
        confidence: selection.answerConfidence ?? null,
        reason: `Laya 选定调整方案并完成原子写入；后验依赖校验已${remainingRechecks.length === 0 ? '全部解决' : '有部分需进一步复核'}`,
        graphRevisionBefore,
        graphRevisionAfter: currentRev,
        evaluatedAt: event.detectedAt,
        appliedNodeRevisions: appliedRevisions,
        selection,
      };
    } else if (selection.state === 'selected' && selectedCandidate?.actionId === 'defer_and_verify') {
      // Deferred action: fact is recorded, plan is held without unverified mutation
      receipt = {
        eventId: event.eventId,
        source: event.source,
        meetingFactId: event.meetingFactId,
        selectedCandidateId: selectedCandidate.candidateId,
        actionId: selectedCandidate.actionId,
        status: 'deferred',
        confidence: selection.answerConfidence ?? null,
        reason: 'Laya 决定暂缓自动调整，保持原计划并等待协同方二次确认',
        graphRevisionBefore,
        graphRevisionAfter: graphAfterFact.revision,
        evaluatedAt: event.detectedAt,
        selection,
      };
    } else {
      // Uncertain, high-risk, or review state
      receipt = {
        eventId: event.eventId,
        source: event.source,
        meetingFactId: event.meetingFactId,
        selectedCandidateId: selectedCandidate?.candidateId ?? 'cand-review',
        actionId: selectedCandidate?.actionId ?? 'escalate_conflict',
        status: 'requires_review',
        confidence: selection.answerConfidence ?? null,
        reason: selection.reason === 'uncertain' ? 'Laya 置信度不足，等待人工确认' :
          selection.reason === 'high_risk' ? '方案涉及高风险日程冲突，需用户明确批准' :
          '决策状态为待复核',
        graphRevisionBefore,
        graphRevisionAfter: graphAfterFact.revision,
        evaluatedAt: event.detectedAt,
        selection,
      };
    }

    this.processed.set(event.eventId, receipt);
    return receipt;
  }

  /**
   * Generates multiple structured, feasible candidates based on affected nodes.
   */
  private buildCandidates(
    graph: GraphSnapshot,
    meetingFact: NodeRef,
    recheckItems: ImpactReport['items'],
    event: MeetingRescheduleEvent
  ): readonly MeetingCandidate[] {
    const affectedGoals = recheckItems.filter(i => i.kind === 'goal');
    const affectedDecisions = recheckItems.filter(i => i.kind === 'decision');
    const affectedPlans = recheckItems.filter(i => i.kind === 'plan');

    // Candidate 1: Adjust schedule (顺延日程与提醒)
    const proposedAdjustments: {id: string; kind: 'goal' | 'decision' | 'plan'; summary: string; dependencies: NodeRef[]}[] = [];
    for (const item of affectedGoals) {
      proposedAdjustments.push({
        id: item.node.id,
        kind: 'goal',
        summary: `参加改期后的会议 (${event.newSummary})`,
        dependencies: [{id: meetingFact.id, revision: meetingFact.revision}],
      });
    }
    for (const item of affectedDecisions) {
      const parentGoal = affectedGoals[0] ?? {node: meetingFact};
      proposedAdjustments.push({
        id: item.node.id,
        kind: 'decision',
        summary: `配合新会议时间调整出发安排 (${event.newSummary})`,
        dependencies: [{id: parentGoal.node.id, revision: parentGoal.node.revision + 1}],
      });
    }
    for (const item of affectedPlans) {
      const parentDecision = affectedDecisions[0] ?? affectedGoals[0] ?? {node: meetingFact};
      proposedAdjustments.push({
        id: item.node.id,
        kind: 'plan',
        summary: `调整提前出发提醒时间以适配新会议 (${event.newSummary})`,
        dependencies: [{id: parentDecision.node.id, revision: parentDecision.node.revision + 1}],
      });
    }

    const candAdjust: MeetingCandidate = {
      candidateId: 'cand-adjust-schedule',
      actionId: 'adjust_schedule',
      description: `自动顺延计划：依据会议推迟，同步调整行程、决策与出发提醒 (${event.newSummary})`,
      risk: 'low',
      reason: '会议改期时间明确，依赖链条清晰，调整计划可完全恢复有效状态',
      proposedModifications: proposedAdjustments,
    };

    // Candidate 2: Defer and verify (暂缓调整并核查)
    const candDefer: MeetingCandidate = {
      candidateId: 'cand-defer-verify',
      actionId: 'defer_and_verify',
      description: '保持现有计划暂不调整：等待发起人或协同与会者二次确认后再执行计划变更',
      risk: 'low',
      reason: '改期通知来源未经二次确认或处于待定状态，避免过早变更引发协同混乱',
    };

    // Candidate 3: Escalate conflict (报告冲突并请求人工决策)
    const candEscalate: MeetingCandidate = {
      candidateId: 'cand-escalate-conflict',
      actionId: 'escalate_conflict',
      description: '报告日程潜在冲突：新会议时间可能挤压晚间既定安排，生成决策卡片请求用户批准',
      risk: 'high',
      reason: '时间推迟存在日程跨段冲突风险，超出全自动处理安全边界',
    };

    return [candAdjust, candDefer, candEscalate];
  }
}
