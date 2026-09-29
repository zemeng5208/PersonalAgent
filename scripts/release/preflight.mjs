import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PROFILE = 'huawei_ict_agentarts';
const INTERNAL_PACKAGE = /^@personal-agent\/[a-z0-9-]+$/;
const MANIFEST_SCRIPT_NAMES = [
  'start',
  'typecheck',
  'test:smoke',
  'test:runtime-application-smoke',
];
const WORKSPACE_PARENTS = ['packages', 'packages/connectors', 'apps'];
const PACKAGE_CONFIG_PATHS = [
  'apps/desktop/electron-builder.yml',
  'apps/desktop/electron-builder.yaml',
  'apps/desktop/electron-builder.json',
  'apps/desktop/electron-forge.config.js',
  'apps/desktop/electron-forge.config.cjs',
  'apps/desktop/forge.config.js',
];
const MANUAL_ACCEPTANCE = [
  ['release-install-start', 'tests/manual/release/windows-install-start.json'],
  ['release-upgrade-data', 'tests/manual/release/windows-upgrade-data-retention.json'],
  ['release-uninstall', 'tests/manual/release/windows-uninstall.json'],
];

function normalizeRelative(value) {
  return value.split(path.sep).join('/');
}

function isSafeRelative(value, { requireDot = false } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\') || value.includes('\0')) {
    return false;
  }
  if (requireDot && !value.startsWith('./')) {
    return false;
  }
  if (path.posix.isAbsolute(value) || /^[a-zA-Z]:/.test(value)) {
    return false;
  }
  const normalized = path.posix.normalize(value);
  return normalized !== '..' && !normalized.startsWith('../');
}

function absoluteFromRelative(root, relativePath) {
  if (!isSafeRelative(relativePath)) {
    return null;
  }
  const absolute = path.resolve(root, relativePath);
  const back = path.relative(root, absolute);
  if (back === '..' || back.startsWith(`..${path.sep}`) || path.isAbsolute(back)) {
    return null;
  }
  return absolute;
}

function resolveContainedPath(root, relativePath) {
  const absolute = absoluteFromRelative(root, relativePath);
  if (!absolute) {
    return { status: 'invalid' };
  }
  try {
    const realRoot = fs.realpathSync(root);
    const realTarget = fs.realpathSync(absolute);
    const back = path.relative(realRoot, realTarget);
    if (back === '..' || back.startsWith(`..${path.sep}`) || path.isAbsolute(back)) {
      return { status: 'invalid' };
    }
    return { status: 'ok', absolute: realTarget };
  } catch (error) {
    if (error && typeof error === 'object' && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return { status: 'missing' };
    }
    return { status: 'invalid' };
  }
}

function addCheck(checks, id, relativePath, status, code) {
  checks.push(Object.freeze({
    id,
    path: normalizeRelative(relativePath),
    status,
    code,
  }));
}

function inspectFile(root, relativePath) {
  const resolved = resolveContainedPath(root, relativePath);
  if (resolved.status !== 'ok') {
    return resolved;
  }
  try {
    return fs.statSync(resolved.absolute).isFile() ? resolved : { status: 'invalid' };
  } catch {
    return { status: 'invalid' };
  }
}

function fileExists(root, relativePath) {
  return inspectFile(root, relativePath).status === 'ok';
}

function readText(root, relativePath) {
  const resolved = resolveContainedPath(root, relativePath);
  if (resolved.status !== 'ok') {
    return resolved;
  }
  try {
    return { status: 'ok', value: fs.readFileSync(resolved.absolute, 'utf8') };
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return { status: 'missing' };
    }
    return { status: 'invalid' };
  }
}

function readJson(root, relativePath) {
  const text = readText(root, relativePath);
  if (text.status !== 'ok') {
    return text;
  }
  try {
    const value = JSON.parse(text.value);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { status: 'invalid' };
    }
    return { status: 'ok', value };
  } catch {
    return { status: 'invalid' };
  }
}

function checkJsonManifest(checks, root, id, relativePath, codes) {
  const result = readJson(root, relativePath);
  if (result.status === 'ok') {
    addCheck(checks, id, relativePath, 'pass', codes.pass);
  } else {
    addCheck(
      checks,
      id,
      relativePath,
      result.status,
      result.status === 'missing' ? codes.missing : codes.invalid,
    );
  }
  return result;
}

function checkFile(checks, root, id, relativePath, missingCode) {
  const inspected = inspectFile(root, relativePath);
  const status = inspected.status === 'ok' ? 'pass' : inspected.status;
  const code = status === 'pass'
    ? 'FILE_PRESENT'
    : status === 'missing'
      ? missingCode
      : 'PROJECT_PATH_INVALID';
  addCheck(checks, id, relativePath, status, code);
  return status === 'pass';
}

function checkRootNodeConfiguration(checks, root, rootManifest) {
  const nodeVersionText = readText(root, '.node-version');
  if (nodeVersionText.status !== 'ok') {
    addCheck(
      checks,
      'node-version',
      '.node-version',
      nodeVersionText.status,
      nodeVersionText.status === 'missing' ? 'NODE_VERSION_FILE_MISSING' : 'NODE_VERSION_FILE_INVALID',
    );
    return;
  }

  const version = nodeVersionText.value.trim();
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  const engine = rootManifest.status === 'ok' ? rootManifest.value.engines?.node : undefined;
  const compatible = match && engine === `${match[1]}.${match[2]}.x`;
  addCheck(
    checks,
    'node-version',
    '.node-version',
    compatible ? 'pass' : 'invalid',
    compatible ? 'NODE_VERSION_CONFIGURED' : 'NODE_VERSION_ENGINE_MISMATCH',
  );
}

function checkDesktopSource(checks, root, desktopManifest) {
  if (desktopManifest.status !== 'ok') {
    return;
  }

  const main = desktopManifest.value.main;
  const mainIsSafe = isSafeRelative(main);
  if (!mainIsSafe) {
    addCheck(checks, 'desktop-main', 'apps/desktop/package.json', 'invalid', 'DESKTOP_MAIN_PATH_INVALID');
  } else {
    checkFile(checks, root, 'desktop-main', `apps/desktop/${main}`, 'DESKTOP_MAIN_MISSING');
  }

  const scripts = desktopManifest.value.scripts;
  const validScripts = scripts && typeof scripts === 'object' && MANIFEST_SCRIPT_NAMES.every(
    (name) => typeof scripts[name] === 'string' && scripts[name].trim().length > 0,
  );
  addCheck(
    checks,
    'desktop-scripts',
    'apps/desktop/package.json',
    validScripts ? 'pass' : 'invalid',
    validScripts ? 'DESKTOP_SCRIPTS_DECLARED' : 'DESKTOP_REQUIRED_SCRIPT_INVALID',
  );

  const mainSource = readText(root, 'apps/desktop/electron/main.js');
  const expectedReferences = [
    '../src/app/index.html',
    'preload.cjs',
    '@personal-agent/runtime/application',
  ];
  const hasReferences = mainSource.status === 'ok'
    && expectedReferences.every((reference) => mainSource.value.includes(reference));
  addCheck(
    checks,
    'desktop-main-wiring',
    'apps/desktop/electron/main.js',
    hasReferences ? 'pass' : mainSource.status === 'missing' ? 'missing' : 'invalid',
    hasReferences ? 'DESKTOP_ENTRY_WIRING_PRESENT' : 'DESKTOP_ENTRY_WIRING_INVALID',
  );

  checkFile(checks, root, 'desktop-preload', 'apps/desktop/electron/preload.cjs', 'DESKTOP_PRELOAD_MISSING');
  const htmlExists = checkFile(
    checks,
    root,
    'desktop-render-html',
    'apps/desktop/src/app/index.html',
    'DESKTOP_RENDER_HTML_MISSING',
  );
  checkFile(
    checks,
    root,
    'desktop-render-script',
    'apps/desktop/src/app/renderer.js',
    'DESKTOP_RENDER_SCRIPT_MISSING',
  );
  const html = htmlExists ? readText(root, 'apps/desktop/src/app/index.html') : { status: 'missing' };
  const rendererLinked = html.status === 'ok' && html.value.includes('./renderer.js');
  addCheck(
    checks,
    'desktop-render-wiring',
    'apps/desktop/src/app/index.html',
    rendererLinked ? 'pass' : html.status === 'missing' ? 'missing' : 'invalid',
    rendererLinked ? 'DESKTOP_RENDER_WIRING_PRESENT' : 'DESKTOP_RENDER_WIRING_INVALID',
  );
}

function getImportTarget(exportValue) {
  if (typeof exportValue === 'string') {
    return exportValue;
  }
  if (exportValue && typeof exportValue === 'object' && !Array.isArray(exportValue)) {
    return typeof exportValue.import === 'string' ? exportValue.import : null;
  }
  return null;
}

function exportEntries(manifest) {
  const exportsValue = manifest.exports;
  if (!exportsValue || typeof exportsValue !== 'object' || Array.isArray(exportsValue)) {
    return [];
  }
  return Object.entries(exportsValue)
    .map(([key, value]) => [key, getImportTarget(value)])
    .filter((entry) => entry[1] !== null)
    .sort(([left], [right]) => left.localeCompare(right));
}

function checkRuntimeApplicationExport(checks, root, runtimeManifest) {
  if (runtimeManifest.status !== 'ok') {
    return;
  }
  const target = getImportTarget(runtimeManifest.value.exports?.['./application']);
  if (!isSafeRelative(target, { requireDot: true })) {
    addCheck(
      checks,
      'runtime-application-export',
      'apps/runtime/package.json',
      'invalid',
      'RUNTIME_APPLICATION_EXPORT_INVALID',
    );
    return;
  }
  addCheck(
    checks,
    'runtime-application-export',
    'apps/runtime/package.json',
    'pass',
    'RUNTIME_APPLICATION_EXPORT_DECLARED',
  );
}

function listManifestDirectories(root, parentRelative) {
  const parent = resolveContainedPath(root, parentRelative);
  if (parent.status !== 'ok') {
    return [];
  }
  try {
    return fs.readdirSync(parent.absolute, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => `${parentRelative}/${entry.name}/package.json`)
      .sort();
  } catch {
    return [];
  }
}

function discoverWorkspaces(root) {
  const manifests = [];
  for (const parent of WORKSPACE_PARENTS) {
    manifests.push(...listManifestDirectories(root, parent));
  }

  const byName = new Map();
  for (const relativePath of [...new Set(manifests)].sort()) {
    const parsed = readJson(root, relativePath);
    if (parsed.status !== 'ok' || !INTERNAL_PACKAGE.test(parsed.value.name)) {
      continue;
    }
    byName.set(parsed.value.name, {
      manifest: parsed.value,
      manifestPath: relativePath,
      directory: path.posix.dirname(relativePath),
    });
  }
  return byName;
}

function collectProductionClosure(checks, root, desktopManifest) {
  if (desktopManifest.status !== 'ok') {
    return [];
  }
  const workspaces = discoverWorkspaces(root);
  const initial = Object.keys(desktopManifest.value.dependencies ?? {})
    .filter((name) => INTERNAL_PACKAGE.test(name))
    .sort();
  const queue = [...initial];
  const visited = new Set();
  const selected = [];

  while (queue.length > 0) {
    const name = queue.shift();
    if (visited.has(name)) {
      continue;
    }
    visited.add(name);
    const workspace = workspaces.get(name);
    if (!workspace) {
      addCheck(
        checks,
        `workspace-dependency-${selected.length + 1}`,
        'apps/desktop/package.json',
        'missing',
        'INTERNAL_WORKSPACE_MISSING',
      );
      continue;
    }
    selected.push(workspace);
    const dependencies = Object.keys(workspace.manifest.dependencies ?? {})
      .filter((dependency) => INTERNAL_PACKAGE.test(dependency) && !visited.has(dependency))
      .sort();
    queue.push(...dependencies);
  }
  return selected.sort((left, right) => left.manifestPath.localeCompare(right.manifestPath));
}

function checkBuildOutputs(checks, root, workspaces) {
  const outputs = [];
  let invalidExportCount = 0;
  for (const workspace of workspaces) {
    for (const [, target] of exportEntries(workspace.manifest)) {
      if (!isSafeRelative(target, { requireDot: true })) {
        invalidExportCount += 1;
        addCheck(
          checks,
          `build-export-${invalidExportCount}`,
          workspace.manifestPath,
          'invalid',
          'WORKSPACE_EXPORT_PATH_INVALID',
        );
        continue;
      }
      outputs.push(path.posix.join(workspace.directory, target.slice(2)));
    }
  }

  for (const [index, relativePath] of [...new Set(outputs)].sort().entries()) {
    const inspected = inspectFile(root, relativePath);
    const status = inspected.status === 'ok' ? 'pass' : inspected.status;
    addCheck(
      checks,
      `build-output-${index + 1}`,
      relativePath,
      status,
      status === 'pass'
        ? 'BUILD_OUTPUT_PRESENT'
        : status === 'missing'
          ? 'BUILD_OUTPUT_MISSING'
          : 'BUILD_OUTPUT_PATH_INVALID',
    );
  }
}

function checkElectronAndSqlite(checks, root, desktopManifest, lockManifest) {
  let electronVersion;
  if (desktopManifest.status === 'ok') {
    const value = desktopManifest.value.devDependencies?.electron;
    if (typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value)) {
      electronVersion = value;
      addCheck(checks, 'electron-version', 'apps/desktop/package.json', 'pass', 'ELECTRON_VERSION_PINNED');
    } else {
      addCheck(checks, 'electron-version', 'apps/desktop/package.json', 'invalid', 'ELECTRON_VERSION_NOT_EXACT');
    }
  }

  if (lockManifest.status === 'ok' && electronVersion) {
    const lockedElectron = lockManifest.value.packages?.['node_modules/electron'];
    const lockMatches = lockedElectron?.version === electronVersion
      && typeof lockedElectron?.engines?.node === 'string';
    addCheck(
      checks,
      'electron-lock',
      'package-lock.json',
      lockMatches ? 'pass' : 'invalid',
      lockMatches ? 'ELECTRON_LOCK_MATCHED' : 'ELECTRON_LOCK_MISMATCH',
    );
  } else if (lockManifest.status !== 'ok') {
    addCheck(
      checks,
      'electron-lock',
      'package-lock.json',
      lockManifest.status,
      lockManifest.status === 'missing' ? 'PACKAGE_LOCK_MISSING' : 'PACKAGE_LOCK_INVALID',
    );
  }

  const storageSource = readText(root, 'packages/storage/src/index.ts');
  const usesBuiltinSqlite = storageSource.status === 'ok' && storageSource.value.includes('node:sqlite');
  addCheck(
    checks,
    'sqlite-runtime-source',
    'packages/storage/src/index.ts',
    usesBuiltinSqlite ? 'pass' : storageSource.status === 'missing' ? 'missing' : 'invalid',
    usesBuiltinSqlite ? 'BUILTIN_SQLITE_REQUIRED' : 'BUILTIN_SQLITE_REQUIREMENT_MISSING',
  );
  addCheck(
    checks,
    'sqlite-packaged-electron-smoke',
    'tests/manual/release/windows-electron-sqlite.json',
    'blocked',
    'PACKAGED_ELECTRON_SQLITE_SMOKE_REQUIRED',
  );
}

function hasPackagingConfig(root, desktopManifest) {
  if (desktopManifest.status === 'ok') {
    const config = desktopManifest.value.build;
    if (config && typeof config === 'object' && !Array.isArray(config)) {
      return true;
    }
  }
  return PACKAGE_CONFIG_PATHS.some((relativePath) => fileExists(root, relativePath));
}

function hasWindowsPackageScript(desktopManifest) {
  if (desktopManifest.status !== 'ok') {
    return false;
  }
  const scripts = desktopManifest.value.scripts;
  if (!scripts || typeof scripts !== 'object') {
    return false;
  }
  return ['package:win', 'dist:win', 'release:win'].some(
    (name) => typeof scripts[name] === 'string' && scripts[name].trim().length > 0,
  );
}

function hasInstallerDefinition(desktopManifest) {
  if (desktopManifest.status !== 'ok') {
    return false;
  }
  const build = desktopManifest.value.build;
  if (!build || typeof build !== 'object' || Array.isArray(build)) {
    return false;
  }
  const target = build.win && typeof build.win === 'object' && !Array.isArray(build.win)
    ? build.win.target
    : undefined;
  return target === 'nsis' || (Array.isArray(target) && target.includes('nsis'));
}

function checkPackagingAndAcceptance(checks, root, desktopManifest) {
  const packagingConfig = hasPackagingConfig(root, desktopManifest);
  addCheck(
    checks,
    'production-packaging-config',
    'apps/desktop/package.json',
    packagingConfig ? 'pass' : 'blocked',
    packagingConfig ? 'PACKAGING_CONFIG_DECLARED' : 'PACKAGING_CONFIG_MISSING',
  );

  const windowsScript = hasWindowsPackageScript(desktopManifest);
  addCheck(
    checks,
    'windows-package-script',
    'apps/desktop/package.json',
    windowsScript ? 'pass' : 'blocked',
    windowsScript ? 'WINDOWS_PACKAGE_SCRIPT_DECLARED' : 'WINDOWS_PACKAGE_SCRIPT_MISSING',
  );

  const installer = hasInstallerDefinition(desktopManifest);
  addCheck(
    checks,
    'windows-installer-definition',
    'apps/desktop/package.json',
    installer ? 'pass' : 'blocked',
    installer ? 'INSTALLER_DEFINITION_DECLARED' : 'INSTALLER_DEFINITION_MISSING',
  );

  for (const [id, relativePath] of MANUAL_ACCEPTANCE) {
    const exists = fileExists(root, relativePath);
    addCheck(
      checks,
      id,
      relativePath,
      exists ? 'unverified' : 'blocked',
      exists ? 'MANUAL_EVIDENCE_NOT_EXECUTED' : 'MANUAL_EVIDENCE_MISSING',
    );
  }
}

function countStatuses(checks) {
  const summary = { pass: 0, missing: 0, invalid: 0, blocked: 0, unverified: 0 };
  for (const check of checks) {
    summary[check.status] += 1;
  }
  return summary;
}

function decideNextStep(checks) {
  const structuralFailure = checks.some((check) => (
    (check.status === 'missing' || check.status === 'invalid')
    && !check.id.startsWith('build-output-')
  ));
  if (structuralFailure) {
    return 'fix_project_structure';
  }
  if (checks.some((check) => check.id.startsWith('build-output-') && check.status !== 'pass')) {
    return 'run_build';
  }
  if (checks.some((check) => (
    ['production-packaging-config', 'windows-package-script', 'windows-installer-definition'].includes(check.id)
    && check.status !== 'pass'
  ))) {
    return 'implement_packaging';
  }
  return 'perform_release_acceptance';
}

export function runReleasePreflight(projectRoot) {
  const root = path.resolve(projectRoot);
  const checks = [];
  const rootManifest = checkJsonManifest(checks, root, 'root-manifest', 'package.json', {
    pass: 'ROOT_MANIFEST_PARSED',
    missing: 'ROOT_MANIFEST_MISSING',
    invalid: 'ROOT_MANIFEST_INVALID',
  });
  checkRootNodeConfiguration(checks, root, rootManifest);

  const desktopManifest = checkJsonManifest(checks, root, 'desktop-manifest', 'apps/desktop/package.json', {
    pass: 'DESKTOP_MANIFEST_PARSED',
    missing: 'DESKTOP_MANIFEST_MISSING',
    invalid: 'DESKTOP_MANIFEST_INVALID',
  });
  checkDesktopSource(checks, root, desktopManifest);

  const runtimeManifest = checkJsonManifest(checks, root, 'runtime-manifest', 'apps/runtime/package.json', {
    pass: 'RUNTIME_MANIFEST_PARSED',
    missing: 'RUNTIME_MANIFEST_MISSING',
    invalid: 'RUNTIME_MANIFEST_INVALID',
  });
  checkRuntimeApplicationExport(checks, root, runtimeManifest);

  const lockManifest = readJson(root, 'package-lock.json');
  const workspaces = collectProductionClosure(checks, root, desktopManifest);
  checkBuildOutputs(checks, root, workspaces);
  checkElectronAndSqlite(checks, root, desktopManifest, lockManifest);
  checkPackagingAndAcceptance(checks, root, desktopManifest);

  return Object.freeze({
    schemaVersion: 1,
    profile: PROFILE,
    mode: 'read_only_static',
    publishable: false,
    releaseStatus: 'blocked',
    nextStep: decideNextStep(checks),
    summary: Object.freeze(countStatuses(checks)),
    checks: Object.freeze(checks),
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  const report = runReleasePreflight(process.argv[2] ?? process.cwd());
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
