import {createHash, randomUUID} from 'node:crypto';
import {constants as fsConstants, realpathSync, statSync} from 'node:fs';
import {lstat, open, readFile, realpath, rename, unlink} from 'node:fs/promises';
import {basename, dirname, isAbsolute, relative, resolve, sep} from 'node:path';
import {ProtocolError} from '@personal-agent/contracts';
import type {RegisteredTool, ToolContext, ToolDescriptor} from '@personal-agent/contracts';
import type {WorkspacePatchPreviewResult} from './patch-preview.js';

export const WORKSPACE_PATCH_WRITE_TOOL_NAME = 'workspace.apply_text_patch';
export const WORKSPACE_PATCH_WRITE_TOOL_VERSION = '1.0.0';
export const WORKSPACE_PATCH_WRITE_SCOPE = 'workspace:write';

export interface WorkspacePatchWriteResult {
  path: string;
  beforeSha256: string;
  afterSha256: string;
  byteLength: number;
  changed: boolean;
}

interface PatchWriteOptions {
  rootPath: string;
  preview: RegisteredTool;
  reader: RegisteredTool;
  now: () => number;
}

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function check(context: ToolContext, now: () => number): void {
  if (!context.scopes.includes(WORKSPACE_PATCH_WRITE_SCOPE)
    || !context.scopes.includes('workspace:read')) {
    throw new ProtocolError('SCOPE_DENIED', 'Workspace patch write requires read and write scopes');
  }
  if (context.signal.aborted) throw new ProtocolError('CANCELLED', 'Workspace patch write was cancelled');
  const deadline = Date.parse(context.deadline);
  if (!Number.isFinite(deadline)) throw new ProtocolError('INVALID_ARGUMENT', 'Workspace patch write deadline is invalid');
  if (deadline <= now()) throw new ProtocolError('TIMEOUT', 'Workspace patch write deadline expired');
}

function within(root: string, candidate: string): boolean {
  const part = relative(root, candidate);
  return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

function sameFile(left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>): boolean {
  return left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

/** Only direct regular files below a stable canonical root can be replaced. */
async function checkedTarget(root: string, relativePath: string): Promise<{target: string; state: Awaited<ReturnType<typeof lstat>>}> {
  const segments = relativePath.split('/');
  const target = resolve(root, ...segments);
  if (!within(root, target)) throw new ProtocolError('SCOPE_DENIED', 'Workspace patch target escapes the authorized root');
  const currentRoot = await realpath(root);
  if (currentRoot !== root || !statSync(root).isDirectory()) {
    throw new ProtocolError('SCOPE_DENIED', 'Workspace root changed before patch write');
  }
  let current = root;
  for (const segment of segments) {
    current = resolve(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new ProtocolError('SCOPE_DENIED', 'Workspace patch write does not follow links');
    if (current === target) {
      if (!info.isFile() || info.nlink !== 1) {
        throw new ProtocolError('SCOPE_DENIED', 'Workspace patch target must be a single-link regular file');
      }
      return {target, state: info};
    }
    if (!info.isDirectory()) throw new ProtocolError('SCOPE_DENIED', 'Workspace patch parent must be a directory');
    const canonical = await realpath(current);
    if (canonical !== current || !within(root, canonical)) {
      throw new ProtocolError('SCOPE_DENIED', 'Workspace patch parent changed during containment check');
    }
  }
  throw new ProtocolError('INVALID_ARGUMENT', 'Workspace patch path is invalid');
}

function resultOf(preview: WorkspacePatchPreviewResult, changed: boolean): WorkspacePatchWriteResult {
  return {
    path: preview.path,
    beforeSha256: preview.beforeSha256,
    afterSha256: preview.afterSha256,
    byteLength: Buffer.byteLength(preview.previewText, 'utf8'),
    changed,
  };
}

export function createWorkspacePatchWriteToolFromReader(options: PatchWriteOptions): RegisteredTool {
  const root = realpathSync.native(options.rootPath);
  if (!statSync(root).isDirectory()) throw new ProtocolError('INVALID_ARGUMENT', 'Workspace root must be a directory');
  const descriptor: ToolDescriptor = {
    name: WORKSPACE_PATCH_WRITE_TOOL_NAME,
    version: WORKSPACE_PATCH_WRITE_TOOL_VERSION,
    inputSchema: options.preview.descriptor.inputSchema,
    outputSchema: {
      type: 'object',
      required: ['path', 'beforeSha256', 'afterSha256', 'byteLength', 'changed'],
      additionalProperties: false,
      properties: {
        path: {type: 'string'},
        beforeSha256: {type: 'string', pattern: '^[a-f0-9]{64}$'},
        afterSha256: {type: 'string', pattern: '^[a-f0-9]{64}$'},
        byteLength: {type: 'integer', minimum: 0},
        changed: {type: 'boolean'},
      },
    },
    sideEffect: 'local_write',
    requiredScopes: ['workspace:read', WORKSPACE_PATCH_WRITE_SCOPE],
    idempotencySupport: false,
    recoverySupport: false,
    // Runtime's explicit approval/grant is the authority; its current
    // tool.invoke transport does not carry a separate userPresent bit.
    requiresPresence: false,
  };

  return {
    descriptor,
    execute: async (input: unknown, context: ToolContext): Promise<WorkspacePatchWriteResult> => {
      check(context, options.now);
      // Preview captures and validates the complete request before any await.
      const preview = await options.preview.execute(input, context) as WorkspacePatchPreviewResult;
      check(context, options.now);
      const initial = await checkedTarget(root, preview.path);
      const lockPath = resolve(dirname(initial.target), `.${basename(initial.target)}.pa-write.lock`);
      let lock: Awaited<ReturnType<typeof open>> | undefined;
      let ownsLock = false;
      let lockIdentity: Awaited<ReturnType<typeof lstat>> | undefined;
      let temporary: string | undefined;
      let replaced = false;
      try {
        lock = await open(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
        ownsLock = true;
        lockIdentity = await lock.stat();
        await lock.close();
        lock = undefined;
        const before = await options.reader.execute({path: preview.path}, context) as {content: string};
        if (digest(Buffer.from(before.content, 'utf8')) !== preview.beforeSha256) {
          throw new ProtocolError('REVISION_CONFLICT', 'Workspace file changed before patch write');
        }
        if (!preview.changed) return resultOf(preview, false);

        const bytes = Buffer.from(preview.previewText, 'utf8');
        temporary = resolve(dirname(initial.target), `.${basename(initial.target)}.pa-write-${randomUUID()}.tmp`);
        const output = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, Number(initial.state.mode) & 0o777);
        try {
          await output.writeFile(bytes);
          await output.sync();
        } finally {
          await output.close();
        }

        check(context, options.now);
        const current = await checkedTarget(root, preview.path);
        const existing = await readFile(current.target);
        const afterRead = await lstat(current.target);
        if (!sameFile(initial.state, current.state) || !sameFile(current.state, afterRead)
          || digest(existing) !== preview.beforeSha256) {
          throw new ProtocolError('REVISION_CONFLICT', 'Workspace file changed before patch replacement');
        }
        check(context, options.now);
        await rename(temporary, current.target);
        replaced = true;
        temporary = undefined;

        // A write is only confirmed after a fresh read through the restricted reader.
        try {
          const verified = await options.reader.execute({path: preview.path}, context) as {content: string};
          if (digest(Buffer.from(verified.content, 'utf8')) !== preview.afterSha256) {
            throw new Error('post-write hash mismatch');
          }
          check(context, options.now);
          return resultOf(preview, true);
        } catch {
          throw new ProtocolError('RESULT_UNKNOWN', 'Workspace patch replacement occurred but confirmation is unavailable');
        }
      } catch (error) {
        if (replaced) {
          if (error instanceof ProtocolError && error.code === 'RESULT_UNKNOWN') throw error;
          throw new ProtocolError('RESULT_UNKNOWN', 'Workspace patch replacement occurred but confirmation is unavailable');
        }
        if (error instanceof ProtocolError) throw error;
        const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
        if (code === 'EEXIST') throw new ProtocolError('REVISION_CONFLICT', 'Workspace patch path is busy');
        if (code === 'ENOENT' || code === 'ENOTDIR') throw new ProtocolError('REVISION_CONFLICT', 'Workspace patch path changed');
        throw new ProtocolError('EXTERNAL_FAILURE', 'Workspace patch write failed');
      } finally {
        await lock?.close();
        if (temporary) await unlink(temporary).catch(() => {});
        if (ownsLock && lockIdentity) {
          const currentLock = await lstat(lockPath).catch(() => undefined);
          if (currentLock && sameFile(lockIdentity, currentLock)) await unlink(lockPath).catch(() => {});
        }
      }
    },
  };
}
