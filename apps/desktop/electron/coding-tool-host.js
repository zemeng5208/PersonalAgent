import {execFileSync} from 'node:child_process';
import {lstatSync, readdirSync, realpathSync, statSync} from 'node:fs';
import path from 'node:path';

const ACL_CHECK = String.raw`
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'PowerShell 7 required' }
$root = [Console]::In.ReadToEnd().Trim()
$acl = Get-Acl -LiteralPath $root
$self = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$owner = ([System.Security.Principal.NTAccount]$acl.Owner).Translate([System.Security.Principal.SecurityIdentifier]).Value
$trusted = @($self, 'S-1-5-18', 'S-1-5-32-544')
$rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
$secure = $acl.AreAccessRulesProtected -and $owner -eq $self
foreach ($rule in $rules) {
  if ($rule.IsInherited -or ($rule.AccessControlType -eq 'Allow' -and $trusted -notcontains $rule.IdentityReference.Value)) {
    $secure = $false
  }
}
if ($secure) { [Console]::Out.Write('secure') } else { [Console]::Out.Write('unsafe') }
`;

function canonicalDirectory(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw Error(`${label} must be an absolute path`);
  const full = path.resolve(value);
  if (lstatSync(full).isSymbolicLink()) throw Error(`${label} must not be a link`);
  const canonical = realpathSync.native(full);
  if (!statSync(canonical).isDirectory()) throw Error(`${label} must be a directory`);
  return canonical;
}

function canonicalFile(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw Error(`${label} must be an absolute path`);
  const full = path.resolve(value);
  if (lstatSync(full).isSymbolicLink()) throw Error(`${label} must not be a link`);
  const canonical = realpathSync.native(full);
  if (!statSync(canonical).isFile()) throw Error(`${label} must be a file`);
  return canonical;
}

function atOrWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function identity(value, executable = false) {
  const file = statSync(value, {bigint: true});
  return {dev: file.dev, ino: file.ino, birthtimeNs: file.birthtimeNs,
    ...(executable ? {size: file.size, mtimeNs: file.mtimeNs} : {})};
}

function sameIdentity(left, right) {
  return Object.keys(left).every(key => left[key] === right[key]);
}

/** The recovery directory must be pre-created with a protected, current-user ACL. */
export function verifyWindowsRecoveryAcl(recoveryRootPath, powerShellPath) {
  if (process.platform !== 'win32') throw Error('Windows recovery ACL inspection is unavailable');
  const output = execFileSync(powerShellPath,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ACL_CHECK, 'utf16le').toString('base64')],
    {input: recoveryRootPath, encoding: 'utf8', timeout: 10_000, maxBuffer: 4096, windowsHide: true});
  if (output !== 'secure') throw Error('Recovery directory ACL is not restricted to the current user');
}

/** Read-only startup inventory. An unresolved marker requires a separate trusted reconciliation. */
export function listPendingCodingHelpers(recoveryRootPath) {
  return readdirSync(recoveryRootPath).filter(name => name.endsWith('.inflight')).sort();
}

/** Bind only trusted main-process paths and factory. inspectAcl is for isolated host tests.
 * Policy and ToolGateway still own every execution decision and result state. */
export function createDesktopCodingToolHost({workspaceRoot, authorizedWorkspaceRoot,
  recoveryRootPath, powerShellPath, createWorkspacePatchApplyTool,
  inspectAcl = verifyWindowsRecoveryAcl}) {
  if (process.platform !== 'win32') throw Error('Coding patch host requires Windows');
  const root = canonicalDirectory(workspaceRoot, 'Workspace root');
  const authorized = canonicalDirectory(authorizedWorkspaceRoot, 'Authorized workspace root');
  if (root !== authorized) throw Error('Workspace root is outside the fixed Desktop authorization');
  const recovery = canonicalDirectory(recoveryRootPath, 'Recovery root');
  const powerShell = canonicalFile(powerShellPath, 'PowerShell 7 executable');
  if (path.basename(powerShell).toLowerCase() !== 'pwsh.exe') throw Error('PowerShell 7 executable is required');
  if (atOrWithin(root, recovery) || atOrWithin(recovery, root)
    || atOrWithin(root, powerShell) || atOrWithin(recovery, powerShell)) {
    throw Error('Coding host paths must be separate from the workspace and recovery root');
  }
  inspectAcl(recovery, powerShell);
  const pinned = [
    {source: workspaceRoot, canonical: root, directory: true, id: identity(root)},
    {source: recoveryRootPath, canonical: recovery, directory: true, id: identity(recovery)},
    {source: powerShellPath, canonical: powerShell, directory: false, id: identity(powerShell, true)},
  ];
  const pendingHelpers = listPendingCodingHelpers(recovery);
  if (pendingHelpers.length) throw Error('Unresolved coding helper requires trusted reconciliation');
  if (typeof createWorkspacePatchApplyTool !== 'function') throw Error('Public patch apply factory is unavailable');
  const implementation = createWorkspacePatchApplyTool({rootPath: root, recoveryRootPath: recovery,
    powerShellPath: powerShell});
  if (implementation?.descriptor?.name !== 'workspace.apply_text_patch'
    || implementation.descriptor.version !== '1.0.0'
    || implementation.descriptor.sideEffect !== 'local_write'
    || typeof implementation.execute !== 'function') {
    throw Error('Unexpected coding patch tool descriptor');
  }
  let active = true;
  const available = () => {
    if (!active) return false;
    try {
      for (const entry of pinned) {
        const current = entry.directory
          ? canonicalDirectory(entry.source, 'Pinned coding directory')
          : canonicalFile(entry.source, 'Pinned PowerShell executable');
        if (current !== entry.canonical
          || !sameIdentity(entry.id, identity(current, !entry.directory))) return false;
      }
      inspectAcl(recovery, powerShell);
      return listPendingCodingHelpers(recovery).length === 0;
    } catch { return false; }
  };
  const tool = {descriptor: implementation.descriptor, execute: (input, context) => {
    if (!available()) throw Error('Coding patch host is closed or requires helper reconciliation');
    return implementation.execute(input, context);
  }};
  return {
    tools: [tool],
    pendingHelpers,
    available,
    close: () => { active = false; },
  };
}
