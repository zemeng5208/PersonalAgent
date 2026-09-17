param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('recognize', 'speak')]
    [string]$Mode
)

# Fixed Windows System.Speech host. Input/output use only bounded stdio frames.
# The launcher supplies no arbitrary command, path, culture, device or credential.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$taskCultureName = 'zh-CN'
$taskMaxAudioBytes = 1920000
$taskMaxTextBytes = 32768
$taskMaxTextCharacters = 8000
$taskExitCode = 1
$taskResponse = [ordered]@{ ok = $false; code = 'EXTERNAL_FAILURE' }
$taskInput = [Console]::OpenStandardInput()
$taskMemory = [System.IO.MemoryStream]::new()
$taskBlock = [byte[]]::new(8192)
$taskEngine = $null
$taskSynthesizer = $null
$taskBytes = $null

try {
    Add-Type -AssemblyName System.Speech
    $taskLimit = if ($Mode -eq 'recognize') { $taskMaxAudioBytes } else { $taskMaxTextBytes }
    while (($taskRead = $taskInput.Read($taskBlock, 0, $taskBlock.Length)) -gt 0) {
        if ($taskMemory.Length + $taskRead -gt $taskLimit) { throw 'bounded-input-rejected' }
        $taskMemory.Write($taskBlock, 0, $taskRead)
    }
    if ($taskMemory.Length -le 0) { throw 'empty-input-rejected' }
    $taskMemory.Position = 0
    $taskCulture = [System.Globalization.CultureInfo]::GetCultureInfo($taskCultureName)

    if ($Mode -eq 'recognize') {
        if ($taskMemory.Length % 2 -ne 0) { throw 'invalid-pcm-frame' }
        $taskRecognizer = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() |
            Where-Object { $_.Culture.Name -eq $taskCultureName } |
            Select-Object -First 1
        if ($null -eq $taskRecognizer) { throw [System.NotSupportedException]::new() }
        $taskEngine = [System.Speech.Recognition.SpeechRecognitionEngine]::new($taskRecognizer)
        $taskGrammar = [System.Speech.Recognition.DictationGrammar]::new()
        $taskEngine.LoadGrammar($taskGrammar)
        $taskFormat = [System.Speech.AudioFormat.SpeechAudioFormatInfo]::new(
            16000,
            [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
            [System.Speech.AudioFormat.AudioChannel]::Mono)
        $taskEngine.SetInputToAudioStream($taskMemory, $taskFormat)
        $taskResult = $taskEngine.Recognize()
        if ($null -eq $taskResult -or [string]::IsNullOrWhiteSpace($taskResult.Text) -or
            $taskResult.Text.Length -gt $taskMaxTextCharacters) {
            throw 'recognition-result-rejected'
        }
        $taskResponse = [ordered]@{ ok = $true; text = $taskResult.Text; locale = $taskCultureName }
    }
    else {
        $taskBytes = $taskMemory.ToArray()
        try {
            $taskText = [System.Text.Encoding]::UTF8.GetString($taskBytes)
            if ([string]::IsNullOrWhiteSpace($taskText) -or $taskText.Length -gt $taskMaxTextCharacters) {
                throw 'speech-text-rejected'
            }
            $taskSynthesizer = [System.Speech.Synthesis.SpeechSynthesizer]::new()
            $taskVoice = $taskSynthesizer.GetInstalledVoices() |
                Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq $taskCultureName } |
                Select-Object -First 1
            if ($null -eq $taskVoice) { throw [System.NotSupportedException]::new() }
            $taskSynthesizer.SelectVoice($taskVoice.VoiceInfo.Name)
            $taskSynthesizer.SetOutputToDefaultAudioDevice()
            $taskSynthesizer.Speak($taskText)
            $taskSynthesizer.SetOutputToNull()
            $taskResponse = [ordered]@{ ok = $true; locale = $taskCultureName }
        }
        finally {
            if ($null -ne $taskBytes) { [Array]::Clear($taskBytes, 0, $taskBytes.Length) }
        }
    }
    $taskExitCode = 0
}
catch [System.NotSupportedException] {
    $taskResponse = [ordered]@{ ok = $false; code = 'UNSUPPORTED_CAPABILITY' }
    $taskExitCode = 2
}
catch {
    $taskResponse = [ordered]@{ ok = $false; code = 'EXTERNAL_FAILURE' }
    $taskExitCode = 1
}
finally {
    if ($null -ne $taskEngine) { $taskEngine.Dispose() }
    if ($null -ne $taskSynthesizer) { $taskSynthesizer.Dispose() }
    try {
        $taskBacking = $taskMemory.GetBuffer()
        [Array]::Clear($taskBacking, 0, $taskBacking.Length)
    }
    catch {}
    [Array]::Clear($taskBlock, 0, $taskBlock.Length)
    $taskMemory.Dispose()
    [Console]::Out.WriteLine(($taskResponse | ConvertTo-Json -Compress))
}
exit $taskExitCode
