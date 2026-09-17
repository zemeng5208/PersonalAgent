import { constants as fsConstants, realpathSync, statSync } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import { ProtocolError, validateToolValue } from '@personal-agent/contracts';
import type { RegisteredTool, ToolContext, ToolDescriptor, ToolHost } from '@personal-agent/contracts';

export const WORKSPACE_READ_TOOL_NAME = 'workspace.read_text';
export const WORKSPACE_READ_TOOL_VERSION = '1.0.0';
export const WORKSPACE_READ_SCOPE = 'workspace:read';
export const DEFAULT_MAX_READ_BYTES = 256 * 1024;

const MAX_SCHEMA_BYTES = 1024 * 1024;
const DEFAULT_READ_CHUNK_BYTES = 64 * 1024;
const MAX_RELATIVE_PATH_LENGTH = 1024;

const blockedDirectoryNames = new Set([
  '.aws',
  '.azure',
  '.codex',
  '.direnv',
  '.docker',
  '.git',
  '.gnupg',
  '.kube',
  '.ssh',
]);

const blockedFileNames = new Set([
  '.git-credentials',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.envrc',
  'application-default-credentials.json',
  'credentials',
  'credentials.json',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_rsa',
  'secrets',
  'secrets.json',
  'service-account.json',
]);

const blockedPrivateKeyExtensions = new Set([
  '.jks',
  '.key',
  '.keystore',
  '.p12',
  '.pem',
  '.pfx',
  '.ppk',
]);

const privateKeyMarker = /-----BEGIN (?:DSA |EC |ENCRYPTED |OPENSSH |PGP |RSA )?PRIVATE KEY(?: BLOCK)?-----/u;
const disallowedTextControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const windowsReservedName = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/iu;

export interface WorkspaceReadOptions {
  /** Trusted host-provided workspace root. It is canonicalized before registration. */
  rootPath: string;
  /** Hard ceiling for both the accepted file size and returned UTF-8 bytes. */
  maxReadBytes?: number;
  /** Trusted clock injection for deterministic deadline tests. */
  now?: () => number;
  /** Trusted I/O tuning. Production callers normally keep the default. */
  readChunkBytes?: number;
}

interface WorkspaceReadInput {
  path: string;
  maxBytes?: number;
}

export interface WorkspaceReadResult {
  path: string;
  encoding: 'utf-8';
  byteLength: number;
  content: string;
}

const inputSchema = (maxReadBytes: number): ToolDescriptor['inputSchema'] => ({
  type: 'object',
  description: 'Read one complete UTF-8 text file beneath the trusted host-bound workspace root. The result is local tool output and is not permission to send file content to AgentArts, logs, or another destination.',
  required: ['path'],
  additionalProperties: false,
  properties: {
    path: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_RELATIVE_PATH_LENGTH,
      description: 'Canonical relative workspace path. Absolute, parent, device, UNC, ADS, symlink/junction escape, and sensitive paths are rejected.',
    },
    maxBytes: {
      type: 'integer',
      minimum: 1,
      maximum: maxReadBytes,
      description: 'Optional stricter whole-file byte ceiling. Files larger than this value are rejected rather than truncated.',
    },
  },
});

const outputSchema = (maxReadBytes: number): ToolDescriptor['outputSchema'] => ({
  type: 'object',
  required: ['path', 'encoding', 'byteLength', 'content'],
  additionalProperties: false,
  properties: {
    path: {type: 'string', minLength: 1, maxLength: MAX_RELATIVE_PATH_LENGTH},
    encoding: {enum: ['utf-8']},
    byteLength: {type: 'integer', minimum: 0, maximum: maxReadBytes},
    content: {type: 'string'},
  },
});

function boundedInteger(value: number | undefined, fallback: number, field: string, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) {
    throw new ProtocolError('INVALID_ARGUMENT', `${field} must be an integer from 1 to ${maximum}`);
  }
  return result;
}

function canonicalRoot(rootPath: string): string {
  if (typeof rootPath !== 'string' || !rootPath.trim()) {
    throw new ProtocolError('INVALID_ARGUMENT', 'Workspace rootPath must not be empty');
  }
  try {
    const root = realpathSync(rootPath);
    if (!statSync(root).isDirectory()) {
      throw new ProtocolError('INVALID_ARGUMENT', 'Workspace rootPath must identify a directory');
    }
    return root;
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError('INVALID_ARGUMENT', 'Workspace rootPath is not an accessible directory');
  }
}

function canonicalRelativePath(value: string): {normalized: string; segments: string[]} {
  if (value.length > MAX_RELATIVE_PATH_LENGTH || value.includes('\0')) {
    throw new ProtocolError('INVALID_ARGUMENT', 'Workspace path is invalid');
  }
  if (isAbsolute(value) || win32.isAbsolute(value) || value.startsWith('/') || value.startsWith('\\')) {
    throw new ProtocolError('INVALID_ARGUMENT', 'Workspace path must be relative');
  }
  if (value.includes(':')) {
    throw new ProtocolError('INVALID_ARGUMENT', 'Drive-qualified and alternate data stream paths are not allowed');
  }

  const segments = value.split(/[\\/]/u);
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new ProtocolError('INVALID_ARGUMENT', 'Workspace path must use canonical child segments');
  }
  for (const segment of segments) {
    if (/[. ]$/u.test(segment)) {
      throw new ProtocolError('INVALID_ARGUMENT', 'Workspace path contains a Windows-ambiguous segment');
    }
    const deviceCandidate = segment.split('.')[0] ?? segment;
    if (windowsReservedName.test(deviceCandidate)) {
      throw new ProtocolError('INVALID_ARGUMENT', 'Windows device names are not allowed');
    }
  }
  return {normalized: segments.join('/'), segments};
}

function pathIsWithinRoot(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation !== '' && relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation);
}

function sameCanonicalPath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US') : left === right;
}

function isSensitivePath(normalizedPath: string): boolean {
  const segments = normalizedPath.toLocaleLowerCase('en-US').split('/');
  if (segments.some(segment => blockedDirectoryNames.has(segment))) return true;
  const fileName = segments.at(-1) ?? '';
  if (blockedFileNames.has(fileName) || /^\.env(?:\..+)?$/u.test(fileName)) return true;
  if (/^(?:credentials|secrets|service-account)(?:\..+)?$/u.test(fileName)) return true;
  const extensionIndex = fileName.lastIndexOf('.');
  const extension = extensionIndex >= 0 ? fileName.slice(extensionIndex) : '';
  return blockedPrivateKeyExtensions.has(extension);
}

function checkContext(context: ToolContext, now: () => number): void {
  if (!context.scopes.includes(WORKSPACE_READ_SCOPE)) {
    throw new ProtocolError('SCOPE_DENIED', `Tool requires ${WORKSPACE_READ_SCOPE}`);
  }
  if (context.signal.aborted) {
    throw new ProtocolError('CANCELLED', 'Workspace read was cancelled');
  }
  const deadline = Date.parse(context.deadline);
  if (!Number.isFinite(deadline)) {
    throw new ProtocolError('INVALID_ARGUMENT', 'Workspace read deadline is invalid');
  }
  if (deadline <= now()) {
    throw new ProtocolError('TIMEOUT', 'Workspace read deadline expired');
  }
}

function mapFileSystemError(error: unknown): never {
  if (error instanceof ProtocolError) throw error;
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    throw new ProtocolError('NOT_FOUND', 'Workspace file was not found');
  }
  if (code === 'EACCES' || code === 'EPERM' || code === 'ELOOP') {
    throw new ProtocolError('SCOPE_DENIED', 'Workspace file is not readable under the configured policy');
  }
  throw new ProtocolError('EXTERNAL_FAILURE', 'Workspace file read failed');
}

function sameFileIdentity(left: Awaited<ReturnType<typeof stat>>, right: Awaited<ReturnType<typeof stat>>): boolean {
  if (left.dev === 0 && left.ino === 0 && right.dev === 0 && right.ino === 0) return true;
  return left.dev === right.dev && left.ino === right.ino;
}

function unchangedFile(left: Awaited<ReturnType<typeof stat>>, right: Awaited<ReturnType<typeof stat>>): boolean {
  return sameFileIdentity(left, right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

export function createWorkspaceReadTool(options: WorkspaceReadOptions): RegisteredTool {
  const root = canonicalRoot(options?.rootPath);
  const maxReadBytes = boundedInteger(options.maxReadBytes, DEFAULT_MAX_READ_BYTES, 'maxReadBytes', MAX_SCHEMA_BYTES);
  const readChunkBytes = boundedInteger(
    options.readChunkBytes,
    Math.min(DEFAULT_READ_CHUNK_BYTES, maxReadBytes),
    'readChunkBytes',
    maxReadBytes,
  );
  const now = options.now ?? Date.now;
  const descriptor: ToolDescriptor = {
    name: WORKSPACE_READ_TOOL_NAME,
    version: WORKSPACE_READ_TOOL_VERSION,
    inputSchema: inputSchema(maxReadBytes),
    outputSchema: outputSchema(maxReadBytes),
    sideEffect: 'read',
    requiredScopes: [WORKSPACE_READ_SCOPE],
    idempotencySupport: true,
    recoverySupport: true,
    requiresPresence: false,
  };

  return {
    descriptor,
    execute: async (input: unknown, context: ToolContext): Promise<WorkspaceReadResult> => {
      validateToolValue(descriptor.inputSchema, input);
      checkContext(context, now);
      const request = input as WorkspaceReadInput;
      const path = canonicalRelativePath(request.path);
      if (isSensitivePath(path.normalized)) {
        throw new ProtocolError('SCOPE_DENIED', 'Workspace path is blocked by the default sensitive-file policy');
      }
      const effectiveMaxBytes = request.maxBytes ?? maxReadBytes;
      const candidate = resolve(root, ...path.segments);
      if (!pathIsWithinRoot(root, candidate)) {
        throw new ProtocolError('SCOPE_DENIED', 'Workspace path escapes the configured root');
      }

      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        checkContext(context, now);
        const resolvedBeforeOpen = await realpath(candidate);
        if (!pathIsWithinRoot(root, resolvedBeforeOpen)) {
          throw new ProtocolError('SCOPE_DENIED', 'Workspace symlink or junction escapes the configured root');
        }
        const resolvedPolicyPath = relative(root, resolvedBeforeOpen).split(sep).join('/');
        if (isSensitivePath(resolvedPolicyPath)) {
          throw new ProtocolError('SCOPE_DENIED', 'Workspace symlink or junction resolves to a sensitive path');
        }

        const flags = process.platform === 'win32'
          ? fsConstants.O_RDONLY
          : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
        handle = await open(resolvedBeforeOpen, flags);
        const openedStat = await handle.stat();
        if (!openedStat.isFile()) {
          throw new ProtocolError('INVALID_ARGUMENT', 'Workspace path must identify a regular file');
        }
        if (openedStat.size > effectiveMaxBytes) {
          throw new ProtocolError('INVALID_ARGUMENT', `Workspace file exceeds the ${effectiveMaxBytes}-byte read limit`);
        }

        checkContext(context, now);
        const resolvedAfterOpen = await realpath(candidate);
        if (!pathIsWithinRoot(root, resolvedAfterOpen) || !sameCanonicalPath(resolvedBeforeOpen, resolvedAfterOpen)) {
          throw new ProtocolError('SCOPE_DENIED', 'Workspace path changed during containment validation');
        }
        const pathStat = await stat(resolvedAfterOpen);
        if (!sameFileIdentity(openedStat, pathStat)) {
          throw new ProtocolError('SCOPE_DENIED', 'Workspace path changed during file open');
        }

        const chunks: Buffer[] = [];
        let position = 0;
        while (position < openedStat.size) {
          checkContext(context, now);
          const length = Math.min(readChunkBytes, openedStat.size - position);
          const chunk = Buffer.allocUnsafe(length);
          const {bytesRead} = await handle.read(chunk, 0, length, position);
          checkContext(context, now);
          if (bytesRead === 0) {
            throw new ProtocolError('EXTERNAL_FAILURE', 'Workspace file changed while it was being read');
          }
          chunks.push(bytesRead === length ? chunk : chunk.subarray(0, bytesRead));
          position += bytesRead;
        }

        const completedStat = await handle.stat();
        if (!unchangedFile(openedStat, completedStat)) {
          throw new ProtocolError('EXTERNAL_FAILURE', 'Workspace file changed while it was being read');
        }
        const bytes = Buffer.concat(chunks, position);
        let content: string;
        try {
          content = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
        } catch {
          throw new ProtocolError('INVALID_ARGUMENT', 'Workspace file is not valid UTF-8 text');
        }
        if (disallowedTextControls.test(content)) {
          throw new ProtocolError('INVALID_ARGUMENT', 'Workspace file appears to be binary');
        }
        if (privateKeyMarker.test(content)) {
          throw new ProtocolError('SCOPE_DENIED', 'Workspace file contains private-key material blocked by policy');
        }
        checkContext(context, now);
        return {
          path: path.normalized,
          encoding: 'utf-8',
          byteLength: bytes.byteLength,
          content,
        };
      } catch (error) {
        mapFileSystemError(error);
      } finally {
        await handle?.close();
      }
    },
  };
}

export function register(host: ToolHost, options: WorkspaceReadOptions): () => void {
  return host.register(createWorkspaceReadTool(options));
}
