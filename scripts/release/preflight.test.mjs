import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runReleasePreflight } from './preflight.mjs';

function write(root, relativePath, contents) {
  const target = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function writeJson(root, relativePath, value) {
  write(root, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createFixture({ buildOutputs = true, malformedDesktop = false, unsafeMain = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-release-preflight-'));
  writeJson(root, 'package.json', {
    name: 'fixture',
    engines: { node: '24.15.x' },
  });
  write(root, '.node-version', '24.15.0\n');
  writeJson(root, 'package-lock.json', {
    packages: {
      'node_modules/electron': {
        version: '44.2.0',
        engines: { node: '>=22.12.0' },
      },
    },
  });

  if (malformedDesktop) {
    write(root, 'apps/desktop/package.json', '{ invalid json');
  } else {
    writeJson(root, 'apps/desktop/package.json', {
      name: '@personal-agent/desktop',
      main: unsafeMain ? '../../private.txt' : 'electron/main.js',
      scripts: {
        start: 'electron .',
        typecheck: 'node --check electron/main.js',
        'test:smoke': 'node test/smoke.cjs',
        'test:runtime-application-smoke': 'node test/runtime-smoke.cjs',
      },
      dependencies: {
        '@personal-agent/client': '1.0.0',
        '@personal-agent/runtime': '1.0.0',
      },
      devDependencies: { electron: '44.2.0' },
    });
  }
  write(
    root,
    'apps/desktop/electron/main.js',
    "const html = '../src/app/index.html'; const preload = 'preload.cjs'; import('@personal-agent/runtime/application');\n",
  );
  write(root, 'apps/desktop/electron/preload.cjs', 'module.exports = {};\n');
  write(root, 'apps/desktop/src/app/index.html', '<script type="module" src="./renderer.js"></script>\n');
  write(root, 'apps/desktop/src/app/renderer.js', 'export {};\n');

  writeJson(root, 'apps/runtime/package.json', {
    name: '@personal-agent/runtime',
    exports: {
      '.': { import: './dist/index.js' },
      './application': { import: './dist/application.js' },
    },
    dependencies: { '@personal-agent/storage': '1.0.0' },
  });
  writeJson(root, 'packages/client/package.json', {
    name: '@personal-agent/client',
    exports: { '.': { import: './dist/index.js' } },
  });
  writeJson(root, 'packages/storage/package.json', {
    name: '@personal-agent/storage',
    exports: { '.': { import: './dist/index.js' } },
  });
  write(root, 'packages/storage/src/index.ts', "import { DatabaseSync } from 'node:sqlite';\n");

  if (buildOutputs) {
    write(root, 'apps/runtime/dist/index.js', 'export {};\n');
    write(root, 'apps/runtime/dist/application.js', 'export {};\n');
    write(root, 'packages/client/dist/index.js', 'export {};\n');
    write(root, 'packages/storage/dist/index.js', 'export {};\n');
  }
  return root;
}

function byId(report, id) {
  return report.checks.find((check) => check.id === id);
}

test('valid source and build outputs are ready only for the packaging step', (t) => {
  const root = createFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const report = runReleasePreflight(root);

  assert.equal(report.publishable, false);
  assert.equal(report.releaseStatus, 'blocked');
  assert.equal(report.nextStep, 'implement_packaging');
  assert.equal(byId(report, 'desktop-main').status, 'pass');
  assert.equal(byId(report, 'runtime-application-export').status, 'pass');
  assert.equal(byId(report, 'production-packaging-config').code, 'PACKAGING_CONFIG_MISSING');
  assert.equal(byId(report, 'sqlite-packaged-electron-smoke').status, 'blocked');
  assert.ok(report.checks.filter((check) => check.id.startsWith('build-output-')).every(
    (check) => check.status === 'pass',
  ));
});

test('missing output and source files are listed without exposing the absolute root', (t) => {
  const root = createFixture({ buildOutputs: false });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.rmSync(path.join(root, 'apps/desktop/electron/preload.cjs'));

  const report = runReleasePreflight(root);
  const serialized = JSON.stringify(report);

  assert.equal(report.nextStep, 'fix_project_structure');
  assert.equal(byId(report, 'desktop-preload').code, 'DESKTOP_PRELOAD_MISSING');
  assert.ok(report.checks.some((check) => check.code === 'BUILD_OUTPUT_MISSING'));
  assert.equal(serialized.includes(root), false);
  assert.equal(serialized.includes(path.dirname(root)), false);
});

test('missing build outputs select the build step without running a build', (t) => {
  const root = createFixture({ buildOutputs: false });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const report = runReleasePreflight(root);

  assert.equal(report.nextStep, 'run_build');
  assert.equal(report.publishable, false);
  assert.ok(report.checks.some((check) => check.code === 'BUILD_OUTPUT_MISSING'));
});

test('invalid manifests and unsafe paths use fixed errors without echoing input', (t) => {
  const malformedRoot = createFixture({ malformedDesktop: true });
  const unsafeRoot = createFixture({ unsafeMain: true });
  t.after(() => fs.rmSync(malformedRoot, { recursive: true, force: true }));
  t.after(() => fs.rmSync(unsafeRoot, { recursive: true, force: true }));

  const malformed = runReleasePreflight(malformedRoot);
  const unsafe = runReleasePreflight(unsafeRoot);

  writeJson(unsafeRoot, 'apps/runtime/package.json', {
    name: '@personal-agent/runtime',
    exports: { './application': { import: '../../private-runtime.js' } },
  });
  const unsafeRuntime = runReleasePreflight(unsafeRoot);

  assert.equal(byId(malformed, 'desktop-manifest').code, 'DESKTOP_MANIFEST_INVALID');
  assert.equal(byId(unsafe, 'desktop-main').code, 'DESKTOP_MAIN_PATH_INVALID');
  assert.equal(byId(unsafeRuntime, 'runtime-application-export').code, 'RUNTIME_APPLICATION_EXPORT_INVALID');
  assert.equal(JSON.stringify(unsafe).includes('../../private.txt'), false);
  assert.equal(JSON.stringify(unsafeRuntime).includes('../../private-runtime.js'), false);
  assert.equal(malformed.publishable, false);
  assert.equal(unsafe.publishable, false);
});

test('workspace junctions that escape the project root are not read', (t) => {
  const root = createFixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-release-outside-'));
  const storagePath = path.join(root, 'packages/storage');
  fs.rmSync(storagePath, { recursive: true, force: true });
  writeJson(outside, 'package.json', {
    name: '@personal-agent/storage',
    exports: { '.': { import: './dist/index.js' } },
  });
  write(outside, 'dist/index.js', 'export const outside = true;\n');
  fs.symlinkSync(outside, storagePath, process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => {
    try {
      fs.unlinkSync(storagePath);
    } catch {}
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  const report = runReleasePreflight(root);
  const serialized = JSON.stringify(report);

  assert.ok(report.checks.some((check) => check.code === 'INTERNAL_WORKSPACE_MISSING'));
  assert.equal(serialized.includes(outside), false);
  assert.equal(serialized.includes('outside = true'), false);
});

test('malformed installer target is blocked without invoking an untrusted includes property', (t) => {
  const root = createFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const desktop = JSON.parse(fs.readFileSync(path.join(root, 'apps/desktop/package.json'), 'utf8'));
  desktop.build = { win: { target: { includes: 1 } } };
  writeJson(root, 'apps/desktop/package.json', desktop);

  const report = runReleasePreflight(root);

  assert.equal(byId(report, 'windows-installer-definition').status, 'blocked');
  assert.equal(byId(report, 'windows-installer-definition').code, 'INSTALLER_DEFINITION_MISSING');
  assert.equal(report.publishable, false);
});

test('evidence file presence remains unverified and never becomes a publish decision', (t) => {
  const root = createFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const relativePath of [
    'tests/manual/release/windows-install-start.json',
    'tests/manual/release/windows-upgrade-data-retention.json',
    'tests/manual/release/windows-uninstall.json',
  ]) {
    write(root, relativePath, '{}\n');
  }

  const report = runReleasePreflight(root);

  assert.equal(report.publishable, false);
  assert.equal(report.releaseStatus, 'blocked');
  assert.ok(report.checks.filter((check) => check.id.startsWith('release-')).every(
    (check) => check.status === 'unverified' && check.code === 'MANUAL_EVIDENCE_NOT_EXECUTED',
  ));
});
