$ErrorActionPreference = 'Stop'

# Fixed trusted metadata helper. It never writes Vault content or executes model supplied code.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class KnowledgeFinalizeIdentity {
  [StructLayout(LayoutKind.Sequential)] public struct FileInformation {
    public uint Attributes; public FILETIME CreationTime; public FILETIME LastAccessTime; public FILETIME LastWriteTime;
    public uint VolumeSerialNumber; public uint FileSizeHigh; public uint FileSizeLow;
    public uint NumberOfLinks; public uint FileIndexHigh; public uint FileIndexLow;
  }
  [StructLayout(LayoutKind.Sequential)] private struct Disposition { [MarshalAs(UnmanagedType.Bool)] public bool DeleteFile; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern uint GetFinalPathNameByHandleW(SafeFileHandle h, StringBuilder p, uint n, uint f);
  [DllImport("kernel32.dll", SetLastError=true)] private static extern bool GetFileInformationByHandle(SafeFileHandle h, out FileInformation i);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern SafeFileHandle CreateFileW(string p, uint a, uint s, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] private static extern bool SetFileInformationByHandle(SafeFileHandle h, int kind, ref Disposition info, uint size);
  public static void Check(SafeFileHandle h, string expected) {
    FileInformation i;
    if (!GetFileInformationByHandle(h, out i) || i.NumberOfLinks != 1 || (i.Attributes & 0x410) != 0) throw new IOException("Not regular");
    var p = new StringBuilder(32768); uint n=GetFinalPathNameByHandleW(h,p,(uint)p.Capacity,0);
    if (n==0 || n>=p.Capacity) throw new IOException("Unknown path");
    string actual=p.ToString(); if(actual.StartsWith(@"\\?\")) actual=actual.Substring(4);
    if(!string.Equals(Path.GetFullPath(actual),Path.GetFullPath(expected),StringComparison.OrdinalIgnoreCase)) throw new IOException("Changed path");
  }
  public static FileStream OpenMarker(string p) {
    var h=CreateFileW(p,0x80000000u | 0x00010000u,0,IntPtr.Zero,3,0x00200000u,IntPtr.Zero);
    if(h.IsInvalid) {h.Dispose();throw new Win32Exception(Marshal.GetLastWin32Error());}
    try {Check(h,p);return new FileStream(h,FileAccess.Read);} catch {h.Dispose();throw;}
  }
  public static void DeleteHeldMarker(SafeFileHandle h) {
    var d=new Disposition {DeleteFile=true};
    if(!SetFileInformationByHandle(h,4,ref d,(uint)Marshal.SizeOf(typeof(Disposition)))) throw new Win32Exception(Marshal.GetLastWin32Error());
  }
}
'@

function Read-Bytes([System.IO.FileStream] $Stream, [int] $Limit) {
  if ($Stream.Length -gt $Limit) {throw 'Limit'}
  $Stream.Position=0; $bytes=[byte[]]::new([int]$Stream.Length); $offset=0
  while($offset -lt $bytes.Length) {
    $count=$Stream.Read($bytes,$offset,$bytes.Length-$offset)
    if($count -eq 0){throw 'Short read'}; $offset+=$count
  }
  return ,$bytes
}
function Hash-Bytes([byte[]] $Bytes) {return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant()}
function Check-Deadline($Request) {
  # PowerShell may deserialize ISO Z as DateTime; preserve its Kind instead of reparsing a locale string.
  $expires=if($Request.deadline -is [DateTime]){([DateTime]$Request.deadline).ToUniversalTime()}
    else{[DateTimeOffset]::Parse([string]$Request.deadline).UtcDateTime}
  if($expires -le [DateTime]::UtcNow){throw 'Expired'}
}
function Invoke-Finalize($Request) {
  $source=$null; $operation=$null; $knowledge=$null; $shared=$null
  $a=$Request.accepted
  $unknown=@{state='still_unknown';operationId=[string]$a.operationId}
  try {
    Check-Deadline $Request
    $root=[IO.Path]::GetFullPath($Request.rootPath).TrimEnd('\')+'\'
    if(-not [IO.Path]::GetFullPath($Request.sourcePath).StartsWith($root,[StringComparison]::OrdinalIgnoreCase)){return $unknown}
    $source=[IO.FileStream]::new($Request.sourcePath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None)
    [KnowledgeFinalizeIdentity]::Check($source.SafeFileHandle,$Request.sourcePath)
    $current=Hash-Bytes (Read-Bytes $source 524288)
    if($current -ne $a.currentSha256 -or $current -ne $(if($a.outcome -eq 'applied'){$Request.afterSha256}else{$Request.beforeSha256})){return $unknown}
    $operation=[IO.FileStream]::new($Request.operationPath,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    [KnowledgeFinalizeIdentity]::Check($operation.SafeFileHandle,$Request.operationPath)
    $record=[Text.UTF8Encoding]::new($false,$true).GetString((Read-Bytes $operation 1048576)) | ConvertFrom-Json -AsHashtable
    if($record.version -ne 1 -or $record.taskId -ne $a.taskId -or $record.runId -ne $a.runId -or
      $record.argumentsDigest -ne $a.argumentsDigest -or $record.operationId -ne $a.operationId -or
      $record.sourceId -ne $a.originalInput.sourceId -or $record.configRevision -ne $a.originalInput.configRevision -or
      $record.path -ne $a.originalInput.path -or $record.beforeSha256 -ne $Request.beforeSha256 -or $record.afterSha256 -ne $Request.afterSha256){return $unknown}
    if($record.ContainsKey('finalization') -and ($record.finalization.executionRecordId -ne $a.executionRecordId -or
      $record.finalization.outcome -ne $a.outcome -or $record.finalization.currentSha256 -ne $current)){return $unknown}
    if([IO.File]::Exists($Request.knowledgeMarker)) {
      $knowledge=[KnowledgeFinalizeIdentity]::OpenMarker($Request.knowledgeMarker)
      $id=[Text.UTF8Encoding]::new($false,$true).GetString((Read-Bytes $knowledge 256))
      if($id -ne $a.operationId){return $unknown}
    }
    if([IO.File]::Exists($Request.sharedMarker)) {
      $shared=[KnowledgeFinalizeIdentity]::OpenMarker($Request.sharedMarker)
      $m=[Text.UTF8Encoding]::new($false,$true).GetString((Read-Bytes $shared 8192)) | ConvertFrom-Json -AsHashtable
      if($m.Count -ne 6 -or $m.runId -ne $a.runId -or $m.argumentsDigest -ne $a.argumentsDigest -or
        $m.beforeSha256 -ne $Request.beforeSha256 -or $m.afterSha256 -ne $Request.afterSha256 -or
        $m.pid -isnot [long] -and $m.pid -isnot [int] -or $m.pid -lt 1 -or $m.pid -gt 2147483647 -or
        [string]$m.startTimeTicks -notmatch '^[1-9][0-9]{0,18}$'){return $unknown}
      try {$p=[Diagnostics.Process]::GetProcessById([int]$m.pid);$p.Dispose();return $unknown}
      catch [ArgumentException] { } # Only OS process-not-found confirms the original helper has stopped.
    }
    Check-Deadline $Request
    if((Hash-Bytes (Read-Bytes $source 524288)) -ne $current){return $unknown}
    # Persist trusted Runtime acceptance before releasing any marker. Keep all original bytes and backups.
    $record.finalization=@{executionRecordId=$a.executionRecordId;readbackEvidenceRefs=$a.readbackEvidenceRefs;
      toolName=$a.toolName;toolVersion=$a.toolVersion;outcome=$a.outcome;currentSha256=$current}
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($record | ConvertTo-Json -Depth 32 -Compress))
    $operation.Position=0;$operation.Write($bytes,0,$bytes.Length);$operation.SetLength($bytes.Length);$operation.Flush($true)
    if((Hash-Bytes (Read-Bytes $operation 1048576)) -ne (Hash-Bytes $bytes)){return $unknown}
    Check-Deadline $Request
    if($null -ne $shared){[KnowledgeFinalizeIdentity]::DeleteHeldMarker($shared.SafeFileHandle)}
    if($null -ne $knowledge){[KnowledgeFinalizeIdentity]::DeleteHeldMarker($knowledge.SafeFileHandle)}
    return @{state='finalized';operationId=[string]$a.operationId;outcome=[string]$a.outcome;currentSha256=$current}
  } catch {return $unknown}
  finally {
    if($null -ne $shared){$shared.Dispose()};if($null -ne $knowledge){$knowledge.Dispose()}
    if($null -ne $operation){$operation.Dispose()};if($null -ne $source){$source.Dispose()}
  }
}
try {
  [Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
  $request=[Console]::In.ReadToEnd() | ConvertFrom-Json -AsHashtable
  [Console]::Out.WriteLine((Invoke-Finalize $request | ConvertTo-Json -Compress))
} catch {[Console]::Out.WriteLine('{"state":"still_unknown","operationId":""}')}
