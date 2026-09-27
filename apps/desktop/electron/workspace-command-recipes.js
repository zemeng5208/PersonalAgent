/**
 * @file apps/desktop/electron/workspace-command-recipes.js
 *
 * Trusted Desktop Main helper for constructing bounded workspace command recipes.
 * Consumes @personal-agent/coding-tools public createWorkspaceCommandTool.
 *
 * Security Model:
 * 1. Supports:
 *    - node --check recipes for syntax verification of workspace files.
 *    - npm-build and npm-test recipes via WindowsJobProcessHost to guarantee process tree termination.
 * 2. Trusted Desktop Main MUST explicitly inject fixed, absolute executable paths:
 *    - nodeExecutable: path to node.exe (or node on non-Windows).
 *    - jobHelperExecutable: path to WindowsJobProcessHost.exe (outside workspace, regular file, non-symlink).
 *    - npmCliPath: path to npm-cli.js (outside workspace, regular file, non-symlink).
 *    No automatic PATH/where.exe search or process.execPath defaulting is permitted.
 * 3. All host executables must reside strictly outside the writable workspace, be canonical regular files,
 *    and cannot be symbolic links or junctions.
 * 4. Target source files for node --check must be canonical regular files inside the workspace,
 *    with symlinks, drive letters, and path traversals strictly rejected.
 * 5. Project scripts (npm-build, npm-test) are exposed ONLY when ALL of the following criteria are met:
 *    - allowProjectScripts === true (explicit opt-in).
 *    - jobHelperExecutable is injected and verified outside workspace.
 *    - npmCliPath is injected and verified outside workspace.
 *    - package.json exists in workspace root and declares 'build' or 'test' scripts (only script names inspected,
 *      script bodies are never leaked).
 *    - node_modules directory exists in workspace root (if absent, reports dependencies_missing; never runs npm install).
 *    - Safe minimal OS environment whitelist (APPDATA, LOCALAPPDATA, ComSpec, PATH, SystemRoot, TEMP, TMP, etc.)
 *      is injected, with all token/key/secret variables strictly blocked.
 * 6. Caller must explicitly pass createWorkspaceCommandTool factory; missing/invalid factory fails closed.
 */

import {existsSync, lstatSync, readFileSync, realpathSync, statSync} from 'node:fs';
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

export function resolveJobHelperExecutable(workspaceRoot, explicitJobHelper) {
  if (typeof explicitJobHelper !== 'string' || !path.isAbsolute(explicitJobHelper)) {
    throw Error('Trusted absolute job helper executable path is required from host');
  }
  const canonical = canonicalFile(explicitJobHelper, 'Job helper executable');
  if (process.platform === 'win32') {
    const ext = path.extname(canonical).toLowerCase();
    if (ext !== '.exe') {
      throw Error('Job helper executable must be a Windows executable (.exe)');
    }
  }
  if (!isOutsideWorkspace(workspaceRoot, canonical)) {
    throw Error('Job helper executable must reside outside the writable workspace');
  }
  return canonical;
}

export function resolveNpmCliPath(workspaceRoot, explicitNpmCli) {
  if (typeof explicitNpmCli !== 'string' || !path.isAbsolute(explicitNpmCli)) {
    throw Error('Trusted absolute npm-cli.js path is required from host');
  }
  const canonical = canonicalFile(explicitNpmCli, 'npm-cli path');
  const base = path.basename(canonical).toLowerCase();
  if (!base.startsWith('npm') || (!base.endsWith('.js') && !base.endsWith('.cjs'))) {
    throw Error('npm-cli path must be a JavaScript file for the npm CLI entrypoint');
  }
  if (!isOutsideWorkspace(workspaceRoot, canonical)) {
    throw Error('npm-cli path must reside outside the writable workspace');
  }
  return canonical;
}

const ALLOWED_ENV_VARS_WIN32 = [
  'APPDATA',
  'LOCALAPPDATA',
  'ComSpec',
  'PATH',
  'SystemRoot',
  'TEMP',
  'TMP',
  'HOMEDRIVE',
  'HOMEPATH',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'SYSTEMDRIVE',
  'WINDIR',
];

const ALLOWED_ENV_VARS_POSIX = [
  'PATH',
  'HOME',
  'TEMP',
  'TMP',
  'USER',
];

const FORBIDDEN_ENV_KEY_PATTERN = /(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH)/i;

export function buildSafeProjectScriptEnv(envSource = process.env) {
  const allowedKeys = process.platform === 'win32' ? ALLOWED_ENV_VARS_WIN32 : ALLOWED_ENV_VARS_POSIX;
  const safeEnv = {};
  if (!envSource || typeof envSource !== 'object') return Object.freeze(safeEnv);
  const sourceKeys = Object.keys(envSource);
  for (const allowed of allowedKeys) {
    const matchingKey = sourceKeys.find(k => k.toLowerCase() === allowed.toLowerCase());
    if (matchingKey && typeof envSource[matchingKey] === 'string') {
      if (FORBIDDEN_ENV_KEY_PATTERN.test(matchingKey)) continue;
      const val = envSource[matchingKey];
      if (val.length <= 4096 && !val.includes('\0')) {
        safeEnv[allowed] = val;
      }
    }
  }
  return Object.freeze(safeEnv);
}

function inspectPackageJson(canonicalRoot) {
  const pkgPath = path.join(canonicalRoot, 'package.json');
  if (!existsSync(pkgPath)) return {exists: false, scripts: []};
  try {
    const lstat = lstatSync(pkgPath);
    if (lstat.isSymbolicLink()) {
      return {exists: false, scripts: [], invalid: true, reason: 'package.json must not be a symbolic link'};
    }
    const canonicalPkg = realpathSync.native(pkgPath);
    const fromRoot = path.relative(canonicalRoot, canonicalPkg);
    if (fromRoot === '' || fromRoot.startsWith('..') || path.isAbsolute(fromRoot)) {
      return {exists: false, scripts: [], invalid: true, reason: 'package.json canonical target must reside inside the workspace root'};
    }
    const stat = statSync(canonicalPkg);
    if (!stat.isFile()) return {exists: false, scripts: []};
    const content = readFileSync(canonicalPkg, 'utf8');
    const parsed = JSON.parse(content);
    const scripts = parsed && typeof parsed.scripts === 'object' && parsed.scripts !== null
      ? Object.keys(parsed.scripts)
      : [];
    return {exists: true, scripts};
  } catch {
    return {exists: true, scripts: [], invalid: true};
  }
}

function checkNodeModules(canonicalRoot) {
  const nmPath = path.join(canonicalRoot, 'node_modules');
  if (!existsSync(nmPath)) return false;
  try {
    const lstat = lstatSync(nmPath);
    if (lstat.isSymbolicLink()) return false;
    const canonicalNm = realpathSync.native(nmPath);
    const fromRoot = path.relative(canonicalRoot, canonicalNm);
    if (fromRoot === '' || fromRoot.startsWith('..') || path.isAbsolute(fromRoot)) {
      return false;
    }
    return statSync(canonicalNm).isDirectory();
  } catch {
    return false;
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
  jobHelperExecutable,
  npmCliPath,
  checkFiles = [],
  allowProjectScripts = false,
  projectScriptEnvSource = process.env,
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

  // 2. Project scripts gatekeeping and recipe exposure
  if (allowProjectScripts === true) {
    let canonicalJobHelper;
    let canonicalNpmCli;

    if (!jobHelperExecutable) {
      diagnostics.reasons.push('job_helper_missing: Trusted jobHelperExecutable was not provided by host');
    } else {
      canonicalJobHelper = resolveJobHelperExecutable(canonicalRoot, jobHelperExecutable);
    }

    if (!npmCliPath) {
      diagnostics.reasons.push('npm_cli_missing: Trusted npmCliPath was not provided by host');
    } else {
      canonicalNpmCli = resolveNpmCliPath(canonicalRoot, npmCliPath);
    }

    const pkg = inspectPackageJson(canonicalRoot);
    if (!pkg.exists) {
      if (pkg.reason) {
        diagnostics.reasons.push(`package_json_invalid: ${pkg.reason}`);
      } else {
        diagnostics.reasons.push('package_json_missing: No package.json found in workspace root');
      }
    } else if (pkg.invalid) {
      diagnostics.reasons.push('package_json_invalid: package.json could not be parsed');
    }

    const hasNodeModules = checkNodeModules(canonicalRoot);
    if (!hasNodeModules) {
      diagnostics.reasons.push('dependencies_missing: node_modules directory does not exist in workspace root or points outside; run install outside first');
    }

    if (canonicalJobHelper && canonicalNpmCli && pkg.exists && !pkg.invalid && hasNodeModules) {
      const scriptNames = new Set(pkg.scripts);
      const safeEnv = buildSafeProjectScriptEnv(projectScriptEnvSource);
      let exposedCount = 0;

      if (scriptNames.has('build')) {
        recipes.push({
          id: 'npm-build',
          executable: canonicalJobHelper,
          args: ['--cwd', canonicalRoot, '--exe', canonicalNode, '--', canonicalNpmCli, 'run', 'build'],
          env: safeEnv,
        });
        exposedCount++;
      }
      if (scriptNames.has('test')) {
        recipes.push({
          id: 'npm-test',
          executable: canonicalJobHelper,
          args: ['--cwd', canonicalRoot, '--exe', canonicalNode, '--', canonicalNpmCli, 'run', 'test'],
          env: safeEnv,
        });
        exposedCount++;
      }

      if (exposedCount > 0) {
        diagnostics.projectScriptsExposed = true;
      } else {
        diagnostics.reasons.push('no_build_or_test_scripts: package.json does not declare "build" or "test" scripts');
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
