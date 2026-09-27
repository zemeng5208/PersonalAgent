/**
 * @file apps/desktop/electron/workspace-command-recipes.js
 *
 * Trusted Desktop Main helper for constructing bounded workspace command recipes.
 * Consumes @personal-agent/coding-tools public createWorkspaceCommandTool.
 *
 * Security Model:
 * 1. Default and currently ONLY supports node --check recipes.
 * 2. Trusted Desktop Main MUST explicitly inject a fixed, absolute nodeExecutable path.
 *    No automatic PATH/where.exe search or process.execPath defaulting is permitted.
 * 3. Node executable must reside strictly outside the writable workspace, be a regular file,
 *    and match node.exe (or node on non-Windows).
 * 4. Target source files for node --check must be canonical regular files inside the workspace,
 *    with symlinks, drive letters, and path traversals strictly rejected.
 * 5. Project scripts (npm run build, npm test) are NOT exposed regardless of flags:
 *    coding-tools command.ts uses env:{} and direct child termination, which does not terminate
 *    child process trees on Windows and risks orphaned processes. Separate verified process and
 *    filesystem isolation is required before project scripts can be safely enabled.
 * 6. Caller must explicitly pass createWorkspaceCommandTool factory; missing/invalid factory fails closed.
 */

import {existsSync, lstatSync, realpathSync, statSync} from 'node:fs';
import path from 'node:path';

const RECIPE_ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/u;

export function sanitizeRecipeId(prefix, suffix) {
  if (!suffix) return prefix;
  const cleanSuffix = String(suffix)
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '');
  const candidate = cleanSuffix ? `${prefix}-${cleanSuffix}` : prefix;
  return candidate.slice(0, 64);
}

function canonicalDirectory(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.startsWith('\\\\')) {
    throw Error(`${label} must be a local absolute path`);
  }
  const full = path.resolve(value);
  if (lstatSync(full).isSymbolicLink()) throw Error(`${label} must not be a link`);
  const canonical = realpathSync.native(full);
  if (!statSync(canonical).isDirectory()) throw Error(`${label} must be a directory`);
  if (canonical === path.parse(canonical).root) throw Error(`${label} cannot be the root of a drive`);
  return canonical;
}

function canonicalFile(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.startsWith('\\\\')) {
    throw Error(`${label} must be a local absolute path`);
  }
  const full = path.resolve(value);
  if (lstatSync(full).isSymbolicLink()) throw Error(`${label} must not be a link`);
  const canonical = realpathSync.native(full);
  if (!statSync(canonical).isFile()) throw Error(`${label} must be a regular file`);
  return canonical;
}

function isOutsideWorkspace(root, target) {
  const fromRoot = path.relative(root, target);
  return fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot);
}

export function resolveNodeExecutable(workspaceRoot, explicitNode) {
  if (typeof explicitNode !== 'string' || !path.isAbsolute(explicitNode)) {
    throw Error('Trusted absolute node.exe executable path is required from host');
  }
  const canonical = canonicalFile(explicitNode, 'Node executable');
  const base = path.basename(canonical).toLowerCase();
  const expectedBase = process.platform === 'win32' ? 'node.exe' : 'node';
  if (base !== 'node.exe' && base !== 'node') {
    throw Error(`Node executable must be named ${expectedBase}`);
  }
  if (!isOutsideWorkspace(workspaceRoot, canonical)) {
    throw Error('Node executable must reside outside the writable workspace');
  }
  return canonical;
}

export function validateCheckFile(workspaceRoot, fileEntry) {
  const relFile = typeof fileEntry === 'string' ? fileEntry : fileEntry?.path;
  if (typeof relFile !== 'string' || !relFile || relFile.includes('\0')) {
    throw Error('Check file must be a non-empty relative path string');
  }
  if (path.isAbsolute(relFile) || relFile.startsWith('\\\\') || /^[a-zA-Z]:/.test(relFile)) {
    throw Error('Check file must be a workspace-relative path, not an absolute path');
  }
  const normalized = path.normalize(relFile);
  if (normalized === '.' || normalized.startsWith('..') || path.isAbsolute(normalized)) {
    throw Error('Check file must not escape the workspace root');
  }
  const resolved = path.resolve(workspaceRoot, normalized);
  const fromRoot = path.relative(workspaceRoot, resolved);
  if (fromRoot === '' || fromRoot.startsWith('..') || path.isAbsolute(fromRoot)) {
    throw Error('Check file must be inside the workspace root');
  }
  if (!existsSync(resolved)) {
    throw Error(`Check file does not exist: ${relFile}`);
  }
  if (lstatSync(resolved).isSymbolicLink()) {
    throw Error(`Check file must not be a symbolic link: ${relFile}`);
  }
  const canonical = realpathSync.native(resolved);
  if (!statSync(canonical).isFile()) {
    throw Error(`Check file must be a regular file: ${relFile}`);
  }
  const canonicalFromRoot = path.relative(workspaceRoot, canonical);
  if (canonicalFromRoot === '' || canonicalFromRoot.startsWith('..') || path.isAbsolute(canonicalFromRoot)) {
    throw Error(`Check file canonical target must reside inside the workspace root: ${relFile}`);
  }
  return canonicalFromRoot.split(path.sep).join('/');
}

export function buildWorkspaceCommandRecipes({
  workspaceRoot,
  authorizedWorkspaceRoot,
  nodeExecutable,
  checkFiles = [],
  allowProjectScripts = false,
} = {}) {
  const canonicalRoot = canonicalDirectory(workspaceRoot, 'Workspace root');
  if (authorizedWorkspaceRoot !== undefined) {
    const canonicalAuthorized = canonicalDirectory(authorizedWorkspaceRoot, 'Authorized workspace root');
    if (canonicalRoot !== canonicalAuthorized) {
      throw Error('Workspace root is outside the fixed Desktop authorization');
    }
  }

  const canonicalNode = resolveNodeExecutable(canonicalRoot, nodeExecutable);

  const recipes = [];
  const diagnostics = {
    workspaceRoot: canonicalRoot,
    nodeExecutable: canonicalNode,
    checkFiles: [],
    projectScriptsAllowed: allowProjectScripts === true,
    projectScriptsExposed: false,
    reasons: [],
    npmHurdles: [
      'Windows empty env:{} execution in command.ts lacks PATH/ComSpec variables for complex build/test scripts.',
      'child.kill("SIGKILL") in command.ts only terminates the direct node.exe process, leaving child process trees orphaned on Windows.',
      'Project scripts execute arbitrary project code and are not sandboxed; packages/coding-tools/README.md requires verified process and filesystem isolation.',
    ],
  };

  // 1. Process node --check recipes
  const fileList = Array.isArray(checkFiles) ? checkFiles : (checkFiles ? [checkFiles] : []);
  const usedIds = new Set();

  for (let i = 0; i < fileList.length; i++) {
    const entry = fileList[i];
    const relPath = validateCheckFile(canonicalRoot, entry);
    diagnostics.checkFiles.push(relPath);

    let id = typeof entry === 'object' && entry?.id && RECIPE_ID_PATTERN.test(entry.id)
      ? entry.id
      : (fileList.length === 1 ? 'node-check' : sanitizeRecipeId('node-check', relPath));

    if (usedIds.has(id)) {
      id = sanitizeRecipeId(id, String(i + 1));
    }
    if (!RECIPE_ID_PATTERN.test(id)) {
      id = `node-check-${i + 1}`;
    }
    usedIds.add(id);

    recipes.push({
      id,
      executable: canonicalNode,
      args: ['--check', relPath],
    });
  }

  // 2. Project scripts policy: do NOT expose npm recipes regardless of switch
  if (allowProjectScripts === true) {
    diagnostics.reasons.push(
      'npm project scripts are not exposed: coding-tools command.ts uses env:{} and direct child termination, risking orphaned process trees on Windows; separate process and filesystem isolation is required per packages/coding-tools/README.md before project scripts can be safely enabled'
    );
  }

  return {
    workspaceRoot: canonicalRoot,
    recipes: Object.freeze(recipes),
    diagnostics: Object.freeze(diagnostics),
  };
}

export function createWorkspaceCommandRecipeTool(options = {}) {
  const {recipes, diagnostics, workspaceRoot} = buildWorkspaceCommandRecipes(options);
  if (!recipes.length) {
    if (options.required !== false) {
      throw Error('No approved command recipes available for workspace');
    }
    return {
      tool: null,
      recipes: [],
      diagnostics,
      workspaceRoot,
      available: () => false,
    };
  }

  const factory = options.createWorkspaceCommandTool;
  if (typeof factory !== 'function') {
    throw Error('Public createWorkspaceCommandTool factory is required from host');
  }

  const tool = factory({
    rootPath: workspaceRoot,
    recipes,
    maxOutputBytes: options.maxOutputBytes,
    maxDurationMs: options.maxDurationMs,
    now: options.now,
  });

  return {
    tool,
    descriptor: tool.descriptor,
    execute: tool.execute,
    recipes,
    diagnostics,
    workspaceRoot,
    available: () => true,
  };
}
