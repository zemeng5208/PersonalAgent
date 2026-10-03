import type {ToolContext} from '@personal-agent/contracts';

export interface GitFileHash {path: string; sha256: string}
/** Produced by the Runtime gateway, never decoded from model tool arguments. */
export interface GitVerificationReceipt {
  taskId: string;
  runId: string;
  toolName: 'workspace.run_allowed_command';
  status: 'confirmed';
  exitCode: number;
  headSha: string;
  files: readonly GitFileHash[];
}
export interface GitToolsOptions {
  repository: string;
  rootPath: string;
  sourceBranch: string;
  remoteName: string;
  /** Exact credential-free https URL fixed by the host. */
  remoteUrl: string;
  allowedPaths: readonly string[];
  authorName: string;
  authorEmail: string;
  readVerification(context: ToolContext, runId: string): Promise<GitVerificationReceipt | undefined>;
  /** Trusted host secret adapter; never model input or ambient environment. */
  getCredentials?(context: ToolContext): Promise<{token: string} | undefined>;
  now?: () => number;
}
export interface GitHeadResult {headSha: string; clean: boolean; workspaceClean: boolean; fingerprint: string}
export interface GitCommitInput {repository: string; expectedHeadSha: string; paths: string[]; message: string; verificationRunId: string}
export interface GitCommitResult {headSha: string; parentSha: string; branch: string}
export interface GitPushInput {repository: string; expectedHeadSha: string}
export interface GitPushResult {headSha: string; pushed: true}
