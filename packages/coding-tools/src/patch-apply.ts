import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {realpathSync, statSync} from 'node:fs';
import {isAbsolute, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ProtocolError} from '@personal-agent/contracts';
import type {RegisteredTool, ToolContext, ToolDescriptor} from '@personal-agent/contracts';
import type {WorkspacePatchPreviewResult} from './patch-preview.js';
import {checkedSource} from './patch-stage.js';

export const WORKSPACE_PATCH_APPLY_TOOL_NAME = 'workspace.apply_text_patch';
export const WORKSPACE_PATCH_APPLY_TOOL_VERSION = '1.0.0';
export const WORKSPACE_PATCH_APPLY_SCOPE = 'workspace:apply';

const helperPath = fileURLToPath(new URL('../scripts/locked-apply.ps1', import.meta.url));
const MAX_HELPER_OUTPUT_BYTES = 8192;
const STOP_GRACE_MS = 2000;

export interface WorkspacePatchApplyResult {
  path: string;
  beforeSha256: string;
  afterSha256: string;
  byteLength: number;
  changed: boolean;
  applied: boolean;
  recoveryId?: string;
}

export interface WorkspacePatchApplyHostOptions {
  /** Pre-created trusted, access-controlled directory outside the user workspace. */
  recoveryRootPath: string;
  /** Absolute path to the trusted Windows PowerShell executable. */
  powerShellPath: string;
}

interface ApplyOptions extends WorkspacePatchApplyHostOptions {
  rootPath: string;
  preview: RegisteredTool;
  now: () => number;
}

interface HelperRequest {
  rootPath: string;
  sourcePath: string;
  backupPath: string;
  beforeSha256: string;
  afterSha256: string;
  afterBase64: string;
}

interface HelperResponse {
  state: 'applied' | 'conflict' | 'unknown';
  backupRetained?: boolean;
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function atOrWithin(root: string, candidate: string): boolean {
  const part = relative(root, candidate);
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}

function check(context: ToolContext, now: () => number): number {
  if (!context.scopes.includes('workspace:read') || !context.scopes.includes('workspace:write')
    || !context.scopes.includes(WORKSPACE_PATCH_APPLY_SCOPE)) {
    throw new ProtocolError('SCOPE_DENIED', 'Workspace patch apply requires read, write and apply scopes');
  }
  if (context.signal.aborted) throw new ProtocolError('CANCELLED', 'Workspace patch apply was cancelled');
  const deadline = Date.parse(context.deadline);
  const remaining = deadline - now();
  if (!Number.isFinite(deadline) || remaining <= 0) {
    throw new ProtocolError('TIMEOUT', 'Workspace patch apply deadline expired');
  }
  return remaining;
}

async function invokeHelper(
  executable: string,
  script: string,
  request: HelperRequest,
  context: ToolContext,
  now: () => number,
): Promise<HelperResponse> {
  const remaining = check(context, now);
  return new Promise<HelperResponse>((resolveResult, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, ['-NoProfile', '-NonInteractive', '-File', script], {
        cwd: request.rootPath,
        env: {
          SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
          TEMP: process.env.TEMP ?? '',
          TMP: process.env.TMP ?? '',
        },
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      reject(new ProtocolError('RESULT_UNKNOWN', 'Workspace patch helper could not start'));
      return;
    }
    let finished = false;
    let stopReason: ProtocolError | undefined;
    let outputBytes = 0;
    const chunks: Buffer[] = [];
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: ProtocolError, result?: HelperResponse): void => {
      if (finished) return;
      finished = true;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (stopTimer) clearTimeout(stopTimer);
      context.signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolveResult(result!);
    };
    const stop = (error: ProtocolError): void => {
      if (finished || stopReason) return;
      stopReason = error;
      try { child.kill('SIGKILL'); } catch { /* finish on close or grace timeout */ }
      stopTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(new ProtocolError('RESULT_UNKNOWN', 'Workspace patch helper stop is unconfirmed'));
      }, STOP_GRACE_MS);
    };
    const onAbort = (): void => stop(new ProtocolError('RESULT_UNKNOWN', 'Workspace patch apply was interrupted'));
    child.stdout?.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_HELPER_OUTPUT_BYTES) stop(new ProtocolError('RESULT_UNKNOWN', 'Workspace patch helper output exceeded limit'));
      else chunks.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_HELPER_OUTPUT_BYTES) stop(new ProtocolError('RESULT_UNKNOWN', 'Workspace patch helper output exceeded limit'));
    });
    child.stdin?.on('error', () => stop(new ProtocolError('RESULT_UNKNOWN', 'Workspace patch helper input failed')));
    child.once('error', () => finish(new ProtocolError('RESULT_UNKNOWN', 'Workspace patch helper could not start')));
    child.once('close', (code: number | null) => {
      if (stopReason) return finish(stopReason);
      if (code !== 0) return finish(new ProtocolError('RESULT_UNKNOWN', 'Workspace patch helper did not complete'));
      try {
        const response = JSON.parse(Buffer.concat(chunks).toString('utf8')) as HelperResponse;
        if (response && (response.state === 'applied' || response.state === 'conflict' || response.state === 'unknown')
          && (response.backupRetained === undefined || typeof response.backupRetained === 'boolean')) {
          finish(undefined, response);
        } else {
          finish(new ProtocolError('RESULT_UNKNOWN', 'Workspace patch helper returned an invalid receipt'));
        }
      } catch {
        finish(new ProtocolError('RESULT_UNKNOWN', 'Workspace patch helper returned an invalid receipt'));
      }
    });
    context.signal.addEventListener('abort', onAbort, {once: true});
    deadlineTimer = setTimeout(() => stop(new ProtocolError('RESULT_UNKNOWN', 'Workspace patch apply deadline expired')), Math.min(remaining, 2_147_483_647));
    child.stdin?.end(JSON.stringify(request));
    if (context.signal.aborted) onAbort();
  });
}

export function createWorkspacePatchApplyToolFromPreview(options: ApplyOptions): RegisteredTool {
  if (process.platform !== 'win32') throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'Locked patch apply requires Windows');
  const root = realpathSync.native(options.rootPath);
  const recoveryRoot = realpathSync.native(options.recoveryRootPath);
  const powerShell = realpathSync.native(options.powerShellPath);
  const script = realpathSync.native(helperPath);
  if (!statSync(root).isDirectory() || !statSync(recoveryRoot).isDirectory()
    || !statSync(powerShell).isFile() || !statSync(script).isFile()
    || atOrWithin(root, recoveryRoot) || atOrWithin(recoveryRoot, root)
    || atOrWithin(root, powerShell) || atOrWithin(root, script)) {
    throw new ProtocolError('INVALID_ARGUMENT', 'Patch apply host paths must be distinct trusted locations');
  }
  const descriptor: ToolDescriptor = {
    name: WORKSPACE_PATCH_APPLY_TOOL_NAME,
    version: WORKSPACE_PATCH_APPLY_TOOL_VERSION,
    inputSchema: options.preview.descriptor.inputSchema,
    outputSchema: {
      type: 'object',
      required: ['path', 'beforeSha256', 'afterSha256', 'byteLength', 'changed', 'applied'],
      additionalProperties: false,
      properties: {
        path: {type: 'string'},
        beforeSha256: {type: 'string', pattern: '^[a-f0-9]{64}$'},
        afterSha256: {type: 'string', pattern: '^[a-f0-9]{64}$'},
        byteLength: {type: 'integer', minimum: 0},
        changed: {type: 'boolean'},
        applied: {type: 'boolean'},
        recoveryId: {type: 'string'},
      },
    },
    sideEffect: 'local_write',
    requiredScopes: ['workspace:read', 'workspace:write', WORKSPACE_PATCH_APPLY_SCOPE],
    idempotencySupport: false,
    recoverySupport: false,
    requiresPresence: false,
  };

  return {
    descriptor,
    execute: async (input: unknown, context: ToolContext): Promise<WorkspacePatchApplyResult> => {
      check(context, options.now);
      const preview = await options.preview.execute(input, context) as WorkspacePatchPreviewResult;
      check(context, options.now);
      await checkedSource(root, preview.path);
      const after = Buffer.from(preview.previewText, 'utf8');
      if (digest(after) !== preview.afterSha256) {
        throw new ProtocolError('RESULT_UNKNOWN', 'Workspace patch candidate digest changed');
      }
      const result: WorkspacePatchApplyResult = {
        path: preview.path,
        beforeSha256: preview.beforeSha256,
        afterSha256: preview.afterSha256,
        byteLength: after.length,
        changed: preview.changed,
        applied: false,
      };
      if (!preview.changed) return result;
      const recoveryId = `${digest(Buffer.from(`${context.taskId}\n${context.runId}`)).slice(0, 32)}-${randomUUID()}.bak`;
      const response = await invokeHelper(powerShell, script, {
        rootPath: root,
        sourcePath: resolve(root, ...preview.path.split('/')),
        backupPath: resolve(recoveryRoot, recoveryId),
        beforeSha256: preview.beforeSha256,
        afterSha256: preview.afterSha256,
        afterBase64: after.toString('base64'),
      }, context, options.now);
      if (response.state === 'conflict') throw new ProtocolError('REVISION_CONFLICT', 'Workspace source changed or is busy');
      if (response.state !== 'applied') throw new ProtocolError('RESULT_UNKNOWN', 'Workspace patch apply requires reconciliation');
      result.applied = true;
      if (response.backupRetained) result.recoveryId = recoveryId;
      return result;
    },
  };
}
