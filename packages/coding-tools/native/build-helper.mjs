#!/usr/bin/env node
/**
 * @file packages/coding-tools/native/build-helper.mjs
 *
 * Bounded development build helper for WindowsJobProcessHost.exe.
 * Publishes the .NET 8 Win32 Job Object host into an explicit, trusted host-specified directory
 * (e.g. Desktop Main app userData/native-helper).
 *
 * Invariants:
 * 1. Requires explicit target directory; rejects defaults to workspace or repo directory.
 * 2. Requires pre-installed .NET 8 SDK; never automatically downloads or installs SDKs.
 * 3. Never uses ExecutionPolicy bypass or shell scripts.
 * 4. Outputs canonical path to the published executable.
 */

import {spawnSync} from 'node:child_process';
import {existsSync, lstatSync, mkdirSync, realpathSync, statSync} from 'node:fs';
import path from 'node:path';

export function resolveRepoRoot() {
  return realpathSync.native(path.resolve(import.meta.dirname, '..', '..', '..'));
}

export function buildNativeHelper({targetDir, configuration = 'Release'} = {}) {
  if (process.platform !== 'win32') {
    throw Error('WindowsJobProcessHost is only supported on Windows');
  }

  if (typeof targetDir !== 'string' || !path.isAbsolute(targetDir) || targetDir.startsWith('\\\\')) {
    throw Error('Explicit local absolute target directory is required');
  }

  const repoRoot = resolveRepoRoot();
  const resolvedTarget = path.resolve(targetDir);

  // Security: Target directory MUST reside outside the repository / workspace
  const fromRepo = path.relative(repoRoot, resolvedTarget);
  if (fromRepo === '' || (!fromRepo.startsWith('..') && !path.isAbsolute(fromRepo))) {
    throw Error(`Target directory must reside outside the PersonalAgent repository root (${repoRoot})`);
  }

  if (!existsSync(resolvedTarget)) {
    mkdirSync(resolvedTarget, {recursive: true});
  }

  if (lstatSync(resolvedTarget).isSymbolicLink()) {
    throw Error('Target directory must not be a symbolic link');
  }

  const canonicalTarget = realpathSync.native(resolvedTarget);
  if (!statSync(canonicalTarget).isDirectory()) {
    throw Error('Target directory must be a directory');
  }

  // 1. Check for dotnet SDK
  const dotnetCheck = spawnSync('dotnet', ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
  });

  if (dotnetCheck.error || dotnetCheck.status !== 0) {
    throw Error(
      '.NET SDK is required to build WindowsJobProcessHost.exe but "dotnet" was not found on PATH. ' +
      'Please install the .NET 8 SDK from https://dotnet.microsoft.com/download/dotnet/8.0'
    );
  }

  const csprojPath = path.join(import.meta.dirname, 'WindowsJobProcessHost.csproj');
  if (!existsSync(csprojPath)) {
    throw Error(`WindowsJobProcessHost.csproj not found at ${csprojPath}`);
  }

  // 2. Publish project to target directory
  const publishArgs = [
    'publish',
    csprojPath,
    '-c', configuration,
    '-o', canonicalTarget,
    '--nologo',
    '-v', 'quiet',
  ];

  const publishResult = spawnSync('dotnet', publishArgs, {
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
  });

  if (publishResult.status !== 0) {
    const errOutput = publishResult.stderr?.trim() || publishResult.stdout?.trim() || 'Unknown build failure';
    throw Error(`Failed to build WindowsJobProcessHost: ${errOutput}`);
  }

  const expectedExe = path.join(canonicalTarget, 'WindowsJobProcessHost.exe');
  if (!existsSync(expectedExe)) {
    throw Error(`Expected output executable was not found at ${expectedExe}`);
  }

  const canonicalExe = realpathSync.native(expectedExe);
  return {
    helperPath: canonicalExe,
    targetDir: canonicalTarget,
    configuration,
  };
}

// CLI entrypoint
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  let targetDir = null;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--target-dir' || args[i] === '--output-dir') && i + 1 < args.length) {
      targetDir = args[++i];
    }
  }

  if (!targetDir) {
    console.error('Usage: node build-helper.mjs --target-dir <external-directory>');
    process.exit(1);
  }

  try {
    const result = buildNativeHelper({targetDir});
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(`build-helper error: ${err.message}`);
    process.exit(1);
  }
}
