import {createHash, randomUUID} from 'node:crypto';
import {constants as fsConstants, realpathSync, statSync} from 'node:fs';
import {lstat, open, readFile, realpath, unlink} from 'node:fs/promises';
import {isAbsolute, relative, resolve, sep} from 'node:path';
import {ProtocolError} from '@personal-agent/contracts';
import type {RegisteredTool, ToolContext, ToolDescriptor} from '@personal-agent/contracts';
import type {WorkspacePatchPreviewResult} from './patch-preview.js';

export const WORKSPACE_PATCH_STAGE_TOOL_NAME = 'workspace.stage_text_patch';
export const WORKSPACE_PATCH_STAGE_TOOL_VERSION = '1.0.0';
export const WORKSPACE_PATCH_STAGE_SCOPE = 'workspace:write';

export interface WorkspacePatchStageResult {
  path: string;
  stagedPath?: string;
  beforeSha256: string;
  afterSha256: string;
  byteLength: number;
  changed: boolean;
}

interface PatchStageOptions {
  rootPath: string;
  preview: RegisteredTool;
  reader: RegisteredTool;
  now: () => number;
}

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function check(context: ToolContext, now: () => number): void {
  if (!context.scopes.includes(WORKSPACE_PATCH_STAGE_SCOPE)
    || !context.scopes.includes('workspace:read')) {
    throw new ProtocolError('SCOPE_DENIED', 'Workspace patch staging requires read and write scopes');
  }
  if (context.signal.aborted) throw new ProtocolError('CANCELLED', 'Workspace patch staging was cancelled');
  const deadline = Date.parse(context.deadline);
  if (!Number.isFinite(deadline)) throw new ProtocolError('INVALID_ARGUMENT', 'Workspace patch staging deadline is invalid');
  if (deadline <= now()) throw new ProtocolError('TIMEOUT', 'Workspace patch staging deadline expired');
}

function within(root: string, candidate: string): boolean {
  const part = relative(root, candidate);
  return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

function sameFile(left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>): boolean {
  return left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function checkedSource(root: string, relativePath: string): Promise<Awaited<ReturnType<typeof lstat>>> {
  const target = resolve(root, ...relativePath.split('/'));
  if (!within(root, target) || await realpath(root) !== root) {
    throw new ProtocolError('SCOPE_DENIED', 'Workspace patch source escapes the authorized root');
  }
  let current = root;
  for (const segment of relativePath.split('/')) {
    current = resolve(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new ProtocolError('SCOPE_DENIED', 'Workspace patch staging does not follow links');
    if (current === target) {
      if (!info.isFile() || info.nlink !== 1) {
        throw new ProtocolError('SCOPE_DENIED', 'Workspace patch source must be a single-link regular file');
      }
      return info;
    }
    if (!info.isDirectory() || await realpath(current) !== current) {
      throw new ProtocolError('SCOPE_DENIED', 'Workspace patch parent changed during containment check');
    }
  }
  throw new ProtocolError('INVALID_ARGUMENT', 'Workspace patch source path is invalid');
}

export function createWorkspacePatchStageToolFromReader(options: PatchStageOptions): RegisteredTool {
  const root = realpathSync.native(options.rootPath);
  if (!statSync(root).isDirectory()) throw new ProtocolError('INVALID_ARGUMENT', 'Workspace root must be a directory');
  const descriptor: ToolDescriptor = {
    name: WORKSPACE_PATCH_STAGE_TOOL_NAME,
    version: WORKSPACE_PATCH_STAGE_TOOL_VERSION,
    inputSchema: options.preview.descriptor.inputSchema,
    outputSchema: {
      type: 'object',
      required: ['path', 'beforeSha256', 'afterSha256', 'byteLength', 'changed'],
      additionalProperties: false,
      properties: {
        path: {type: 'string'},
        stagedPath: {type: 'string'},
        beforeSha256: {type: 'string', pattern: '^[a-f0-9]{64}$'},
        afterSha256: {type: 'string', pattern: '^[a-f0-9]{64}$'},
        byteLength: {type: 'integer', minimum: 0},
        changed: {type: 'boolean'},
      },
    },
    sideEffect: 'local_write',
    requiredScopes: ['workspace:read', WORKSPACE_PATCH_STAGE_SCOPE],
    idempotencySupport: false,
    recoverySupport: false,
    requiresPresence: false,
  };

  return {
    descriptor,
    execute: async (input: unknown, context: ToolContext): Promise<WorkspacePatchStageResult> => {
      check(context, options.now);
      const preview = await options.preview.execute(input, context) as WorkspacePatchPreviewResult;
      check(context, options.now);
      const original = await checkedSource(root, preview.path);
      const before = await options.reader.execute({path: preview.path}, context) as {content: string};
      if (digest(Buffer.from(before.content, 'utf8')) !== preview.beforeSha256) {
        throw new ProtocolError('REVISION_CONFLICT', 'Workspace file changed before patch staging');
      }
      const result: WorkspacePatchStageResult = {
        path: preview.path,
        beforeSha256: preview.beforeSha256,
        afterSha256: preview.afterSha256,
        byteLength: Buffer.byteLength(preview.previewText, 'utf8'),
        changed: preview.changed,
      };
      if (!preview.changed) return result;

      // O_EXCL creates a separate candidate. The original path is never renamed
      // or opened for writing, including when another editor ignores this tool.
      const stagedPath = `.pa-stage-${randomUUID()}.patch`;
      const staged = resolve(root, stagedPath);
      let created = false;
      let identity: Awaited<ReturnType<typeof lstat>> | undefined;
      try {
        check(context, options.now);
        if (await realpath(root) !== root) throw new ProtocolError('SCOPE_DENIED', 'Workspace root changed');
        const handle = await open(staged, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
        created = true;
        try {
          await handle.writeFile(Buffer.from(preview.previewText, 'utf8'));
          await handle.sync();
          identity = await handle.stat();
        } finally {
          await handle.close();
        }
        const stagedBytes = await readFile(staged);
        const stagedNow = await lstat(staged);
        const sourceNow = await checkedSource(root, preview.path);
        const current = await options.reader.execute({path: preview.path}, context) as {content: string};
        if (!identity || !sameFile(identity, stagedNow) || digest(stagedBytes) !== preview.afterSha256
          || !sameFile(original, sourceNow)
          || digest(Buffer.from(current.content, 'utf8')) !== preview.beforeSha256) {
          throw new ProtocolError('REVISION_CONFLICT', 'Workspace file changed during patch staging');
        }
        check(context, options.now);
        result.stagedPath = stagedPath;
        return result;
      } catch (error) {
        if (created) {
          const candidate = await lstat(staged).catch(() => undefined);
          if (identity && candidate && sameFile(identity, candidate)) await unlink(staged).catch(() => {});
          if (await lstat(staged).then(() => true, () => false)) {
            throw new ProtocolError('RESULT_UNKNOWN', 'Workspace patch candidate may remain after failed staging');
          }
        }
        if (error instanceof ProtocolError) throw error;
        throw new ProtocolError('EXTERNAL_FAILURE', 'Workspace patch staging failed');
      }
    },
  };
}
