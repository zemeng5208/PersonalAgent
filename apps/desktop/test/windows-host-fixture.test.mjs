import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));

test('Windows Host .NET 8 controlled fixture builds and runs from isolated artifacts', {
  skip: process.platform !== 'win32' ? 'Windows-only .NET HostFixture; this is not UIA device validation' : false,
  timeout: 180_000,
}, t => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'pa-windows-host-fixture-'));
  t.after(() => rmSync(temporary, {recursive: true, force: true, maxRetries: 5, retryDelay: 100}));
  const env = {...process.env, DOTNET_CLI_HOME: path.join(temporary, 'cli-home'),
    DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1',
    DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE: 'true'};
  const dotnet = (args, timeout, phase) => {
    const result = spawnSync('dotnet', args, {cwd: temporary, env, windowsHide: true,
      shell: false, encoding: 'utf8', timeout, maxBuffer: 1024 * 1024});
    assert.ifError(result.error);
    const diagnostic = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.slice(-12_000);
    assert.equal(result.signal, null, `${phase} was interrupted: ${diagnostic}`);
    assert.equal(result.status, 0, `${phase} failed: ${diagnostic}`);
    return result.stdout;
  };

  // Missing SDKs fail on Windows; only the platform gate may skip this fixture.
  const installed = dotnet(['--list-sdks'], 10_000, 'SDK discovery');
  const versions = [...installed.matchAll(/^8\.0\.(\d+)\s+\[[^\r\n]+\]\r?$/gm)]
    .map(match => Number(match[1])).sort((a, b) => b - a);
  assert.ok(versions.length > 0, 'Windows HostFixture requires an installed stable .NET 8 SDK');
  writeFileSync(path.join(temporary, 'global.json'), JSON.stringify({sdk: {
    version: `8.0.${versions[0]}`, rollForward: 'disable',
  }}));

  const artifacts = path.join(temporary, 'artifacts');
  dotnet(['build', path.join(root, 'apps/windows-host/host/test/WindowsHost.HostFixture.csproj'),
    '--configuration', 'Release', '--artifacts-path', artifacts, '--disable-build-servers',
    '--nologo', '--verbosity', 'quiet', '-m:1'], 120_000, 'HostFixture build');

  // Discover the real executable output beside its runtime configuration;
  // obj/ref DLLs and SDK-specific artifact pivot names are not runnable outputs.
  const outputs = readdirSync(artifacts, {recursive: true, withFileTypes: true})
    .filter(entry => entry.isFile() && entry.name === 'WindowsHost.HostFixture.dll')
    .map(entry => path.join(entry.parentPath, entry.name))
    .filter(file => existsSync(path.join(path.dirname(file), 'WindowsHost.HostFixture.runtimeconfig.json')));
  assert.equal(outputs.length, 1, 'Expected exactly one built HostFixture executable output');
  const output = dotnet([outputs[0], path.join(root, 'packages/contracts/schema/windows-host.json'),
    path.join(root, 'packages/contracts/fixtures/windows-host.json')], 30_000, 'HostFixture execution');
  assert.match(output, /^Windows Host portable contract and durable-run fixture passed\r?$/m,
    'HostFixture exited without its actual completion marker');
});
