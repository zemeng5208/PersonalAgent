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

## Provisional wake composition

`bindVoiceWake({wake, voice})` is an explicit, in-process trusted-host binding to the
provisional `@personal-agent/voice-wake` lifecycle. The host wires the wake controller's
`onWake` callback to `binding.handleWake(event)`. The binding translates only a current,
authorized wake session into `voice.start()`, propagates the finite wake expiry as the
voice deadline, aborts the corresponding voice parent when wake listening ends, and
synchronizes voice `playbackActive` back to wake suppression.

The binding never enables a device, grants authorization, submits a task, or owns the
supplied controllers. `dispose()` only removes its subscriptions and aborts the voice
parent it created; it does not dispose the wake controller or voice manager. This is not
a public wire protocol and is not evidence of real microphone, wake-word, ASR, TTS,
Desktop, Runtime, or AgentArts integration.

## Explicit Runtime transcript consumption

`RuntimeClientTranscriptConsumer` is a trusted-host `TranscriptConsumerPort` adapter for
an already connected public `@personal-agent/client`. It remains idle until the caller
explicitly invokes `consumeTranscript`. That call submits the transcript as the
`task.submit` goal with the configured `conversationId` and a stable bounded idempotency
key, then reads `task.get` until Runtime reports a terminal state. Submission acceptance,
`waiting_approval`, and every other non-terminal state are not treated as a reply.

Only a successful task's bounded `resultSummary` becomes reply text. Runtime and transport
failures use fixed local errors without external messages. Deadline, parent abort, and
`VoiceOperation.stop()` bound submit, polling, and non-cooperative Client promises, but
they stop only this adapter's local wait: the adapter never calls `task.cancel`, retries a
submission, starts Runtime directly, or invents terminal state. Real local Runtime
composition remains a separate host-level acceptance step.

## Fake use and verification

`@personal-agent/voice/testing` exports Fake recognition, explicit transcript consumer
and speech output ports. They retain only call metadata (byte/character counts, deadline,
locale and signal), not private content.

Run:

```powershell
npm.cmd run test --workspace=@personal-agent/voice
npm.cmd run typecheck --workspace=@personal-agent/voice
```

The root build now runs this workspace immediately after contracts, and the single root
lock file registers only the voice workspace/link; no external dependency was added or
upgraded. A trusted integration owner must still wire the Desktop/Runtime composition
and keep the public wire capability unavailable until production adapters and
real-device acceptance exist.
