import type {AgentToolPort, AgentWorkerContext} from '@personal-agent/agents';
import type {ModelPort} from '@personal-agent/models';

/** Existing Runtime request adapter; this alias does not freeze a new contract. */
export type ToolExecutionPort = AgentToolPort;
export interface CiFixProposal {
  diagnosis: string;
  patches: {path: string; expectedSha256: string; edits: {oldText: string; newText: string}[]}[];
}
/** Host-selected registered tools; model cannot choose these or their arguments. */
export interface CiFixGitTools {
  head: string;
  commit: string;
  push: string;
  pullRequest: string;
  backlink: string;
}
export interface CiFixOptions {
  repository: string;
  runId?: string;
  /** Required for issue-only repair; host selects the source revision. */
  expectedHeadSha?: string;
  model?: ModelPort;
  tools?: ToolExecutionPort;
  gitTools?: CiFixGitTools;
  verifyRecipeId: string;
  /** Host-approved source files; their current bytes are read through Runtime. */
  sourcePaths: readonly string[];
  headBranch?: string;
  baseBranch?: string;
  issue?: {url: string; number: number; repository: string; fingerprint: string};
  maxSteps: number;
  maxTokens: number;
  /** Bounded repair attempts: a failed verification feeds the next model round. Default 2, max 4. */
  maxAttempts?: number;
  maxLogBytes?: number;
  /** Runtime-owned authorization binding; no fallback authorization is minted. */
  authorizationRefFor(tool: string, context: AgentWorkerContext): string | undefined;
  now?: () => number;
  /** Only Runtime may authorize consuming a reconciled cached tool result. */
  confirmedReplayReady?: (runId: string) => boolean;
}
export interface CiFixWorkflowPort { run(context: AgentWorkerContext): Promise<CiFixOutcome> }
export interface CiFixOutcome {
  status: 'succeeded' | 'unsupported' | 'waiting_approval' | 'waiting_reconciliation' | 'verification_failed' | 'stale';
  reason: string;
  evidenceRefs: readonly string[];
  pullRequestUrl?: string;
  verificationRunId?: string;
}
