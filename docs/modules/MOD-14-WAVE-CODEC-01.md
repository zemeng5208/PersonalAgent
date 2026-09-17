# MOD-14 bounded WAVE/PCM adapter

- Profile: `huawei_ict_agentarts`; owner: zemeng; reviewer: goo122.
- Baseline: PR #75 / `b322d019`; branch: `codex/zemeng/voice-wave-codec`.
- Status: review / provisional; no production ASR or Desktop capability.
- Owned scope: voice codec, exports, focused tests, README and this record.

This increment converts caller-supplied, bounded PCM WAVE bytes to the existing
`VoiceAudioClip`, and exports that clip back to a canonical WAVE byte array.
It introduces no wire DTO, package dependency, database migration or device
permission. It does not execute the policy-blocked PowerShell speech probe.

The strict subset accepts only PCM S16LE, 16 kHz, mono, at most 60 seconds and
1,920,000 playable bytes. Container input is capped at audio ceiling plus 64 KiB
and 64 chunks. A single 16-byte format must precede a single non-empty, even
data chunk. Unknown chunks are skipped; no metadata is returned. RIFF length,
chunk boundaries and padding are checked before copying the decoded audio.
Buffers are isolated; integer duration is `ceil(pcmBytes / 32)` milliseconds.

This is not resampling, live recording, dictation accuracy, playback or a helper
process implementation. Synthesis/recognition and production integration still
require their own authorized checks; passing codec tests cannot upgrade them.

## Necessary verification

Voice build and four focused codec groups passed, covering roundtrip/isolation,
unknown chunk padding, malformed/duplicate/unsupported containers, and bounds.
The focused command was `node --test --test-isolation=none
packages/voice/test/wave-codec.test.mjs` after building the required workspace
dependencies. `git diff --check` passed. Bounded independent agent inspection
found no blocking defect; this is not registered collaborator approval.
No cloud, device, filesystem audio or full-suite execution was performed.
