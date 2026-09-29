import {createHash} from 'node:crypto';
import {realpathSync, statSync} from 'node:fs';
import {lstat, readFile, unlink} from 'node:fs/promises';
import {isAbsolute, relative, resolve, sep} from 'node:path';
import {ProtocolError} from '@personal-agent/contracts';
import {checkedSource} from './patch-stage.js';

const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_RELATIVE_PATH_LENGTH = 1024;
const WINDOWS_RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/iu;

export interface WorkspacePatchReconcileOptions {
  /** Trusted workspace root used when the apply marker was created. */
  rootPath: string;
  /** Trusted, access-controlled directory outside the workspace. */
  recoveryRootPath: string;
  /** Canonical relative source path used by the original preview. */
  relativePath: string;
  /** Optional trusted process identity check. The default only checks OS liveness. */
  isProcessAlive?: (pid: number) => boolean | Promise<boolean>;
}

export type WorkspacePatchReconciliationResult =
  | {path: string; state: 'clear'}
  | {path: string; state: 'in_progress'; pid: number; beforeSha256: string; afterSha256: string}
  | {path: string; state: 'reconciled'; outcome: 'applied' | 'not_applied' | 'unknown';
    beforeSha256: string; afterSha256: string; currentSha256: string};

interface InFlightMarker {
  pid: number | null;
  beforeSha256: string;
  afterSha256: string;
}

interface FileIdentity {
  dev: number | bigint;
  ino: number | bigint;
  size: number | bigint;
  mtimeMs: number | bigint;
  ctimeMs: number | bigint;
}

function invalid(message: string): never {
  throw new ProtocolError('INVALID_ARGUMENT', message);
}

function unknown(message: string): never {
  throw new ProtocolError('RESULT_UNKNOWN', message);
}

function canonicalRoot(path: string, label: string): string {
  if (typeof path !== 'string' || !path.trim()) invalid(`${label} must not be empty`);
  try {
    const root = realpathSync.native(path);
    if (!statSync(root).isDirectory()) invalid(`${label} must identify a directory`);
    return root;
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    invalid(`${label} is not an accessible directory`);
  }
}

function canonicalRelativePath(value: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_RELATIVE_PATH_LENGTH
    || value.includes('\0') || value.includes('\\') || value.startsWith('/') || value.includes(':')) {
    invalid('Workspace patch relativePath is not canonical');
  }
  const segments = value.split('/');
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..'
    || /[. ]$/u.test(segment)
    || WINDOWS_RESERVED_NAME.test(segment.split('.')[0] ?? segment))) {
    invalid('Workspace patch relativePath is not canonical');
  }
  return segments.join('/');
}

function inside(root: string, candidate: string): boolean {
  const part = relative(root, candidate);
  return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

function atOrWithin(root: string, candidate: string): boolean {
  const part = relative(root, candidate);
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}

function sourceKey(root: string, relativePath: string): string {
  return createHash('sha256').update(`${root}\n${relativePath}`, 'utf8').digest('hex').slice(0, 32);
}

/**
 * Returns the marker location used by the apply helper. Both callers use the
 * same canonical root/path tuple so a reconciler cannot accidentally clear a
 * marker belonging to a different workspace source.
 */
export function workspacePatchInflightPath(
  rootPath: string,
  recoveryRootPath: string,
  relativePath: string,
): string {
  const root = canonicalRoot(rootPath, 'Workspace rootPath');
  const recoveryRoot = canonicalRoot(recoveryRootPath, 'Recovery rootPath');
  const path = canonicalRelativePath(relativePath);
  return workspacePatchInflightPathFromCanonical(root, recoveryRoot, path);
}

/** Internal companion for an apply tool that already captured canonical roots. */
export function workspacePatchInflightPathFromCanonical(
  root: string,
  recoveryRoot: string,
  relativePath: string,
): string {
  const path = canonicalRelativePath(relativePath);
  const marker = resolve(recoveryRoot, `${sourceKey(root, path)}.inflight`);
  if (atOrWithin(root, recoveryRoot) || atOrWithin(recoveryRoot, root) || !inside(recoveryRoot, marker)) {
    invalid('Patch recovery directory must be outside the workspace');
  }
  return marker;
}

function parseMarker(value: string): InFlightMarker {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { unknown('Workspace patch in-flight record is invalid'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    unknown('Workspace patch in-flight record is invalid');
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const pid = record.pid;
  if (keys.length !== 3 || keys[0] !== 'afterSha256' || keys[1] !== 'beforeSha256' || keys[2] !== 'pid'
    || (pid !== null && (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1))
    || typeof record.beforeSha256 !== 'string' || !SHA256.test(record.beforeSha256)
    || typeof record.afterSha256 !== 'string' || !SHA256.test(record.afterSha256)) {
    unknown('Workspace patch in-flight record is invalid');
  }
  return {
    pid: pid as number | null,
    beforeSha256: record.beforeSha256 as string,
    afterSha256: record.afterSha256 as string,
  };
}

function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as {code?: unknown}).code) : undefined;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw new ProtocolError('RESULT_UNKNOWN', 'Workspace patch process liveness is unconfirmed');
  }
}

async function readCurrentSource(root: string, path: string): Promise<{sha256: string; identity: FileIdentity}> {
  let before: Awaited<ReturnType<typeof checkedSource>>;
  try { before = await checkedSource(root, path); }
  catch (error) { if (error instanceof ProtocolError) throw error; unknown('Workspace patch source could not be checked'); }
  const sourcePath = resolve(root, ...path.split('/'));
  let bytes: Buffer;
  try { bytes = await readFile(sourcePath); }
  catch { unknown('Workspace patch source could not be read back'); }
  let after: Awaited<ReturnType<typeof checkedSource>>;
  try { after = await checkedSource(root, path); }
  catch (error) { if (error instanceof ProtocolError) throw error; unknown('Workspace patch source changed during reconciliation'); }
  const beforeIdentity: FileIdentity = {
    dev: before.dev, ino: before.ino, size: before.size, mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs,
  };
  const afterIdentity: FileIdentity = {
    dev: after.dev, ino: after.ino, size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs,
  };
  if (!sameFile(beforeIdentity, afterIdentity) || bytes.length !== after.size) {
    unknown('Workspace patch source changed during reconciliation');
  }
  return {sha256: createHash('sha256').update(bytes).digest('hex'), identity: afterIdentity};
}

/**
 * Reconciles one stale apply marker after a trusted host confirms the helper
 * exited. It never starts, stops, retries, or rolls back a process. A marker
 * is removed only after process exit and a readback of the protected source;
 * an unexpected source hash is reported as `unknown` and remains non-success.
 */
export async function reconcileWorkspacePatchApply(
  options: WorkspacePatchReconcileOptions,
): Promise<WorkspacePatchReconciliationResult> {
  if (!options || typeof options !== 'object') invalid('Workspace patch reconciliation options are required');
  const path = canonicalRelativePath(options?.relativePath);
  const root = canonicalRoot(options.rootPath, 'Workspace rootPath');
  const recoveryRoot = canonicalRoot(options.recoveryRootPath, 'Recovery rootPath');
  if (atOrWithin(root, recoveryRoot) || atOrWithin(recoveryRoot, root)) {
    invalid('Patch recovery directory must be outside the workspace');
  }
  // checkedSource performs the final canonical containment and regular-file checks.
  const markerPath = resolve(recoveryRoot, `${sourceKey(root, path)}.inflight`);
  let markerStat: Awaited<ReturnType<typeof lstat>>;
  let markerBytes: string;
  try {
    markerStat = await lstat(markerPath);
    if (!markerStat.isFile() || markerStat.nlink !== 1) unknown('Workspace patch in-flight record is not a regular file');
    markerBytes = await readFile(markerPath, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return {path, state: 'clear'};
    if (error instanceof ProtocolError) throw error;
    unknown('Workspace patch in-flight record could not be read');
  }
  const marker = parseMarker(markerBytes!);
  if (marker.pid === null) unknown('Workspace patch helper exit is unconfirmed');
  const isAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  let alive: boolean;
  try {
    const value = await isAlive(marker.pid);
    if (typeof value !== 'boolean') unknown('Workspace patch helper exit is unconfirmed');
    alive = value;
  }
  catch { unknown('Workspace patch helper exit is unconfirmed'); }
  if (alive!) {
    return {path, state: 'in_progress', pid: marker.pid, beforeSha256: marker.beforeSha256, afterSha256: marker.afterSha256};
  }

  const current = await readCurrentSource(root, path);
  const outcome = current.sha256 === marker.afterSha256 ? 'applied'
    : current.sha256 === marker.beforeSha256 ? 'not_applied' : 'unknown';
  let currentMarker: Awaited<ReturnType<typeof lstat>>;
  try { currentMarker = await lstat(markerPath); }
  catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return {path, state: 'reconciled', outcome, beforeSha256: marker.beforeSha256,
        afterSha256: marker.afterSha256, currentSha256: current.sha256};
    }
    unknown('Workspace patch in-flight record changed during reconciliation');
  }
  const markerIdentity: FileIdentity = {
    dev: markerStat!.dev, ino: markerStat!.ino, size: markerStat!.size,
    mtimeMs: markerStat!.mtimeMs, ctimeMs: markerStat!.ctimeMs,
  };
  const currentMarkerIdentity: FileIdentity = {
    dev: currentMarker!.dev, ino: currentMarker!.ino, size: currentMarker!.size,
    mtimeMs: currentMarker!.mtimeMs, ctimeMs: currentMarker!.ctimeMs,
  };
  if (!sameFile(markerIdentity, currentMarkerIdentity)) unknown('Workspace patch in-flight record changed during reconciliation');
  try { await unlink(markerPath); }
  catch (error) {
    if (errorCode(error) !== 'ENOENT') unknown('Workspace patch in-flight record could not be cleared');
  }
  if (await lstat(markerPath).then(() => true, error => errorCode(error) !== 'ENOENT')) {
    unknown('Workspace patch in-flight record remains after reconciliation');
  }
  return {path, state: 'reconciled', outcome, beforeSha256: marker.beforeSha256,
    afterSha256: marker.afterSha256, currentSha256: current.sha256};
}
