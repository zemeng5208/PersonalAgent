import {DecisionError} from './proactive-decision.js';
import type {DecisionPort, DecisionRef, DecisionSuggestion} from './proactive-decision.js';

/** Structural view of Runtime's committed FactProjectionReceipt. No Runtime dependency. */
export interface ProjectedFactDecisionInput {
  readonly projection: {
    readonly graphRevision: number;
    readonly links: readonly {
      readonly eventId: string;
      readonly fact: DecisionRef;
      readonly node: DecisionRef;
    }[];
  };
  readonly impact: {
    readonly namespace: string;
    readonly graphRevision: number;
    readonly items: readonly {
      readonly action: 'KEEP' | 'RECHECK';
      readonly causes: readonly {readonly reference: DecisionRef}[];
    }[];
  };
  readonly deadline: string;
  readonly signal: AbortSignal;
}

/** Called after the existing projection and impact processing, never from a new poller. */
export async function decideProjectedFactImpact(
  decision: DecisionPort, input: ProjectedFactDecisionInput
): Promise<readonly DecisionSuggestion[]> {
  const {projection, impact, deadline, signal} = input;
  if (!projection || !impact || !Number.isSafeInteger(projection.graphRevision)
    || projection.graphRevision < 0 || projection.graphRevision !== impact.graphRevision
    || !Array.isArray(projection.links) || projection.links.length > 4
    || !Array.isArray(impact.items) || typeof impact.namespace !== 'string'
    || !impact.namespace || `memory-projection:${impact.namespace}`.length > 128) {
    throw new DecisionError('INVALID_ARGUMENT');
  }
  const events = projection.links.flatMap(link => {
    const affected = impact.items.filter(item => item.action === 'RECHECK'
      && item.causes.some(cause => cause.reference.id === link.node.id));
    if (affected.length === 0) return [];
    return [{
      eventId: link.eventId,
      source: `memory-projection:${impact.namespace}`,
      observation: `Projected fact changed; ${affected.length} dependent graph item(s) require recheck.`,
      facts: [link.fact],
      authorization: {state: 'none' as const, revision: 0},
    }];
  });
  if (events.length === 0) return [];
  return decision.decide({events, deadline, signal});
}
