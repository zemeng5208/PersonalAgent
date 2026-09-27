import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

if (process.platform !== 'win32') throw Error('Windows Host requires Windows and the .NET 8 SDK');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
for (const project of ['apps/windows-host/host/WindowsHost.Host.csproj',
  'apps/windows-host/host/bridge/WindowsHost.PipeBridge.csproj']) {
  const result = spawnSync('dotnet', ['build', project, '--configuration', 'Release', '--nologo', '-m:1'],
    {cwd: root, windowsHide: true, stdio: 'inherit'});
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
