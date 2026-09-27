import {createHash} from 'node:crypto';
import {MAX_FRAME_BYTES, ProtocolError, validateToolValue} from '@personal-agent/contracts';
import type {RegisteredTool, ToolContext, ToolDescriptor} from '@personal-agent/contracts';

export const WORKSPACE_PATCH_PREVIEW_TOOL_NAME = 'workspace.preview_text_patch';
export const WORKSPACE_PATCH_PREVIEW_TOOL_VERSION = '1.0.0';
export const MAX_WORKSPACE_PATCH_EDITS = 32;
export const MAX_SERIALIZED_WORKSPACE_PATCH_INPUT_BYTES = 512 * 1024;

const MAX_RELATIVE_PATH_LENGTH = 1024;
const SHA256_PATTERN = '^[a-f0-9]{64}$';
const disallowedTextControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const utf8Encoder = new TextEncoder();

export interface WorkspacePatchPreviewEdit {
  oldText: string;
  newText: string;
}

interface WorkspacePatchPreviewInput {
  path: string;
  expectedSha256: string;
  edits: WorkspacePatchPreviewEdit[];
}

export interface WorkspacePatchPreviewResult {
  path: string;
  beforeSha256: string;
  afterSha256: string;
  changed: boolean;
  previewText: string;
}

interface WorkspaceReadResultLike {
  path: string;
  byteLength: number;
  content: string;
}

interface PatchPreviewFactoryOptions {
  reader: RegisteredTool;
  requiredScope: string;
  maxReadBytes: number;
  maxPreviewBytes: number;
  maxSerializedResultBytes: number;
  now: () => number;
}

function invalid(message: string): never {
  throw new ProtocolError('INVALID_ARGUMENT', message);
}

function inputSchema(maxReadBytes: number, maxPreviewBytes: number): ToolDescriptor['inputSchema'] {
  return {
    type: 'object',
    description: 'Preview ordered exact text replacements against one trusted-root workspace file. This tool never writes the file and does not grant a later write.',
    required: ['path', 'expectedSha256', 'edits'],
    additionalProperties: false,
    properties: {
      path: {type: 'string', minLength: 1, maxLength: MAX_RELATIVE_PATH_LENGTH},
      expectedSha256: {type: 'string', pattern: SHA256_PATTERN},
      edits: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_WORKSPACE_PATCH_EDITS,
        items: {
          type: 'object',
          required: ['oldText', 'newText'],
          additionalProperties: false,
          properties: {
            oldText: {type: 'string', minLength: 1, maxLength: maxReadBytes},
            newText: {type: 'string', maxLength: maxPreviewBytes},
          },
        },
      },
    },
  };
}

function outputSchema(maxPreviewBytes: number): ToolDescriptor['outputSchema'] {
  return {
    type: 'object',
    required: ['path', 'beforeSha256', 'afterSha256', 'changed', 'previewText'],
    additionalProperties: false,
    properties: {
      path: {type: 'string', minLength: 1, maxLength: MAX_RELATIVE_PATH_LENGTH},
      beforeSha256: {type: 'string', pattern: SHA256_PATTERN},
      afterSha256: {type: 'string', pattern: SHA256_PATTERN},
      changed: {type: 'boolean'},
      previewText: {type: 'string', maxLength: maxPreviewBytes},
    },
  };
}

function ownDataValue(record: object, key: string, enumerable: boolean): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || descriptor.enumerable !== enumerable || !('value' in descriptor)) {
    return invalid('Workspace patch preview input must use plain data properties');
  }
  return descriptor.value;
}

function hasExactOwnKeys(value: object, expected: readonly (string | symbol)[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length && expected.every(key => keys.includes(key));
}

function captureEdit(value: unknown): WorkspacePatchPreviewEdit {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !hasExactOwnKeys(value, ['oldText', 'newText'])) return invalid('Workspace patch edit is invalid');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalid('Workspace patch edit is invalid');
  const oldText = ownDataValue(value, 'oldText', true);
  const newText = ownDataValue(value, 'newText', true);
  if (typeof oldText !== 'string' || typeof newText !== 'string') return invalid('Workspace patch edit is invalid');
  return {oldText, newText};
}

function captureEditArray(value: unknown): WorkspacePatchPreviewEdit[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return invalid('Workspace patch edits are invalid');
  }
  const length = ownDataValue(value, 'length', false);
  if (!Number.isSafeInteger(length) || (length as number) < 1
    || (length as number) > MAX_WORKSPACE_PATCH_EDITS) return invalid('Workspace patch edits are invalid');
  const expectedKeys: (string | symbol)[] = ['length'];
  for (let index = 0; index < (length as number); index += 1) expectedKeys.push(String(index));
  if (!hasExactOwnKeys(value, expectedKeys)) return invalid('Workspace patch edits are invalid');
  const edits: WorkspacePatchPreviewEdit[] = [];
  for (let index = 0; index < (length as number); index += 1) {
    edits.push(captureEdit(ownDataValue(value, String(index), true)));
  }
  return edits;
}

function captureInput(schema: ToolDescriptor['inputSchema'], input: unknown): WorkspacePatchPreviewInput {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || !hasExactOwnKeys(input, ['path', 'expectedSha256', 'edits'])) {
      return invalid('Workspace patch preview input is invalid');
    }
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return invalid('Workspace patch preview input is invalid');
    const path = ownDataValue(input, 'path', true);
    const expectedSha256 = ownDataValue(input, 'expectedSha256', true);
    const edits = captureEditArray(ownDataValue(input, 'edits', true));
    if (typeof path !== 'string' || typeof expectedSha256 !== 'string') return invalid('Workspace patch preview input is invalid');
    const captured = {path, expectedSha256, edits};
    validateToolValue(schema, captured);
    if (new Set(edits.map(edit => edit.oldText)).size !== edits.length) {
      return invalid('Workspace patch edits must not repeat oldText');
    }
    if (utf8Encoder.encode(JSON.stringify(captured)).byteLength > MAX_SERIALIZED_WORKSPACE_PATCH_INPUT_BYTES) {
      return invalid('Workspace patch preview input exceeds the bounded serialized-input limit');
    }
    return captured;
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    return invalid('Workspace patch preview input is invalid');
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function checkCompletion(context: ToolContext, now: () => number): void {
  if (context.signal.aborted) throw new ProtocolError('CANCELLED', 'Workspace patch preview was cancelled');
  const deadline = Date.parse(context.deadline);
  if (!Number.isFinite(deadline)) throw new ProtocolError('INVALID_ARGUMENT', 'Workspace patch preview deadline is invalid');
  if (deadline <= now()) throw new ProtocolError('TIMEOUT', 'Workspace patch preview deadline expired');
}

function validCandidateBytes(candidate: string, maximumBytes: number): Uint8Array {
  if (disallowedTextControls.test(candidate)) invalid('Workspace patch preview contains binary control characters');
  const bytes = utf8Encoder.encode(candidate);
  if (bytes.byteLength > maximumBytes) invalid('Workspace patch preview exceeds the configured byte limit');
  if (new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes) !== candidate) {
    invalid('Workspace patch preview is not stable valid UTF-8 text');
  }
  return bytes;
}

function applyEdits(
  content: string,
  edits: readonly WorkspacePatchPreviewEdit[],
  maximumBytes: number,
): {text: string; bytes: Uint8Array} {
  let candidate = content;
  let bytes = validCandidateBytes(candidate, maximumBytes);
  for (const edit of edits) {
    const index = candidate.indexOf(edit.oldText);
    if (index < 0) invalid('Workspace patch oldText was not found in the current candidate');
    if (candidate.indexOf(edit.oldText, index + 1) >= 0) {
      invalid('Workspace patch oldText is ambiguous in the current candidate');
    }
    candidate = `${candidate.slice(0, index)}${edit.newText}${candidate.slice(index + edit.oldText.length)}`;
    bytes = validCandidateBytes(candidate, maximumBytes);
  }
  return {text: candidate, bytes};
}

export function createWorkspacePatchPreviewToolFromReader(
  options: PatchPreviewFactoryOptions,
): RegisteredTool {
  const schema = inputSchema(options.maxReadBytes, options.maxPreviewBytes);
  const descriptor: ToolDescriptor = {
    name: WORKSPACE_PATCH_PREVIEW_TOOL_NAME,
    version: WORKSPACE_PATCH_PREVIEW_TOOL_VERSION,
    inputSchema: schema,
    outputSchema: outputSchema(options.maxPreviewBytes),
    sideEffect: 'read',
    requiredScopes: [options.requiredScope],
    idempotencySupport: true,
    recoverySupport: true,
    requiresPresence: false,
  };

  return {
    descriptor,
    execute: async (input: unknown, context: ToolContext): Promise<WorkspacePatchPreviewResult> => {
      // Capture an immutable data-only request before the first await. Callers
      // cannot alter the path, hash, or edit list while the file read is pending.
      const request = captureInput(schema, input);
      const read = await options.reader.execute({path: request.path}, context) as WorkspaceReadResultLike;
      const beforeBytes = utf8Encoder.encode(read.content);
      if (beforeBytes.byteLength !== read.byteLength) {
        invalid('Workspace patch preview requires UTF-8 text with a byte-stable decoded form');
      }
      const beforeSha256 = sha256(beforeBytes);
      if (beforeSha256 !== request.expectedSha256) {
        throw new ProtocolError('REVISION_CONFLICT', 'Workspace file content changed since the expected hash');
      }
      const preview = applyEdits(read.content, request.edits, options.maxPreviewBytes);
      const result: WorkspacePatchPreviewResult = {
        path: read.path,
        beforeSha256,
        afterSha256: sha256(preview.bytes),
        changed: preview.text !== read.content,
        previewText: preview.text,
      };
      if (utf8Encoder.encode(JSON.stringify(result)).byteLength > options.maxSerializedResultBytes) {
        invalid('Workspace patch preview result exceeds the bounded serialized-output limit');
      }
      checkCompletion(context, options.now);
      return result;
    },
  };
}

export const MAX_WORKSPACE_PATCH_PREVIEW_BYTES = MAX_FRAME_BYTES;
