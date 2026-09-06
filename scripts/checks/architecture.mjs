import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);
const SKIPPED_DIRECTORIES = new Set(['.git', '.worktrees', 'dist', 'node_modules']);

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function collectFiles(directory, predicate) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(target, predicate));
    else if (predicate(target)) files.push(target);
  }
  return files;
}

function discoverWorkspaces(root) {
  const workspaces = [];
  const visit = directory => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const candidate = path.join(directory, entry.name);
      const manifest = path.join(candidate, 'package.json');
      if (existsSync(manifest)) {
        const packageJson = readJson(manifest);
        workspaces.push({
          name: packageJson.name,
          directory: candidate,
          relativeDirectory: toPosix(path.relative(root, candidate)),
          packageJson,
        });
      } else {
        visit(candidate);
      }
    }
  };
  visit(path.join(root, 'apps'));
  visit(path.join(root, 'packages'));
  return workspaces.sort((left, right) => left.relativeDirectory.localeCompare(right.relativeDirectory));
}

function internalDependencies(workspace, knownNames) {
  return Object.keys(workspace.packageJson.dependencies ?? {}).filter(name => knownNames.has(name));
}

function declaredDependencies(workspace) {
  return new Set([
    ...Object.keys(workspace.packageJson.dependencies ?? {}),
    ...Object.keys(workspace.packageJson.devDependencies ?? {}),
    ...Object.keys(workspace.packageJson.optionalDependencies ?? {}),
    ...Object.keys(workspace.packageJson.peerDependencies ?? {}),
  ]);
}

function findCycles(graph) {
  const cycles = [];
  const visited = new Set();
  const active = [];
  const activeSet = new Set();

  const visit = node => {
    if (activeSet.has(node)) {
      const start = active.indexOf(node);
      cycles.push([...active.slice(start), node]);
      return;
    }
    if (visited.has(node)) return;
    active.push(node);
    activeSet.add(node);
    for (const dependency of graph.get(node) ?? []) visit(dependency);
    active.pop();
    activeSet.delete(node);
    visited.add(node);
  };

  for (const node of graph.keys()) visit(node);
  return cycles;
}

function exportedSubpath(packageJson, subpath) {
  if (!subpath) return true;
  const exportsField = packageJson.exports;
  return Boolean(exportsField && typeof exportsField === 'object' && Object.hasOwn(exportsField, `./${subpath}`));
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function inspectArchitecture(root = DEFAULT_ROOT) {
  const violations = [];
  const workspaces = discoverWorkspaces(root);
  const byName = new Map(workspaces.map(workspace => [workspace.name, workspace]));
  const knownNames = new Set(byName.keys());

  for (const workspace of workspaces) {
    if (!workspace.name?.startsWith('@personal-agent/')) {
      violations.push(`${workspace.relativeDirectory}: workspace name must use @personal-agent/*`);
    }
    if (!existsSync(path.join(workspace.directory, 'README.md'))) {
      violations.push(`${workspace.relativeDirectory}: README.md is required`);
    }
    if (workspace.relativeDirectory.startsWith('packages/') && !existsSync(path.join(workspace.directory, 'src', 'index.ts'))) {
      violations.push(`${workspace.relativeDirectory}: packages must expose src/index.ts`);
    }

    const dependencies = internalDependencies(workspace, knownNames);
    const declared = declaredDependencies(workspace);
    if (workspace.relativeDirectory.startsWith('packages/')) {
      for (const dependency of dependencies) {
        const target = byName.get(dependency);
        if (target?.relativeDirectory.startsWith('apps/')) {
          violations.push(`${workspace.relativeDirectory}: reusable package must not depend on app ${dependency}`);
        }
      }
    }

    if (workspace.relativeDirectory.startsWith('packages/connectors/')) {
      const allowed = new Set(['@personal-agent/contracts', '@personal-agent/connector-sdk']);
      for (const dependency of dependencies) {
        if (!allowed.has(dependency)) {
          violations.push(`${workspace.relativeDirectory}: connector production dependency ${dependency} is outside the connector boundary`);
        }
      }
    }

    const sourceRoots = ['src', 'electron'].map(name => path.join(workspace.directory, name));
    for (const sourceRoot of sourceRoots) {
      for (const file of collectFiles(sourceRoot, item => SOURCE_EXTENSIONS.has(path.extname(item)))) {
        const content = readFileSync(file, 'utf8');
        const internalImport = /['"](@personal-agent\/[^'"]+)['"]/g;
        for (const match of content.matchAll(internalImport)) {
          const specifier = match[1];
          const targetName = [...knownNames]
            .sort((left, right) => right.length - left.length)
            .find(name => specifier === name || specifier.startsWith(`${name}/`));
          if (!targetName) {
            violations.push(`${toPosix(path.relative(root, file))}: unknown internal import ${specifier}`);
            continue;
          }
          const subpath = specifier === targetName ? '' : specifier.slice(targetName.length + 1);
          if (targetName !== workspace.name && !declared.has(targetName)) {
            violations.push(`${toPosix(path.relative(root, file))}: ${targetName} is imported but not declared in dependencies`);
          }
          if (!exportedSubpath(byName.get(targetName).packageJson, subpath)) {
            violations.push(`${toPosix(path.relative(root, file))}: ${specifier} is not a declared public export`);
          }
        }

        const importSpecifier = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
        const sideEffectImport = /import\s+['"]([^'"]+)['"]/g;
        for (const pattern of [importSpecifier, sideEffectImport]) {
          for (const match of content.matchAll(pattern)) {
            const specifier = match[1];
            if (!specifier.startsWith('.')) continue;
            const target = path.resolve(path.dirname(file), specifier);
            if (!isWithin(workspace.directory, target)) {
              violations.push(`${toPosix(path.relative(root, file))}: relative import escapes its workspace (${specifier})`);
            }
          }
        }
      }
    }
  }

  const contracts = byName.get('@personal-agent/contracts');
  if (contracts) {
    for (const dependency of internalDependencies(contracts, knownNames)) {
      violations.push(`${contracts.relativeDirectory}: contracts must not depend on ${dependency}`);
    }
  }

  const graph = new Map(workspaces.map(workspace => [workspace.name, internalDependencies(workspace, knownNames)]));
  for (const cycle of findCycles(graph)) violations.push(`production dependency cycle: ${cycle.join(' -> ')}`);

  const rootSource = path.join(root, 'src');
  const rootSourceFiles = collectFiles(rootSource, file => statSync(file).isFile());
  for (const file of rootSourceFiles) {
    violations.push(`${toPosix(path.relative(root, file))}: production source must live in apps/ or packages/`);
  }

  return {
    root,
    workspaces: workspaces.map(workspace => workspace.relativeDirectory),
    violations: [...new Set(violations)].sort(),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = inspectArchitecture();
  if (report.violations.length) {
    console.error('Architecture check failed:');
    for (const violation of report.violations) console.error(`- ${violation}`);
    process.exitCode = 1;
  } else {
    console.log(`Architecture check passed for ${report.workspaces.length} workspaces.`);
  }
}
