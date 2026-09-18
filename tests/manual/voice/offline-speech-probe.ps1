# Synthetic local probe only. No microphone, speakers, network or audio files.
# Run with Windows PowerShell 5.1; System.Speech is supplied by Windows/.NET Framework.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech

$taskCulture = [System.Globalization.CultureInfo]::GetCultureInfo('zh-CN')
$taskRecognizerInfo = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() |
    Where-Object { $_.Culture.Name -eq $taskCulture.Name } | Select-Object -First 1
if ($null -eq $taskRecognizerInfo) { throw 'No installed zh-CN recognizer; no fallback attempted.' }

$taskSynth = $null
$taskEngine = $null
$taskAudio = New-Object System.IO.MemoryStream
try {
    $taskSynth = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $taskVoice = $taskSynth.GetInstalledVoices() |
        Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq $taskCulture.Name } |
        Select-Object -First 1
    if ($null -eq $taskVoice) { throw 'No installed zh-CN synthesis voice; no fallback attempted.' }
    $taskSynth.SelectVoice($taskVoice.VoiceInfo.Name)
    # ASCII script source is intentional for Windows PowerShell UTF-8 handling.
    $taskPhrase = [string][char]0x4f60 + [string][char]0x597d
    $taskFormat = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
        16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
        [System.Speech.AudioFormat.AudioChannel]::Mono)
    $taskSynth.SetOutputToAudioStream($taskAudio, $taskFormat)
    $taskSynth.Speak($taskPhrase)
    $taskSynth.SetOutputToNull()
    if ($taskAudio.Length -le 0 -or $taskAudio.Length -gt 1920000) {
        throw 'Synthetic PCM is outside the public voice input bound.'
    }
    $taskAudio.Position = 0
    $taskEngine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($taskRecognizerInfo)
    $taskGrammarBuilder = New-Object System.Speech.Recognition.GrammarBuilder
    $taskGrammarBuilder.Culture = $taskCulture
    $taskGrammarBuilder.Append($taskPhrase)
    $taskGrammar = New-Object System.Speech.Recognition.Grammar($taskGrammarBuilder)
    $taskEngine.LoadGrammar($taskGrammar)
    $taskEngine.SetInputToAudioStream($taskAudio, $taskFormat)
    $taskResult = $taskEngine.Recognize([TimeSpan]::FromSeconds(10))
    if ($null -eq $taskResult -or $taskResult.Text -ne $taskPhrase) {
        throw 'Synthetic fixed-grammar recognition did not match.'
    }
    [ordered]@{
        scope = 'synthetic-fixed-grammar-only'
        culture = 'zh-CN'
        pcmBytes = $taskAudio.Length
        sampleRate = 16000
        channels = 1
        matched = $true
        textLength = $taskResult.Text.Length
        microphoneUsed = $false
        audioPersisted = $false
        cloudCalled = $false
    } | ConvertTo-Json -Compress
} finally {
    if ($null -ne $taskEngine) { $taskEngine.Dispose() }
    if ($null -ne $taskSynth) { $taskSynth.Dispose() }
    $taskAudio.Dispose()
}
