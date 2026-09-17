# Offline Windows speech feasibility probe

Status: synthetic fixed-grammar probe passed once with explicit user authorization
for a child-process execution-policy exception; normal production startup remains
subject to the unchanged host execution policy.
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
No recognition or synthesis ran during that initial attempt.

Later on 2026-09-17, the user explicitly authorized exactly one invocation of this
unchanged script with child-process `-ExecutionPolicy Bypass`. That invocation
exited with code 0 and returned:

```json
{"scope":"synthetic-fixed-grammar-only","culture":"zh-CN","pcmBytes":43680,"sampleRate":16000,"channels":1,"matched":true,"textLength":2,"microphoneUsed":false,"audioPersisted":false,"cloudCalled":false}
```

The one-time authorization is consumed. No machine or user execution policy was
changed. This result does not authorize a production bypass, another invocation,
microphone capture, speaker playback or cloud upload. Do not infer permission
from this document or retry through another launcher to avoid that decision.

This pass proves only fixed-grammar synthetic stream feasibility.
Dictation quality, live audio, privacy consent, Desktop IPC, bounded helper
lifecycle and real voice interaction remain unverified.

API basis: Microsoft documents explicit stream input and format selection in
[SetInputToAudioStream](https://learn.microsoft.com/en-us/dotnet/api/system.speech.recognition.speechrecognitionengine.setinputtoaudiostream?view=netframework-4.8.1).
