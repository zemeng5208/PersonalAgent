# Offline Windows speech feasibility probe

Status: prepared, execution blocked by the host PowerShell execution policy.
This is not a production SpeechRecognitionPort or microphone acceptance.

Prerequisites: Windows PowerShell 5.1, installed System.Speech, a zh-CN recognizer
and synthesis voice. A preceding read-only enumeration found an installed zh-CN
recognizer on the development host; installation alone does not prove recognition.

`offline-speech-probe.ps1` generates the fixed synthetic phrase in memory as
16 kHz / 16-bit / mono PCM, loads a fixed grammar and recognizes that stream.
It does not use microphone or speaker defaults, network, credentials or audio
files. Success outputs bounded structural JSON, not arbitrary recognized text.
The public 1,920,000-byte audio ceiling is enforced. Recognition receives a
10-second initial-silence timeout; this is not a guaranteed wall-clock process
deadline, and a production helper still needs external cancellation and timeout.

Normal invocation:

```powershell
powershell.exe -NoProfile -NonInteractive -File tests/manual/voice/offline-speech-probe.ps1
```

On 2026-09-17 this invocation failed before script execution with
`PSSecurityException / UnauthorizedAccess: running scripts is disabled`.
No recognition or synthesis ran. No execution policy was changed. A one-process
exception has been requested from the user; do not infer permission from this
document or retry through another launcher to avoid that decision.

Even a future pass proves only fixed-grammar synthetic stream feasibility.
Dictation quality, live audio, privacy consent, Desktop IPC, bounded helper
lifecycle and real voice interaction remain unverified.

API basis: Microsoft documents explicit stream input and format selection in
[SetInputToAudioStream](https://learn.microsoft.com/en-us/dotnet/api/system.speech.recognition.speechrecognitionengine.setinputtoaudiostream?view=netframework-4.8.1).
