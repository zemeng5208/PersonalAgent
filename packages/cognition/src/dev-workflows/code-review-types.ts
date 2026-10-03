import type {AgentToolPort, AgentWorkerContext, ToolInvocationResult} from '@personal-agent/agents';
import type {ModelPort} from '@personal-agent/models';

/** Supplied by trusted composition; PR content cannot add or replace these rules. */
export interface CodeReviewRule {id: string; text: string}
export interface CodeReviewInput {repo: string; number: number; rules: readonly CodeReviewRule[]}
export interface CodeReviewFinding {
  kind: 'blocking' | 'suggestion' | 'question';
  ruleId: string;
  path: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  body: string;
}
export interface CodeReviewReport {
  repo: string;
  number: number;
  headSha: string;
  baseSha: string;
  rules: readonly CodeReviewRule[];
  findings: readonly CodeReviewFinding[];
  evidenceRefs: readonly string[];
}
/** Host-owned authorization reference and unique durable tool execution prefix. */
export interface CodeReviewAccess {
  runId: string;
  authorizationRef: string;
  /** Trusted host only: Runtime has confirmed the original tool execution and installed cached replay. */
  confirmedReplayReady?: (runId: string) => boolean;
}
export type CodeReviewPreparation =
  | {state: 'prepared'; report: CodeReviewReport}
  | {state: 'unsupported'; reason: string}
  | {state: 'pending' | 'unknown'; evidenceRefs: readonly string[]};
export type CodeReviewPublication = ToolInvocationResult | {state: 'unsupported'; reason: string};
export interface CodeReviewWorkflow {
  prepare(input: CodeReviewInput, context: AgentWorkerContext, access: CodeReviewAccess): Promise<CodeReviewPreparation>;
  publish(report: CodeReviewReport, findingIndex: number, context: AgentWorkerContext, access: CodeReviewAccess): Promise<CodeReviewPublication>;
}
export interface CodeReviewWorkflowOptions {
  model: ModelPort;
  tools: AgentToolPort;
  maxDiffChars?: number;
  maxPages?: number;
  maxFindings?: number;
  maxTokens?: number;
}
