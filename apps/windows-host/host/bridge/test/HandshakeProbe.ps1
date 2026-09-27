param(
    [Parameter(Mandatory = $true)][string]$BridgeExe,
    [Parameter(Mandatory = $true)][string]$HostExe,
    [string]$SchemaPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$bridge = (Resolve-Path -LiteralPath $BridgeExe).Path
$hostProcess = (Resolve-Path -LiteralPath $HostExe).Path
$schemaDestination = Join-Path (Split-Path -Parent $hostProcess) 'windows-host.json'
if ($SchemaPath) {
    Copy-Item -LiteralPath $SchemaPath -Destination $schemaDestination -Force
}
if (-not (Test-Path -LiteralPath $schemaDestination)) {
    throw 'Windows Host 0.1.0 schema is absent from the Host output directory'
}

$start = [System.Diagnostics.ProcessStartInfo]::new($bridge)
$start.ArgumentList.Add('--host')
$start.ArgumentList.Add($hostProcess)
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$start.RedirectStandardInput = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$process = [System.Diagnostics.Process]::Start($start)
try {
    $readyTask = $process.StandardError.ReadLineAsync()
    if (-not $readyTask.Wait(10000)) { throw 'Bridge readiness timeout' }
    if ($readyTask.Result -ne 'VERIFIED') { throw 'Bridge did not verify its OS pipe peer' }
    Write-Output 'bridge_readiness=VERIFIED'

    $hello = '{"kind":"hello","protocolVersion":"0.1.0","requestId":"bridge-probe-1","clientNonce":"11111111111111111111111111111111"}'
    # WriteLine emits CRLF on Windows. The 0.1.0 protocol requires LF only.
    $process.StandardInput.Write($hello + [char]10)
    $process.StandardInput.Flush()
    $replyTask = $process.StandardOutput.ReadLineAsync()
    if (-not $replyTask.Wait(5000)) { throw 'Windows Host hello_ack timeout' }
    if ($null -eq $replyTask.Result) { throw 'Windows Host closed before hello_ack' }
    $reply = $replyTask.Result | ConvertFrom-Json
    if ($reply.kind -ne 'hello_ack' -or $reply.protocolVersion -ne '0.1.0' -or
        $reply.requestId -ne 'bridge-probe-1' -or
        $reply.clientNonce -ne '11111111111111111111111111111111') {
        throw 'Windows Host hello_ack correlation mismatch'
    }
    Write-Output 'host_reply=hello_ack request_match=true nonce_match=true version_match=true'
    $process.StandardInput.Close()
    if (-not $process.WaitForExit(5000)) { throw 'Bridge exit timeout' }
    if ($process.ExitCode -ne 0) { throw 'Bridge did not exit normally' }
    Write-Output 'bridge_exit=0'
}
finally {
    if (-not $process.HasExited) {
        $process.Kill($true)
        $process.WaitForExit(5000) | Out-Null
    }
    $process.Dispose()
}
