import type {AgentToolPort, AgentWorkerContext} from '@personal-agent/agents';
import type {ModelPort} from '@personal-agent/models';

export type IssueKind = 'bug' | 'feature' | 'docs' | 'question';
export interface TriageIssue {
  number: number; title: string; body: string; state: 'open' | 'closed';
  labels: string[]; url: string; updatedAt: string;
}
export interface IssueClassification {
  kind: IssueKind; confidence: number;
  /** Exact excerpts, locally checked against the issue, never model execution evidence. */
  evidence: readonly {field: 'title' | 'body'; quote: string}[];
  calibrated: false;
}
export interface IssueTriageRequest {
  repo: string; number: number;
  writeLabel?: boolean;
  repairBug?: boolean;
  /** Host-owned repair instructions; untrusted issue content cannot grant execution. */
  repairGoal?: string;
}
export interface IssueTriageResult {
  state: 'classified' | 'manual_review' | 'waiting_approval' | 'waiting_reconciliation' | 'repair_requested';
  reason: string;
  repo: string; number: number;
  fingerprint?: string;
  classification?: IssueClassification;
  label?: string;
  evidenceRefs: readonly string[];
  repair?: {state: string; resultSummary: string; evidenceRefs: readonly string[]};
}
export interface IssueListRequest {
  repo: string; page?: number; perPage?: number;
  state?: 'open' | 'closed' | 'all'; labels?: string[];
}
export interface IssueListResult {
  state: 'listed' | 'waiting_approval' | 'waiting_reconciliation';
  items: readonly TriageIssue[]; page: number; nextPage: number | null; hasMore: boolean;
  evidenceRefs: readonly string[];
}
/** Narrow MOD-34 adapter. Composition invokes the existing coding workflow, never a second loop. */
export interface IssueRepairPort {
  repairIssue(context: AgentWorkerContext, request: {
    repo: string; number: number; issueUrl: string; issueFingerprint: string;
    goal: string; pullRequestBody: string;
  }): Promise<{state: string; resultSummary: string; evidenceRefs: readonly string[]}>;
}
export interface IssueTriageOptions {
  model: ModelPort;
  tools: AgentToolPort;
  repair?: IssueRepairPort;
  /** Resolves trusted scope references, including reads. Never passed to the model. */
  authorizationRefFor(toolName: string, context: AgentWorkerContext): string | undefined;
  /** Host confirms this exact original Gateway run has a durable confirmed receipt/cache. */
  confirmedReplayReady?(runId: string, context: AgentWorkerContext): boolean;
  /** Host checks the original MOD-34 checkpoint's unknown run IDs, not a new task or approval. */
  confirmedRepairReplayReady?(context: AgentWorkerContext, issue: {repo: string; number: number; fingerprint: string}): boolean;
  maxSteps: number;
  maxTokens: number;
  minConfidence?: number;
  labels?: Readonly<Record<IssueKind, string>>;
}
