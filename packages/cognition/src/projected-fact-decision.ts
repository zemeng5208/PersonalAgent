import {DecisionError} from './proactive-decision.js';
import type {DecisionPort, DecisionRef, DecisionSuggestion} from './proactive-decision.js';

/** Structural view of Runtime's committed FactProjectionReceipt. No Runtime dependency. */
export interface ProjectedFactDecisionInput {
  /** Namespace bound by the trusted projection host, never supplied by a model. */
  readonly graphNamespace: string;
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
      readonly causes: readonly {readonly reference: DecisionRef; readonly currentRevision: number}[];
    }[];
  };
  readonly deadline: string;
  readonly signal: AbortSignal;
}

function checkLifecycle(deadline: string, signal: AbortSignal): void {
  if (typeof deadline !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(deadline)
    || !Number.isFinite(Date.parse(deadline)) || new Date(deadline).toISOString() !== deadline
    || !(signal instanceof AbortSignal)) throw new DecisionError('INVALID_ARGUMENT');
  if (signal.aborted) throw new DecisionError('CANCELLED');
  if (Date.now() >= Date.parse(deadline)) throw new DecisionError('TIMEOUT');
}

/** Called after the existing projection and impact processing, never from a new poller. */
export async function decideProjectedFactImpact(
  decision: DecisionPort, input: ProjectedFactDecisionInput
): Promise<readonly DecisionSuggestion[]> {
  if (!input) throw new DecisionError('INVALID_ARGUMENT');
  const {graphNamespace, projection, impact, deadline, signal} = input;
  if (!projection || !impact || !Number.isSafeInteger(projection.graphRevision)
    || projection.graphRevision < 0 || projection.graphRevision !== impact.graphRevision
    || !Array.isArray(projection.links) || projection.links.length > 4
    || !Array.isArray(impact.items) || typeof graphNamespace !== 'string'
    || !graphNamespace || graphNamespace.trim() !== graphNamespace
    || /[\u0000-\u001f\u007f]/.test(graphNamespace) || impact.namespace !== graphNamespace
    || `memory-projection:${graphNamespace}`.length > 128) {
    throw new DecisionError('INVALID_ARGUMENT');
  }
  checkLifecycle(deadline, signal);
  const events = projection.links.flatMap(link => {
    const affected = impact.items.filter(item => item.action === 'RECHECK'
      && item.causes.some(cause => cause.reference.id === link.node.id
        && cause.currentRevision === link.node.revision));
    if (affected.length === 0) return [];
    return [{
      eventId: link.eventId,
      source: `memory-projection:${graphNamespace}`,
      observation: `Projected fact changed; ${affected.length} dependent graph item(s) require recheck.`,
      facts: [link.fact],
      authorization: {state: 'none' as const, revision: 0},
    }];
  });
  if (events.length === 0) {
    checkLifecycle(deadline, signal);
    return [];
  }
  return decision.decide({events, deadline, signal});
}
