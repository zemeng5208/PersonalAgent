# MOD-14 voice session foundation

This package is the provisional in-process voice-session boundary for the
`huawei_ict_agentarts` Competition Profile. It implements a push-to-talk lifecycle
with explicit Fake/Unavailable adapters. It does not choose an ASR/TTS vendor, open a
microphone, persist audio or transcripts, upload data by itself, submit Runtime tasks,
or advertise the public `voice.start` / `voice.stop` wire operations.

## Public flow

1. A trusted caller starts one bounded session with an ISO UTC deadline and an
   `AbortSignal`.
2. The caller supplies one PCM S16LE, 16 kHz, mono clip to `recognizeAudio`. The maximum
   is 60 seconds and 1,920,000 bytes. The private copy is zeroed after the adapter call.
3. Recognition returns an opaque transcript receipt. No Runtime or task action occurs.
4. The caller explicitly calls `consumeTranscript` with a restricted
   `TranscriptConsumerPort`. The stable transcript ID is also its deduplication input.
   This port may submit to a future Runtime adapter, but its stop operation only ends the
   local wait and must not call `task.cancel`.
5. A bounded reply stays private until the caller explicitly invokes `speakReply`.

`stopSpeaking`/`interrupt` stops only the current output operation and returns the
session to listening. It neither stops recognition nor changes a Runtime task. `stop`
terminates the voice session, is idempotent, aborts active operation signals, invokes
their idempotent release handles, clears in-memory transcript/reply material and reports
whether those handles released successfully. A parent cancellation or deadline does the
same with `cancelled` or `expired` state. Starting another session replaces the previous
one; late provider callbacks are discarded.

`subscribe(listener)` is a provisional, in-process read-only state feed for trusted host
composition. It emits an independently frozen snapshot after the initial session becomes
observable and after each revision change, including playback stop and terminal states.
Unsubscribe is idempotent. Listener failures are contained, and subscriptions added while
an update is being delivered begin with the next update. The feed opens no device, grants
no authorization, submits no task and is not the public wire event protocol.

Each session snapshot contains state and booleans only, never audio, transcript or reply
text. Public failures use fixed messages and do not expose provider or listener errors.
Adapters own provider configuration, credentials, upload consent and transport. No
provider is the default: recognition and output return `UNSUPPORTED_CAPABILITY`.

## Windows System.Speech adapters

`createWindowsSystemSpeechPorts()` returns provider-specific recognition and output ports
for the installed Windows `.NET Framework` `System.Speech` engine. The implementation
starts one hidden native Windows child per explicit operation using a fixed in-module host
executable (`packages/voice/host/windows-system-speech-host.exe`), fixed `zh-CN` culture and
fixed `--mode recognize` / `--mode speak` mode. Callers cannot provide a command, path,
executable, device or execution policy. Executing a native executable directly avoids
PowerShell script execution policy restrictions (such as `Restricted`) without employing
any policy modification, execution-policy bypass, or `-Command`/`IEX` workarounds. PCM or
UTF-8 text uses bounded stdio; stdout is one bounded JSON result; stderr is drained without
logging. There is no file, network, credential or automatic retry path.

Deadline, parent abort, `stop()` and adapter disposal terminate the exact child and wait
for its close. The adapter copies and later zeroes its audio input. Recognition responses
are restricted to 8,000 characters and all process/provider failures use fixed local
errors. The helper uses open dictation for recognition and the installed `zh-CN` default
audio voice for speech.

Source availability is not runtime availability. This adapter implementation does not
verify dictation accuracy, microphone capture, speaker playback, or audio devices. Binaries
are not committed to the repository. If the fixed native host executable is not built and
deployed, or if installed Chinese speech components are missing, the ports explicitly return
unavailable (`UNSUPPORTED_CAPABILITY`). Desktop and Runtime must keep their Unavailable
ports and UI state until authorized production setup and real-device acceptance pass.

### Building the native host

The minimal reproducible native host is defined by single source file
`packages/voice/host/WindowsSystemSpeechHost.cs`. It requires no external package
dependencies and is compiled into `packages/voice/host/windows-system-speech-host.exe`
via the module build script (`scripts/build-host.mjs`).

To build or verify the native host directly:

```powershell
npm.cmd run build:host --workspace=@personal-agent/voice
```

Native host compilation is also integrated into:

```powershell
npm.cmd run build --workspace=@personal-agent/voice
```

The build script automatically detects whether the target binary is missing or stale
relative to `WindowsSystemSpeechHost.cs`:
- If the binary is current (`output.mtime >= source.mtime` and size > 0), compilation is
  skipped to avoid redundant compiler runs.
- If the binary is missing, empty, or stale, the script locates the Windows `.NET Framework`
  C# compiler (`csc.exe`) and `System.Speech.dll` at fixed controlled system paths under
  `SystemRoot` and compiles via `execFile` (with `shell: false`, `windowsHide: true`, and
  no PowerShell policy bypass).
- On non-Windows platforms, host compilation is cleanly skipped, preserving cross-platform
  build portability.
- If `csc.exe` or `System.Speech.dll` is missing, or if compiler execution fails, the build
  script produces a clear bounded error and unlinks any stale executable so an outdated
  binary is never mistaken for current.

### Native host limitations

1. **Host environment requirements**: Native Windows System.Speech execution requires a
   Windows system with installed `.NET Framework` 4.x components (providing `csc.exe` and
   `System.Speech.dll`). Non-Windows platforms cleanly skip build and report
   `UNSUPPORTED_CAPABILITY` at runtime.
2. **Fixed controlled paths**: Only verified system locations under `SystemRoot` are searched.
   Arbitrary compiler paths, executable locations, or user commands are not accepted.
3. **Voice components**: The host strictly requires installed Chinese (`zh-CN`) speech
   recognition and speech synthesis voice components. If missing on the machine, the host
   exits with code 2 and surfaces `UNSUPPORTED_CAPABILITY`.
4. **Adapter startup verification**: `createWindowsSystemSpeechPorts()` verifies that
   `windows-system-speech-host.exe` exists, is non-empty, and is not stale compared to
   `WindowsSystemSpeechHost.cs`. If absent or stale, the adapter reports `UNSUPPORTED_CAPABILITY`
   (`Windows System.Speech is unavailable`) through the existing error shape.
5. **Hardware and devices**: The adapter does not verify microphone capture, physical speakers,
   or audio routing devices.


## Fake use and verification

`@personal-agent/voice/testing` exports Fake recognition, explicit transcript consumer
and speech output ports. They retain only call metadata (byte/character counts, deadline,
locale and signal), not private content.

Run:

```powershell
npm.cmd run test --workspace=@personal-agent/voice
npm.cmd run typecheck --workspace=@personal-agent/voice
```

The root build now runs this workspace immediately after client, and the single root
lock file registers only the voice workspace/link; no external dependency was added or
upgraded. A trusted integration owner must still wire the Desktop/Runtime composition
and keep the public wire capability unavailable until production adapters and
real-device acceptance exist.
