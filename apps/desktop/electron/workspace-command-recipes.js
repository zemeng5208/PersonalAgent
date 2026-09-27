/**
 * @file apps/desktop/electron/workspace-command-recipes.js
 *
 * Trusted Desktop Main helper for constructing bounded workspace command recipes.
 * Consumes @personal-agent/coding-tools public createWorkspaceCommandTool.
 *
 * Security Model:
 * 1. Default NO project script commands (allowProjectScripts defaults to false).
 * 2. Host pre-constructs all argv; tool input is strictly constrained to enum recipeId.
 *    Model/tool callers CANNOT provide executable paths, arbitrary script paths, or shell strings.
 * 3. Node executable must reside strictly outside the writable workspace.
 * 4. Target source files for node --check must be canonical regular files inside the workspace,
 *    with symlinks and path traversals strictly rejected.
 * 5. If allowProjectScripts is true, fixed recipes for npm run build and npm test may be exposed
 *    ONLY when a valid package.json with the respective scripts is present and a trusted npm-cli.js
 *    outside the workspace is available.
 * 6. Explicitly NOT an OS sandbox: project scripts execute user code. On Windows, empty env:{}
 *    and direct child process termination (without job objects/process tree kill) pose orphan process risks.
 */

import {existsSync, lstatSync, readFileSync, realpathSync, statSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import path from 'node:path';

// If @personal-agent/coding-tools is resolvable at runtime, load createWorkspaceCommandTool
let defaultCommandToolFactory = null;
try {
  const coding = await import('@personal-agent/coding-tools');
  defaultCommandToolFactory = coding.createWorkspaceCommandTool;
} catch {
  // Gracefully ignored when running isolated unit tests without linked node_modules
}

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
  let candidate = explicitNode;
  if (!candidate) {
    if (process.execPath && path.basename(process.execPath).toLowerCase().startsWith('node') && !process.execPath.toLowerCase().includes('electron')) {
      candidate = process.execPath;
    } else {
      try {
        const where = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe');
        const found = execFileSync(where, ['node.exe'], {encoding: 'utf8', windowsHide: true, timeout: 3000})
          .trim().split(/\r?\n/)[0];
        if (found) candidate = found;
      } catch {}
    }
  }
  if (!candidate) {
    throw Error('Trusted node.exe executable is required');
  }
  const canonical = canonicalFile(candidate, 'Node executable');
  if (!isOutsideWorkspace(workspaceRoot, canonical)) {
    throw Error('Node executable must reside outside the writable workspace');
  }
  return canonical;
}

export function resolveNpmCliPath(workspaceRoot, nodeExecutable, explicitNpmCli) {
  let candidate = explicitNpmCli;
  if (!candidate && nodeExecutable) {
    const defaultNpmCli = path.join(path.dirname(nodeExecutable), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (existsSync(defaultNpmCli)) {
      candidate = defaultNpmCli;
    }
  }
  if (!candidate) return undefined;
  try {
    const canonical = canonicalFile(candidate, 'npm-cli script');
    if (!isOutsideWorkspace(workspaceRoot, canonical)) {
      return undefined;
    }
    return canonical;
  } catch {
    return undefined;
  }
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
  npmCliPath,
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
    npmCliPath: null,
    reasons: [],
    npmHurdles: [
      'Windows empty env:{} execution in command.ts may lack necessary PATH/ComSpec variables for complex scripts.',
      'child.kill("SIGKILL") in command.ts only terminates the direct node.exe process, leaving child process trees orphaned on Windows.',
      'Project scripts execute arbitrary project code and are not sandboxed.',
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

  // 2. Process npm project scripts if explicitly allowed
  if (allowProjectScripts === true) {
    const pkgPath = path.join(canonicalRoot, 'package.json');
    if (!existsSync(pkgPath)) {
      diagnostics.reasons.push('package.json not found in workspace root');
    } else if (lstatSync(pkgPath).isSymbolicLink()) {
      diagnostics.reasons.push('package.json is a symbolic link (rejected)');
    } else if (!statSync(pkgPath).isFile()) {
      diagnostics.reasons.push('package.json is not a regular file');
    } else {
      let pkg;
      try {
        pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      } catch {
        diagnostics.reasons.push('package.json is not valid JSON');
      }

      if (pkg) {
        const hasBuild = typeof pkg.scripts?.build === 'string';
        const hasTest = typeof pkg.scripts?.test === 'string';

        if (!hasBuild && !hasTest) {
          diagnostics.reasons.push('package.json contains neither "build" nor "test" script');
        } else {
          const resolvedNpmCli = resolveNpmCliPath(canonicalRoot, canonicalNode, npmCliPath);
          if (!resolvedNpmCli) {
            diagnostics.reasons.push('Trusted npm-cli.js was not found outside the workspace');
          } else {
            diagnostics.npmCliPath = resolvedNpmCli;
            if (hasBuild) {
              recipes.push({
                id: 'npm-build',
                executable: canonicalNode,
                args: [resolvedNpmCli, 'run', 'build'],
              });
            }
            if (hasTest) {
              recipes.push({
                id: 'npm-test',
                executable: canonicalNode,
                args: [resolvedNpmCli, 'test'],
              });
            }
            diagnostics.projectScriptsExposed = true;
          }
        }
      }
    }
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

  const factory = options.createWorkspaceCommandTool ?? defaultCommandToolFactory;
  if (typeof factory !== 'function') {
    throw Error('Public createWorkspaceCommandTool factory is unavailable');
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
