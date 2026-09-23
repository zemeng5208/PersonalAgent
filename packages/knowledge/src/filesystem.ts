import {createHash} from 'node:crypto';
import {constants, lstatSync, realpathSync} from 'node:fs';
import type {Stats} from 'node:fs';
import {lstat, open, readdir, realpath} from 'node:fs/promises';
import {isAbsolute, join, relative, sep, win32} from 'node:path';
import {KnowledgeError} from './index.js';
import type {KnowledgeHit, KnowledgePort, KnowledgeSearchRequest, KnowledgeSource} from './index.js';

const MAX_FILES = 1000;
const MAX_DIRECTORIES = 1000;
const MAX_DEPTH = 16;
const MAX_FILE_BYTES = 512 * 1024;

export interface ReadOnlyVaultPort extends KnowledgePort {
  readCitation(request: {
    readonly source: KnowledgeSource;
    readonly deadline: string;
    readonly signal: AbortSignal;
  }): Promise<string>;
}

function fail(code: KnowledgeError['code']): never {
  throw new KnowledgeError(code);
}

function checkContext(value: {deadline: string; signal: AbortSignal}): number {
  if (!value || typeof value !== 'object' || typeof value.deadline !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.deadline)
    || !Number.isFinite(Date.parse(value.deadline))
    || new Date(value.deadline).toISOString() !== value.deadline
    || !value.signal || typeof value.signal.aborted !== 'boolean') fail('INVALID_ARGUMENT');
  const deadline = Date.parse(value.deadline);
  checkActive(value.signal, deadline);
  return deadline;
}

function checkActive(signal: AbortSignal, deadline: number): void {
  if (signal.aborted) fail('CANCELLED');
  if (Date.now() >= deadline) fail('TIMEOUT');
}

function checkRelativePath(path: unknown): string[] {
  if (typeof path !== 'string' || !path || path.length > 1024 || path.includes('\\')
    || path.includes(':') || path.includes('\0') || isAbsolute(path) || win32.isAbsolute(path)
    || !/\.md$/i.test(path)) fail('INVALID_ARGUMENT');
  const parts = path.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
    || part.startsWith('.'))) fail('INVALID_ARGUMENT');
  return parts;
}

function within(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === '' || (relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function sameIdentity(left: {dev: number; ino: number}, right: {dev: number; ino: number}): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function unchanged(
  left: {dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number},
  right: {dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number}
): boolean {
  return sameIdentity(left, right) && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function safeError(error: unknown): never {
  if (error instanceof KnowledgeError) throw error;
  return fail('SOURCE_UNAVAILABLE');
}

/** Detached, read-only filesystem path. A trusted host must explicitly bind the Vault root. */
export async function openReadOnlyVault(options: {vaultId: string; rootPath: string}): Promise<ReadOnlyVaultPort> {
  if (!options || typeof options.vaultId !== 'string' || !options.vaultId.trim()
    || options.vaultId.length > 128 || typeof options.rootPath !== 'string'
    || !isAbsolute(options.rootPath) || options.rootPath.startsWith('\\\\')) fail('INVALID_ARGUMENT');
  let root: string;
  try {
    const info = lstatSync(options.rootPath);
    if (info.isSymbolicLink()) fail('SCOPE_DENIED');
    if (!info.isDirectory()) fail('INVALID_ARGUMENT');
    root = realpathSync.native(options.rootPath);
  } catch (error) {
    safeError(error);
  }
  const vaultId = options.vaultId;

  async function readNote(path: string, signal: AbortSignal, deadline: number): Promise<{content: string; revision: string}> {
    const parts = checkRelativePath(path);
    const candidate = join(root, ...parts);
    if (!within(root, candidate)) fail('SCOPE_DENIED');
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let expectedFile: Stats | undefined;
    try {
      for (let count = 1; count <= parts.length; count++) {
        checkActive(signal, deadline);
        const info = await lstat(join(root, ...parts.slice(0, count)));
        if (info.isSymbolicLink()) fail('SCOPE_DENIED');
        if (count < parts.length && !info.isDirectory()) fail('SOURCE_UNAVAILABLE');
        if (count === parts.length && !info.isFile()) fail('SOURCE_UNAVAILABLE');
        if (count === parts.length) expectedFile = info;
      }
      const beforePath = await realpath(candidate);
      if (!within(root, beforePath) || !samePath(candidate, beforePath)) fail('SCOPE_DENIED');
      const flags = process.platform === 'win32' ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
      handle = await open(beforePath, flags);
      const before = await handle.stat();
      if (!before.isFile() || !unchanged(expectedFile!, before)) fail('SCOPE_DENIED');
      if (before.size > MAX_FILE_BYTES) fail('LIMIT_EXCEEDED');
      const buffer = Buffer.allocUnsafe(before.size);
      let offset = 0;
      while (offset < buffer.length) {
        checkActive(signal, deadline);
        const {bytesRead} = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) fail('SOURCE_CHANGED');
        offset += bytesRead;
      }
      checkActive(signal, deadline);
      const after = await handle.stat();
      const pathAfter = await lstat(candidate);
      const afterPath = await realpath(candidate);
      if (pathAfter.isSymbolicLink() || !samePath(beforePath, afterPath)
        || !sameIdentity(before, pathAfter)) fail('SCOPE_DENIED');
      if (!unchanged(before, after)) fail('SOURCE_CHANGED');
      let content: string;
      try {
        content = new TextDecoder('utf-8', {fatal: true}).decode(buffer);
      } catch {
        fail('SOURCE_UNAVAILABLE');
      }
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(content)) fail('SOURCE_UNAVAILABLE');
      return {content, revision: createHash('sha256').update(buffer).digest('hex')};
    } catch (error) {
      return safeError(error);
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  return Object.freeze({
    search: async (request: KnowledgeSearchRequest) => {
      const deadline = checkContext(request);
      if (typeof request.query !== 'string' || !request.query.trim() || request.query.length > 128
        || !Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 20) fail('INVALID_ARGUMENT');
      const query = request.query.trim().toLowerCase();
      const hits: KnowledgeHit[] = [];
      let truncated = false;
      let files = 0;
      let directories = 0;

      // ponytail: bounded rescan keeps citations fresh; add an index only when real Vault size exceeds these limits.
      async function visit(parts: string[]): Promise<void> {
        checkActive(request.signal, deadline);
        if (++directories > MAX_DIRECTORIES || parts.length > MAX_DEPTH) fail('LIMIT_EXCEEDED');
        const directory = join(root, ...parts);
        try {
          const before = await lstat(directory);
          const resolved = await realpath(directory);
          if (before.isSymbolicLink() || !within(root, resolved) || !samePath(directory, resolved)) fail('SCOPE_DENIED');
          if (!before.isDirectory()) fail('SOURCE_UNAVAILABLE');
          const entries = await readdir(directory, {withFileTypes: true});
          entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
          for (const entry of entries) {
            checkActive(request.signal, deadline);
            if (entry.name.startsWith('.')) continue;
            if (entry.isSymbolicLink()) fail('SCOPE_DENIED');
            if (entry.isDirectory()) {
              await visit([...parts, entry.name]);
            } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
              if (++files > MAX_FILES) fail('LIMIT_EXCEEDED');
              const path = [...parts, entry.name].join('/');
              const {content, revision} = await readNote(path, request.signal, deadline);
              for (const [index, line] of content.split(/\r?\n/).entries()) {
                checkActive(request.signal, deadline);
                const offset = line.toLowerCase().indexOf(query);
                if (offset < 0) continue;
                if (hits.length === request.limit) {
                  truncated = true;
                  continue;
                }
                hits.push({
                  source: {vaultId, path, line: index + 1, revision},
                  excerpt: line.slice(Math.max(0, offset - 80), Math.max(0, offset - 80) + 320)
                });
              }
            }
          }
          const after = await lstat(directory);
          if (!unchanged(before, after)) fail('SOURCE_CHANGED');
        } catch (error) {
          safeError(error);
        }
      }
      await visit([]);
      return {hits, truncated};
    },
    readCitation: async (request: {source: KnowledgeSource; deadline: string; signal: AbortSignal}) => {
      const deadline = checkContext(request);
      const source = request.source;
      if (!source || source.vaultId !== vaultId || !Number.isSafeInteger(source.line)
        || source.line < 1 || typeof source.revision !== 'string'
        || !/^[0-9a-f]{64}$/.test(source.revision)) fail('INVALID_ARGUMENT');
      const {content, revision} = await readNote(source.path, request.signal, deadline);
      if (revision !== source.revision) fail('SOURCE_CHANGED');
      const line = content.split(/\r?\n/)[source.line - 1];
      if (line === undefined) fail('SOURCE_CHANGED');
      checkActive(request.signal, deadline);
      return line;
    }
  });
}
