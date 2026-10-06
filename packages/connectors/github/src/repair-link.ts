import {createHash} from 'node:crypto';
import {ProtocolError, validateToolValue} from '@personal-agent/contracts';
import type {ToolContext, ToolHost} from '@personal-agent/contracts';
import type {GitHubInputs, GitHubProvider, GitHubRepairIdentity, GitHubRepairReceipt, GitHubRepairLinkResult} from './provider.js';
import {GitHubService} from './service.js';
import {inputSchema, validateInput} from './schemas.js';
import {outputSchema} from './output-schemas.js';
import {GITHUB_CONNECTOR_VERSION} from './connector.js';

/** Opt-in only: the original thirteen GitHub tools are unchanged. */
export const githubRepairOperations = ['actions.repair.link', 'actions.repair.get'] as const;
type RepairApi = (endpoint: string, method?: string, payload?: unknown) => Promise<unknown>;
type RecordValue = Record<string, unknown>;
const malformed = (): never => {throw new ProtocolError('EXTERNAL_FAILURE', 'GitHub repair association readback invalid');};
function object(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) malformed();
  return value as RecordValue;
}
function identifier(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) malformed();
  return Number(value);
}
function normalized(input: GitHubRepairIdentity): GitHubRepairIdentity {
  return {repo: input.repo, runId: input.runId, expectedRunAttempt: input.expectedRunAttempt,
    sourceSha: input.sourceSha.toLowerCase(), repairPrNumber: input.repairPrNumber,
    repairHeadSha: input.repairHeadSha.toLowerCase(), workflowExecutionId: input.workflowExecutionId};
}
function fixed(identity: GitHubRepairIdentity) {
  const digest = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  const name = `PersonalAgent repair link / ${digest}`;
  const externalId = `personalagent-repair-link-v1:${digest}`;
  const detailsUrl = `https://github.com/${identity.repo}/pull/${identity.repairPrNumber}`;
  const title = 'Repair PR association; original CI result unchanged';
  const summary = 'This neutral check only associates a repair pull request with the original failed run. It does not validate the repair or change the original CI result.\n\n'
    + JSON.stringify(identity);
  return {name, externalId, detailsUrl, title, summary};
}
/** Public deterministic check identity for consumers validating a persisted receipt. */
export function githubRepairCheckName(input: GitHubRepairIdentity): string {
  validateInput('actions.repair.link', input);
  return fixed(normalized(input)).name;
}
function checkUrl(value: unknown, repo: string, checkRunId: number): string {
  const base = `https://github.com/${repo}/runs/${checkRunId}`;
  if (value !== base && value !== base+'?check_suite_focus=true') malformed();
  return value as string;
}
function receipt(raw: unknown, identity: GitHubRepairIdentity, checkRunId: number): GitHubRepairReceipt {
  const check = object(raw), output = object(check.output), expected = fixed(identity);
  const url = checkUrl(check.html_url, identity.repo, checkRunId);
  if (check.id !== checkRunId || check.url !== `https://api.github.com/repos/${identity.repo}/check-runs/${checkRunId}`
    || check.name !== expected.name || check.external_id !== expected.externalId
    || check.head_sha !== identity.sourceSha || check.details_url !== expected.detailsUrl
    || check.status !== 'completed' || check.conclusion !== 'neutral'
    || output.title !== expected.title || output.summary !== expected.summary) malformed();
  return {...identity, checkRunId, externalId: String(checkRunId), url, name: expected.name,
    detailsUrl: expected.detailsUrl, status: 'completed', conclusion: 'neutral', evidenceRefs: []};
}

/** Receives only the already scoped, credential-redacting provider API. Never retries a POST. */
export async function executeGitHubRepairLink(input: GitHubRepairIdentity, api: RepairApi, dispatched: () => boolean): Promise<GitHubRepairLinkResult> {
  const identity = normalized(input), root = `repos/${identity.repo}`, expected = fixed(identity);
  const run = object(await api(`${root}/actions/runs/${identity.runId}`));
  if (run.id !== identity.runId || object(run.repository).full_name !== identity.repo
    || run.run_attempt !== identity.expectedRunAttempt || run.head_sha !== identity.sourceSha
    || run.status !== 'completed' || run.conclusion !== 'failure') {
    throw new ProtocolError('REVISION_CONFLICT', 'Failed workflow run changed; refresh the repair association');
  }
  const pull = object(await api(`${root}/pulls/${identity.repairPrNumber}`));
  if (pull.number !== identity.repairPrNumber || pull.state !== 'open'
    || object(object(pull.base).repo).full_name !== identity.repo
    || object(object(pull.head).repo).full_name !== identity.repo
    || object(pull.head).sha !== identity.repairHeadSha || pull.html_url !== expected.detailsUrl) {
    throw new ProtocolError('REVISION_CONFLICT', 'Repair pull request changed; refresh the repair association');
  }
  let checkRunId: number | undefined;
  let checkRunUrl: string | undefined;
  try {
    const created = object(await api(`${root}/check-runs`, 'POST', {name: expected.name, head_sha: identity.sourceSha,
      details_url: expected.detailsUrl, external_id: expected.externalId, status: 'completed', conclusion: 'neutral',
      output: {title: expected.title, summary: expected.summary}}));
    checkRunId = identifier(created.id);
    checkRunUrl = checkUrl(created.html_url, identity.repo, checkRunId);
    // A success-shaped POST response alone is insufficient, and a contradictory
    // creation response cannot be repaired by reading some different object.
    receipt(created, identity, checkRunId);
    const verified = receipt(await api(`${root}/check-runs/${checkRunId}`), identity, checkRunId);
    return {state: 'confirmed', ...verified};
  } catch (error) {
    if (!dispatched()) throw error;
    return {state: 'unknown', ...(checkRunId === undefined ? {} : {checkRunId, externalId: String(checkRunId),
      url: checkRunUrl ?? `https://github.com/${identity.repo}/runs/${checkRunId}`}), evidenceRefs: []};
  }
}

/** Reads the original known CheckRun only. It does not grant or consume write authority. */
export async function getGitHubRepairLink(input: GitHubInputs['actions.repair.get'], api: RepairApi): Promise<GitHubRepairReceipt> {
  const identity = normalized(input);
  return receipt(await api(`repos/${identity.repo}/check-runs/${input.checkRunId}`), identity, input.checkRunId);
}

export interface GitHubRepairModuleOptions {
  provider: GitHubProvider;
  /** Synchronous trusted persistence of candidate metadata; never an authorization or confirmation. */
  observeUnknown?: (input: GitHubRepairIdentity, result: Extract<GitHubRepairLinkResult, {state: 'unknown'}>, context: ToolContext) => undefined;
}
/** The caller owns provider lifecycle; disposal removes only this optional registration. */
export function registerGitHubRepairLinks(host: ToolHost, options: GitHubRepairModuleOptions): () => void {
  if (!options?.provider) throw new ProtocolError('INVALID_ARGUMENT', 'Explicit GitHub repair provider required');
  const provider: GitHubProvider = {verification: options.provider.verification, execute: options.provider.execute.bind(options.provider)};
  const service = new GitHubService(provider), dispose: (() => void)[] = [];
  try {
    for (const op of githubRepairOperations) {
      const write = op === 'actions.repair.link', scope = write ? 'github:write' : 'github:read';
      dispose.push(host.register({descriptor: {name: `github.${op}`, version: GITHUB_CONNECTOR_VERSION,
        inputSchema: inputSchema(op), outputSchema: outputSchema(op), sideEffect: write ? 'external_write' : 'read',
        requiredScopes: [scope], idempotencySupport: !write, recoverySupport: !write, requiresPresence: write},
      execute: async (input, context) => {
        if (!context?.authorizationRef || !context.scopes.includes(scope)) throw new ProtocolError('SCOPE_DENIED', 'GitHub repair tool requires host authorization and scope');
        validateInput(op, input);
        const result = await service.execute(op, input as GitHubInputs[typeof op], context);
        try {validateToolValue(outputSchema(op), result);}
        catch {throw new ProtocolError(write ? 'RESULT_UNKNOWN' : 'EXTERNAL_FAILURE', 'GitHub repair provider returned an invalid result');}
        if (write && (result as GitHubRepairLinkResult).state === 'unknown') {
          try {
            const observed: unknown = options.observeUnknown?.(structuredClone(input as GitHubRepairIdentity),
              structuredClone(result as Extract<GitHubRepairLinkResult, {state: 'unknown'}>), context);
            // The public hook is synchronous. A misconfigured JS thenable must
            // neither delay RESULT_UNKNOWN nor emit an unhandled rejection.
            if (observed !== undefined) void Promise.resolve(observed).catch(() => undefined);
          } catch { /* Persistence failure cannot confirm or authorize retry. */ }
          throw new ProtocolError('RESULT_UNKNOWN', 'GitHub repair association unknown; reconcile original check before any retry');
        }
        return result;
      }}));
    }
  } catch (error) {for (const unregister of dispose.reverse()) unregister(); service.dispose(); throw error;}
  let disposed = false;
  return () => {if (disposed) return; disposed = true; for (const unregister of dispose.reverse()) unregister(); service.dispose();};
}
