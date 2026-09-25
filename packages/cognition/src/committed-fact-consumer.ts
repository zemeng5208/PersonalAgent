import {isDeepStrictEqual} from 'node:util';
import type {CoordinationStorePort} from '@personal-agent/goals/store';
import {analyzeImpact, CognitionError} from './impact.js';
import type {ImpactReport} from './impact.js';
import {DecisionError} from './proactive-decision.js';
import type {DecisionPort, DecisionSuggestion} from './proactive-decision.js';
import {decideProjectedFactImpact} from './projected-fact-decision.js';
import {selectProjectedRepairScope} from './projected-repair.js';
import type {ProjectedRepairInput, ProjectedRepairScope} from './projected-repair.js';

/** Local host handoff after its batch-scoped durable impact completion. */
export interface DurableFactProjectionInput extends ProjectedRepairInput {
  deadline: string;
  signal: AbortSignal;
}

interface CompletedFactProjectionInput extends DurableFactProjectionInput {
  processed: {batchToken: string; report: ImpactReport};
}

export interface CompletedFactProjectionDecision {
  scope: ProjectedRepairScope;
  suggestions: readonly DecisionSuggestion[];
}

/** Structural view of DEP02's scoped durable read, not a second feed contract. */
export interface CompletedFactImpactReader {
  readCompletedImpact(batchToken: string): {batchToken: string; report: ImpactReport} | undefined;
}

/** Read the exact completed batch from the trusted host before any advice. */
export async function decideDurableFactProjection(
  store: CoordinationStorePort,
  decision: DecisionPort,
  completion: CompletedFactImpactReader,
  input: DurableFactProjectionInput
): Promise<CompletedFactProjectionDecision> {
  if (!completion || typeof completion.readCompletedImpact !== 'function'
    || !input?.projection || typeof input.projection.batchToken !== 'string'
    || !input.projection.batchToken.trim()) throw new CognitionError('INVALID_ARGUMENT');
  const processed = completion.readCompletedImpact(input.projection.batchToken);
  if (!processed) throw new CognitionError('NOT_APPLICABLE');
  return decideCompletedFactProjection(store, decision, {...input, processed});
}

/**
 * Consume one already-completed public Fact projection. The trusted host must
 * supply the report with its original batch token; an unscoped report array is
 * not evidence that this batch completed. No feed ack, write or cloud action.
 */
async function decideCompletedFactProjection(
  store: CoordinationStorePort,
  decision: DecisionPort,
  input: CompletedFactProjectionInput
): Promise<CompletedFactProjectionDecision> {
  if (!input || !(input.signal instanceof AbortSignal)) throw new DecisionError('INVALID_ARGUMENT');
  if (input.signal.aborted) throw new DecisionError('CANCELLED');
  if (typeof input.deadline !== 'string' || !Number.isFinite(Date.parse(input.deadline))) {
    throw new DecisionError('INVALID_ARGUMENT');
  }
  if (Date.now() >= Date.parse(input.deadline)) throw new DecisionError('TIMEOUT');
  if (!input.processed || typeof input.processed.batchToken !== 'string'
    || !input.processed.batchToken || input.processed.batchToken !== input.projection?.batchToken) {
    throw new CognitionError('INVALID_ARGUMENT');
  }
  const snapshot = structuredClone(store.read());
  if (snapshot.revision !== input.projection.graphRevision) {
    throw new CognitionError('REVISION_CONFLICT');
  }
  const report = analyzeImpact(snapshot, input.processed.report?.evaluatedAt);
  if (!isDeepStrictEqual(report, input.processed.report)) throw new CognitionError('INVALID_ARGUMENT');
  const scope = selectProjectedRepairScope(snapshot, report.evaluatedAt, {
    graphNamespace: input.graphNamespace, projection: input.projection
  });
  const suggestions = await decideProjectedFactImpact(decision, {
    graphNamespace: input.graphNamespace,
    projection: input.projection,
    impact: report,
    deadline: input.deadline,
    signal: input.signal
  });
  return {scope, suggestions};
}
