import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ProtocolError} from '@personal-agent/contracts';
import type {ToolContext} from '@personal-agent/contracts';
import type {KnowledgeNotePatch} from './write.js';

/** Only the trusted Runtime may construct this after accepting its ORIGINAL persistent execution record.
 * It is not a renderer DTO, a model tool, a new grant, or permission to retry the original write.
 */
export interface KnowledgeWriteFinalizationAcceptance {
  taskId: string; runId: string;
  toolName: 'knowledge.apply_note_patch'; toolVersion: '1.0.0';
  argumentsDigest: string; operationId: string;
  originalInput: KnowledgeNotePatch;
  outcome: 'applied' | 'not_applied'; currentSha256: string;
  executionRecordId: string; readbackEvidenceRefs: readonly string[];
}
export interface KnowledgeWriteFinalizationResult {
  state: 'finalized' | 'still_unknown'; operationId: string;
  outcome?: 'applied' | 'not_applied'; currentSha256?: string;
}
const helperPath = fileURLToPath(new URL('../scripts/locked-finalize.ps1', import.meta.url));

function active(context: Pick<ToolContext, 'signal' | 'deadline'>): void {
  if (context.signal.aborted) throw new ProtocolError('CANCELLED', 'Knowledge finalization cancelled');
  if (!Number.isFinite(Date.parse(context.deadline)) || Date.parse(context.deadline) <= Date.now()) {
    throw new ProtocolError('TIMEOUT', 'Knowledge finalization expired');
  }
}
async function invoke(executable: string, request: unknown,
  context: Pick<ToolContext, 'signal' | 'deadline'>): Promise<KnowledgeWriteFinalizationResult> {
  active(context);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', helperPath], {
      shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: {SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', TEMP: process.env.TEMP ?? '', TMP: process.env.TMP ?? ''}
    });
    let output = '', bytes = 0, stopped = false;
    const timer = setTimeout(stop, Math.max(1, Math.min(Date.parse(context.deadline) - Date.now(), 2147483647)));
    function stop() {stopped = true; try {child.kill('SIGKILL');} catch { /* close/error settles */ }}
    const cleanup = () => {clearTimeout(timer); context.signal.removeEventListener('abort', stop);};
    context.signal.addEventListener('abort', stop, {once: true});
    child.stdin.on('error', stop);
    child.stdout.on('data', (chunk: Buffer) => {bytes += chunk.length; if (bytes > 8192) stop(); else output += chunk.toString('utf8');});
    child.stderr.on('data', (chunk: Buffer) => {bytes += chunk.length; if (bytes > 8192) stop();});
    child.once('error', () => {cleanup(); reject(new ProtocolError('RESULT_UNKNOWN', 'Knowledge finalization helper unavailable'));});
    child.once('close', code => {
      cleanup();
      if (stopped || code !== 0) return reject(new ProtocolError('RESULT_UNKNOWN', 'Knowledge finalization requires readback'));
      try {
        active(context);
        const result = JSON.parse(output) as KnowledgeWriteFinalizationResult;
        if (!result || !['finalized', 'still_unknown'].includes(result.state)
          || typeof result.operationId !== 'string'
          || (result.state === 'finalized' && (!['applied', 'not_applied'].includes(result.outcome ?? '')
            || !/^[a-f0-9]{64}$/.test(result.currentSha256 ?? '')))) throw Error();
        resolve(result);
      } catch {reject(new ProtocolError('RESULT_UNKNOWN', 'Knowledge finalization returned no accepted receipt'));}
    });
    if (context.signal.aborted) stop();
    else child.stdin.end(JSON.stringify(request));
  });
}

export async function finalizeControlledVaultWrite(options: {
  rootPath: string; recoveryRootPath: string; powerShellPath: string;
  allowedNotePaths: ReadonlySet<string>; bindingCurrent(): boolean;
  digest(value: unknown): string; hash(value: string): string;
}, accepted: KnowledgeWriteFinalizationAcceptance,
context: Pick<ToolContext, 'signal' | 'deadline'>): Promise<KnowledgeWriteFinalizationResult> {
  active(context);
  if (!options.bindingCurrent()) throw new ProtocolError('SCOPE_DENIED', 'Knowledge binding revoked');
  const keys = ['taskId', 'runId', 'toolName', 'toolVersion', 'argumentsDigest', 'operationId', 'originalInput',
    'outcome', 'currentSha256', 'executionRecordId', 'readbackEvidenceRefs'];
  const opaque = (value: unknown): boolean => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f]/.test(value);
  if (!accepted || Object.keys(accepted).some(key => !keys.includes(key))
    || !opaque(accepted.taskId) || !opaque(accepted.runId) || !opaque(accepted.executionRecordId)
    || accepted.toolName !== 'knowledge.apply_note_patch' || accepted.toolVersion !== '1.0.0'
    || !['applied', 'not_applied'].includes(accepted.outcome)
    || !/^[a-f0-9]{64}$/.test(accepted.currentSha256)
    || !Array.isArray(accepted.readbackEvidenceRefs) || !accepted.readbackEvidenceRefs.length
    || accepted.readbackEvidenceRefs.length > 32 || accepted.readbackEvidenceRefs.some(value => !opaque(value))
    || !accepted.originalInput || !options.allowedNotePaths.has(accepted.originalInput.path)
    || accepted.argumentsDigest !== options.digest(accepted.originalInput)
    || accepted.operationId !== options.hash(accepted.taskId + '\n' + accepted.runId)) {
    throw new ProtocolError('INVALID_ARGUMENT', 'Invalid original knowledge execution acceptance');
  }
  let record: {sourceId: string; configRevision: number; path: string; taskId: string; runId: string;
    argumentsDigest: string; operationId: string; beforeSha256: string; afterSha256: string};
  const operationPath = join(options.recoveryRootPath, accepted.operationId + '.knowledge-operation.json');
  try {record = JSON.parse(readFileSync(operationPath, 'utf8'));}
  catch {return {state: 'still_unknown', operationId: accepted.operationId};}
  if (record.taskId !== accepted.taskId || record.runId !== accepted.runId || record.operationId !== accepted.operationId
    || record.argumentsDigest !== accepted.argumentsDigest || record.sourceId !== accepted.originalInput.sourceId
    || record.configRevision !== accepted.originalInput.configRevision || record.path !== accepted.originalInput.path
    || record.beforeSha256 !== accepted.originalInput.expectedSha256
    || accepted.currentSha256 !== (accepted.outcome === 'applied' ? record.afterSha256 : record.beforeSha256)) {
    return {state: 'still_unknown', operationId: accepted.operationId};
  }
  const sourceKey = options.hash(options.rootPath + '\n' + record.path);
  const request = {rootPath: options.rootPath, sourcePath: join(options.rootPath, ...record.path.split('/')),
    operationPath, finalizationPath: join(options.recoveryRootPath, accepted.operationId + '.knowledge-finalization.json'),
    knowledgeMarker: join(options.recoveryRootPath, sourceKey + '.knowledge-pending'),
    sharedMarker: join(options.recoveryRootPath, sourceKey.slice(0, 32) + '.inflight'),
    accepted, beforeSha256: record.beforeSha256, afterSha256: record.afterSha256, deadline: context.deadline};
  active(context);
  if (!options.bindingCurrent()) throw new ProtocolError('SCOPE_DENIED', 'Knowledge binding revoked');
  const result = await invoke(options.powerShellPath, request, context);
  active(context);
  if (!options.bindingCurrent()) throw new ProtocolError('SCOPE_DENIED', 'Knowledge binding revoked');
  if (result.operationId !== accepted.operationId
    || result.state === 'finalized' && (result.outcome !== accepted.outcome || result.currentSha256 !== accepted.currentSha256)) {
    throw new ProtocolError('RESULT_UNKNOWN', 'Knowledge finalization identity mismatch');
  }
  return result;
}
