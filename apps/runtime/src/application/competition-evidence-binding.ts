import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {ProtocolError} from '@personal-agent/contracts';
import type {FactVersion, MemoryQueryPort, MemoryReadContext} from '@personal-agent/memory';
import type {NodeInput, NodeRef, NodeVersion} from '@personal-agent/goals';
import {toolArgumentsDigest} from '@personal-agent/tool-gateway';
import type {TaskRuntime} from '../index.js';
import type {LocalRepairBinding, LocalRepairHostOptions} from './local-repair.js';
import type {SqliteFactProjectionHost} from './sqlite-fact-projection.js';
import type {CompetitionFactHost, TrustedPublicSource} from './competition-fact-host.js';

const SOURCE_TOOL = 'workspace.read_text';
const SOURCE_VERSION = '1.0.0';
const BINDING_VERSION = 'competition-public-source-v1';
const MAX_SOURCE_BYTES = 256 * 1024;
const CHECKPOINT_PREFIX = 'competition-public-source:';

export interface CompetitionEvidenceOptions {
  /** One explicitly approved public fixture path, relative to the trusted workspace root. */
  readonly allowedPath: string;
  /** Host-owned bounded read; it must apply the same workspace path and privacy policy. */
  readonly readSourceBytes: (path: string) => Uint8Array;
  /** Trusted parser for the particular public source format. */
  readonly interpretSource: (content: string) => {readonly line: number; readonly summary: string};
  /** Shared with local repair and other writes to this source. */
  readonly withSourceLock: <T>(work: () => Promise<T>) => Promise<T>;
}

export interface PublicBaseline {
  readonly goal: {readonly id: string; readonly summary: string};
  readonly decision: {readonly id: string; readonly summary: string};
  readonly plan: {readonly id: string; readonly summary: string};
}

export interface ConfirmedPublicReadRequest {
  readonly sourceTaskId: string;
  readonly proposalId: string;
  /** Must equal the confirmed ToolGateway result passed to export.project. */
  readonly result: unknown;
  readonly source: TrustedPublicSource;
  readonly baseline: PublicBaseline;
}

export interface PublicEvidenceBinding {
  readonly sourceTaskId: string;
  readonly evidenceId: string;
  readonly proposalId: string;
  readonly source: TrustedPublicSource;
  readonly baseline: PublicBaseline;
  readonly fact: FactVersion;
  readonly binding: LocalRepairBinding;
  /** Scope-bound durable completion; consumers fetch its exact report from the Fact host. */
  readonly impactBatchToken: string;
}

export interface CompetitionEvidenceBinder {
  bindConfirmedRead(request: ConfirmedPublicReadRequest, context: MemoryReadContext): Promise<PublicEvidenceBinding>;
  resolveBinding(input: {sourceTaskId: string; evidenceId: string}): LocalRepairBinding;
  matchesBinding(input: {sourceTaskId: string; evidenceId: string; result: unknown;
    fact: FactVersion; node: NodeVersion; binding: LocalRepairBinding}): boolean;
}

function denied(): never { throw new ProtocolError('UNAUTHORIZED', 'Confirmed public source binding denied'); }
function active(context: MemoryReadContext): void {
  if (context.signal.aborted) throw new ProtocolError('CANCELLED', 'Public source binding cancelled');
  if (!Number.isFinite(Date.parse(context.deadline)) || Date.now() >= Date.parse(context.deadline)) {
    throw new ProtocolError('TIMEOUT', 'Public source binding deadline expired');
  }
}
function digest(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}
function sameRef(a: NodeRef, b: NodeRef): boolean {
  return a.id === b.id && a.revision === b.revision;
}
function confirmedContent(result: unknown, path: string, bytes: Uint8Array): string {
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || !isDeepStrictEqual(Object.keys(result).sort(), ['byteLength', 'content', 'encoding', 'path'])) denied();
  const value = result as {path?: unknown; encoding?: unknown; byteLength?: unknown; content?: unknown};
  let content: string;
  try { content = new TextDecoder('utf-8', {fatal: true}).decode(bytes); } catch { return denied(); }
  if (value.path !== path || value.encoding !== 'utf-8'
    || value.byteLength !== bytes.byteLength || value.content !== content) denied();
  return content;
}
function readCheckedSource(options: CompetitionEvidenceOptions, source: TrustedPublicSource,
  result: unknown): void {
  if (source.path !== options.allowedPath || !source.vaultId?.trim() || !source.factId?.trim()
    || !/^[0-9a-f]{64}$/.test(source.sourceRevision)) denied();
  let bytes: Uint8Array;
  try { bytes = options.readSourceBytes(source.path); } catch { return denied(); }
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_SOURCE_BYTES) denied();
  const content = confirmedContent(result, source.path, bytes);
  if (digest(bytes) !== source.sourceRevision) denied();
  let parsed: ReturnType<CompetitionEvidenceOptions['interpretSource']>;
  try { parsed = options.interpretSource(content); } catch { return denied(); }
  if (parsed.line !== source.line || parsed.summary !== source.summary) denied();
}
function baselineNodes(oldFact: FactVersion, oldNode: NodeVersion,
  baseline: PublicBaseline): NodeInput[] {
  const entries = [baseline.goal, baseline.decision, baseline.plan];
  if (entries.some(item => typeof item?.id !== 'string' || !item.id.trim()
    || typeof item.summary !== 'string' || !item.summary.trim())
    || new Set([oldNode.id, ...entries.map(item => item.id)]).size !== 4) denied();
  const common = {sourceRef: oldFact.sourceRef, validFrom: oldFact.validFrom,
    validUntil: oldFact.validUntil, sensitivity: 'public' as const, state: 'active' as const,
    reason: 'Trusted public baseline for ' + oldFact.ref.id + '@' + oldFact.ref.revision};
  const oldRef = {id: oldNode.id, revision: oldNode.revision};
  return [
    {...common, ...baseline.goal, kind: 'goal', dependencies: [oldRef]},
    {...common, ...baseline.decision, kind: 'decision',
      dependencies: [{id: baseline.goal.id, revision: 1}]},
    {...common, ...baseline.plan, kind: 'plan',
      dependencies: [{id: baseline.decision.id, revision: 1}, oldRef]},
  ];
}

export function createCompetitionEvidenceBinder(input: {
  runtime: TaskRuntime;
  memory: MemoryQueryPort;
  projection: SqliteFactProjectionHost;
  graphNamespace: string;
  readPublicSourceHead: CompetitionFactHost['readPublicSourceHead'];
  recordPublicSource: CompetitionFactHost['recordPublicSource'];
  options: CompetitionEvidenceOptions;
}): CompetitionEvidenceBinder {
  const {runtime, memory, projection, graphNamespace, options} = input;
  if (!options.allowedPath?.trim() || typeof options.readSourceBytes !== 'function'
    || typeof options.interpretSource !== 'function' || typeof options.withSourceLock !== 'function') {
    throw new ProtocolError('INVALID_ARGUMENT', 'Invalid public Evidence binding configuration');
  }
  const stored = (sourceTaskId: string, evidenceId: string): PublicEvidenceBinding | undefined =>
    runtime.loadCheckpoint(sourceTaskId, CHECKPOINT_PREFIX + evidenceId) as PublicEvidenceBinding | undefined;
  return Object.freeze({
    bindConfirmedRead: (request: ConfirmedPublicReadRequest, context: MemoryReadContext) =>
      options.withSourceLock(async () => {
        active(context);
        const task = runtime.getTask(request.sourceTaskId);
        const loop = runtime.loadCheckpoint(request.sourceTaskId, 'competition-loop') as
          {step?: unknown; pending?: {proposalId?: unknown; toolName?: unknown;
            toolVersion?: unknown; arguments?: unknown}} | undefined;
        const pending = loop?.pending;
        if (task.state !== 'running' || !Number.isSafeInteger(loop?.step)
          || (loop!.step as number) < 0 || pending?.proposalId !== request.proposalId
          || pending.toolName !== SOURCE_TOOL || pending.toolVersion !== SOURCE_VERSION
          || !isDeepStrictEqual(pending.arguments, {path: options.allowedPath})) denied();
        const evidenceId = `competition-tool-${request.sourceTaskId}-${loop!.step}`;
        const record = runtime.readToolExecutions(request.sourceTaskId)
          .find(item => item.evidenceId === evidenceId);
        const args = {path: options.allowedPath};
        if (!record || record.taskId !== request.sourceTaskId || record.toolName !== SOURCE_TOOL
          || record.toolVersion !== SOURCE_VERSION || record.state !== 'confirmed'
          || record.policyDecision !== 'allow' || !record.executionStarted
          || !runtime.matchesToolExecutionInput(record, {arguments: args, scopeRef: evidenceId})) denied();
        const approval = runtime.getApproval(evidenceId);
        if (approval.state !== 'allowed' || approval.taskId !== request.sourceTaskId
          || approval.toolName !== SOURCE_TOOL
          || approval.argumentsDigest !== toolArgumentsDigest(args)) denied();
        const saved = runtime.loadCheckpoint(request.sourceTaskId, 'tool-result-' + evidenceId) as
          {result?: unknown} | undefined;
        if (!saved || !Object.hasOwn(saved, 'result')
          || !isDeepStrictEqual(saved.result, request.result)) denied();
        readCheckedSource(options, request.source, saved.result);
        const prior = stored(request.sourceTaskId, evidenceId);
        if (prior) {
          if (prior.sourceTaskId !== request.sourceTaskId || prior.evidenceId !== evidenceId
            || prior.proposalId !== request.proposalId
            || !isDeepStrictEqual(prior.source, request.source)
            || !isDeepStrictEqual(prior.baseline, request.baseline)) denied();
          return structuredClone(prior);
        }
        const sourceKey = {vaultId: request.source.vaultId, path: request.source.path,
          factId: request.source.factId};
        const expected = request.source.expectedFactRevision;
        const head = input.readPublicSourceHead(sourceKey);
        if (expected === null || (head !== expected && head !== expected + 1)) denied();
        const oldFact = await memory.getVersion({fact: {id: request.source.factId,
          revision: expected}, ...context});
        active(context);
        if (oldFact.state !== 'active' || oldFact.sensitivity !== 'public'
          || oldFact.ref.id !== request.source.factId
          || oldFact.ref.revision !== expected
          || !oldFact.sourceRef.startsWith(`${sourceKey.vaultId}/${sourceKey.path}#L`)) denied();
        const store = runtime.bindCoordinationStore(graphNamespace);
        const before = store.read();
        const oldNode = before.history.findLast(item => item.kind === 'fact'
          && item.sourceRef === oldFact.sourceRef && item.summary === oldFact.summary
          && item.reason === `Projected from immutable Memory fact ${oldFact.ref.id}@${oldFact.ref.revision}`);
        if (!oldNode || (head === expected
          && before.history.findLast(item => item.id === oldNode.id)?.revision !== oldNode.revision)) denied();
        const nodes = baselineNodes(oldFact, oldNode, request.baseline);
        const existing = nodes.map(item => before.history.findLast(version => version.id === item.id));
        if (existing.every(item => item === undefined)) store.appendBatch(before.revision, nodes);
        else if (!existing.every((item, index) => {
          if (!item || item.revision !== 1) return false;
          const {revision: _revision, graphRevision: _graphRevision, ...input} = item;
          return isDeepStrictEqual(input, nodes[index]);
        })) denied();
        const baselineGraphRevision = store.read().revision;
        active(context);
        const written = input.recordPublicSource(request.source, context);
        if (written.fact.ref.revision !== expected + 1) denied();
        const drained = await projection.drain({...context, limit: 100, maxBatches: 100});
        active(context);
        if (!drained.atWatermark) throw new ProtocolError('RESULT_UNKNOWN', 'Public Fact projection needs recovery');
        const graph = store.read();
        const fact = written.fact;
        const node = graph.history.findLast(item => item.kind === 'fact'
          && item.sourceRef === fact.sourceRef && item.summary === fact.summary
          && item.reason === `Projected from immutable Memory fact ${fact.ref.id}@${fact.ref.revision}`);
        if (!node || graph.history.findLast(item => item.id === node.id)?.revision !== node.revision) denied();
        projection.processImpacts({...context, at: new Date().toISOString(), limit: 100});
        const impactReceipt = projection.listImpactReceipts({
          afterGraphRevision: baselineGraphRevision, limit: 100,
        }).find(item => item.projection.links.some(link =>
          link.fact.id === fact.ref.id && link.fact.revision === fact.ref.revision
          && link.node.id === node.id && link.node.revision === node.revision));
        const completion = impactReceipt
          && projection.readCompletedImpact(impactReceipt.projection.batchToken);
        if (!completion || completion.report.graphRevision !== impactReceipt!.projection.graphRevision
          || completion.report.items.find(item => item.node.id === request.baseline.plan.id
            && item.node.revision === 1)?.action !== 'RECHECK') {
          throw new ProtocolError('RESULT_UNKNOWN', 'Public Fact impact requires recovery');
        }
        const decisionRef = {id: request.baseline.decision.id, revision: 1};
        const binding: LocalRepairBinding = {fact: fact.ref,
          node: {id: node.id, revision: node.revision}, graphRevision: graph.revision,
          allowedTargets: [{id: request.baseline.plan.id, revision: 1}],
          allowedDependencies: [decisionRef, {id: node.id, revision: node.revision}]};
        const receipt: PublicEvidenceBinding = {sourceTaskId: request.sourceTaskId,
          evidenceId, proposalId: request.proposalId, source: structuredClone(request.source),
          baseline: structuredClone(request.baseline), fact, binding,
          impactBatchToken: completion.batchToken};
        active(context);
        runtime.saveCheckpointOnce(request.sourceTaskId, CHECKPOINT_PREFIX + evidenceId, receipt);
        return structuredClone(receipt);
      }),
    resolveBinding: ({sourceTaskId, evidenceId}: {sourceTaskId: string; evidenceId: string}) => {
      const receipt = stored(sourceTaskId, evidenceId);
      if (!receipt || receipt.sourceTaskId !== sourceTaskId || receipt.evidenceId !== evidenceId) denied();
      return structuredClone(receipt.binding);
    },
    matchesBinding: ({sourceTaskId, evidenceId, result, fact, node, binding}: {
      sourceTaskId: string; evidenceId: string; result: unknown; fact: FactVersion;
      node: NodeVersion; binding: LocalRepairBinding;
    }) => {
      const receipt = stored(sourceTaskId, evidenceId);
      if (!receipt || receipt.sourceTaskId !== sourceTaskId || receipt.evidenceId !== evidenceId
        || !isDeepStrictEqual(receipt.binding, binding)
        || !isDeepStrictEqual(receipt.fact, fact) || !sameRef(receipt.binding.node, node)
        || node.sourceRef !== fact.sourceRef || node.summary !== fact.summary) return false;
      try { readCheckedSource(options, receipt.source, result); return true; }
      catch { return false; }
    },
  });
}

/** Construct before RuntimeApplication; delegates only after the trusted Fact host is installed. */
export function createPublicFactRepairHostProxy(input: {
  getHost: () => CompetitionFactHost;
  graphNamespace: string;
  sourcePath: string;
}): LocalRepairHostOptions {
  const host = () => input.getHost();
  return {
    graphNamespace: input.graphNamespace, bindingVersion: BINDING_VERSION,
    sourceTool: {name: SOURCE_TOOL, version: SOURCE_VERSION, arguments: {path: input.sourcePath}},
    memory: {listCurrent: request => host().publicMemory.listCurrent(request),
      listHistory: request => host().publicMemory.listHistory(request),
      getVersion: request => host().publicMemory.getVersion(request)},
    withSourceLock: work => host().withSourceLock(work),
    resolveBinding: request => host().resolveEvidenceBinding(request),
    matchesSource: ({result, fact, node}) => Boolean(result && fact.sourceRef === node.sourceRef
      && fact.summary === node.summary),
    matchesPublicSourceBinding: request => host().matchesEvidenceBinding(request),
  };
}
