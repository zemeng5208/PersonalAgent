# Competition MVP: one acceptance path

Owner: zemeng / D integration. Snapshot: 2026-09-24. Profile: `huawei_ict_agentarts`.
This is an acceptance plan, not a successful execution record.

## Baseline and dependencies

Start from main `c5c4ada`, not the overlapping PR #78 stack. Preserve existing
Desktop cancellation, data paths, and Runtime ownership. PR #62 overlaps the
merged MOD-09 implementation: reuse public Memory query/feed, SQLite Memory,
`createMemoryProjectionApplication`, `createPendingImpactApplication`, and
CoordinationStore `appendBatch`; do not copy its older alternate consumer.

| Stage | Owner / minimum interface | Required evidence |
| --- | --- | --- |
| Submit synthetic text | D Desktop main; A adapter; B `workflowGoalInput` pass-through | Same task and exact integrated commit; no Fake fallback |
| Real AgentArts orchestration | A / deployed Runtime invocations | Deployment, timestamp, trace/run correlation, bounded safe result |
| Local proposal and approval | B / Runtime Application, Policy, ToolGateway | Task-bound proposal; explicit approval; expiry/cancel/replay rejected |
| Read approved synthetic fixture | B execution / D scenario | Confirmed execution plus Evidence; no private directory access |
| Return minimal result to cloud | A/B continuation | Same local task, explicit NEW cloud invocation, per-invocation IDs and synthetic output projection |
| Consume changed fact | D / existing Memory projection application | Exact FactRef to NodeRef mapping, durable batch receipt, impact |
| Apply explicit repair | D / public cognition repair API | Expected graph revision, validated candidate, one atomic appendBatch |
| Display and restart | D Desktop / original Runtime and Memory DBs | Displayed answer and unchanged persisted result after restart |

Meeting fixture: meeting 15:00 -> 17:00, preparation 14:00 -> 16:00;
an unrelated plan stays unchanged. Baseline and correction are synthetic.
Never hard-code a successful cloud answer or manually edit storage to pass.
Master selected a bounded multi-invocation MVP on 2026-09-24: cloud proposal ->
local approval/tool -> new cloud invocation for a summary, correlated under one
local task. Low-code native same-cloud-run resume remains unavailable; a new
invocation is not a resumed run. Keep each actual cloud invocation/trace identity,
the task/tool/Evidence relation and any partial failure. Do not merge run IDs or
claim the original native same-run acceptance passed. A owns the continuation
adapter and B owns local execution gates; D consumes their reviewed public APIs.

The cloud candidate still requires validation and local authorization; model
confidence, including uncalibrated Laya output, cannot authorize execution.

Memory fact revision, feed checkpoint, and graph revision are distinct.
Staging -> provider confirmation -> projection activation is recoverable but
not a cross-database atomic transaction. Use the existing implementation.

## Configuration and minimum verification

Trusted host supplies `PA_RUNTIME_PROFILE=huawei_ict_agentarts`,
`PA_AGENTARTS_GATEWAY_URL`, `PA_AGENTARTS_RUNTIME_NAME`, and
`PA_AGENTARTS_AUTHORIZATION`; optional `PA_AGENTARTS_WORKFLOW_GOAL_INPUT` is
passed through unchanged for strict adapter validation. Competition submission
gets 180000ms; normal Local/Fake requests retain the Client default. Keep
`requestTaskCancellation` and `desktopDataPaths` intact.

The development-only opt-in `PA_DESKTOP_SYNTHETIC_MVP=1` binds the existing
`workspace.read_text@1.0.0` to this repository's dedicated synthetic fixture root.
`PA_AGENTARTS_RESPONSE_MODE=tool-proposal-json` and
`PA_AGENTARTS_REPAIR_CANDIDATE_VERSION=1.0` explicitly enable the strict
proposal/candidate parser for this development fixture. The candidate remains
unverified until a separate local repair task passes Policy and graph CAS.
Only exact arguments `{ "path": "meeting-update.json" }` are export-eligible.
Runtime still requests normal local approval; the export gate does not grant it.
The actual confirmed file result must match the approved synthetic meeting fields
exactly before those four fields can leave the machine. Paths, raw file content,
extra fields and Evidence claims are not exported. Default startup exposes none
of these tools, and this development-only opt-in is rejected in Local/Fake or
packaged execution. No arbitrary user directory is accepted.

Run syntax/diff checks for the composition change; then the necessary targeted
integration check after A/B dependencies are integrated. One real synthetic
multi-invocation scenario and its same-database restart readback are the MVP acceptance, not
several independent successes from different branches. Record failure honestly;
do not automatically retry paid or uncertain side-effecting operations.

Local persistence preparation (after building matching baseline dependencies):
`node --test tests/manual/agentarts/mvp-meeting-persistence.test.mjs`.
It uses real temporary SQLite stores and public APIs, but an explicitly supplied
synthetic repair candidate. It does not invoke AgentArts, authorize a tool, or
qualify as the final real-cloud acceptance.

2026-09-24 D preparation result: Node 24.15.0 compiled the matching-worktree
Runtime dependency closure (12 workspaces); the single persistence scenario
passed (1/1). The first executed attempt rejected an extra `limit` argument on
the test's `getVersion` call; the fixture call was corrected and the same test
passed without changing or weakening the production validator. Desktop/cloud
composition remains unverified.

Cloud console readback by D on 2026-09-24: target app
`32d4d44c-eade-4f3f-8f76-209c74609e79` is published (displayed publication time
2026-09-17 16:09:47). API panel shows POST
`https://defaultgw-gztdqobzmm.cn-southwest-2.huaweicloud-agentarts.com/runtimes/agent-arts-d5ae1174bc7d4cb8ab3dbbc6fae654e4/invocations`,
Authorization Bearer, input `query`. This was configuration readback only:
no invocation, no credential export, no changed cloud configuration. Browser
login does not populate the local authorization environment variable.

## Competition evidence and distinct submissions

Rule observations below were supplied by the project coordinator on 2026-09-24;
D has not independently re-reviewed the legal terms. Verify the applicable
edition/region and final organizer notices before submission; retain copyright
and contributor authorization. No agent accepts enrollment/legal terms for the user.

- Huawei official source:
  <https://e.huawei.com/cn/talent/#/ict/innovation-details?zoneCode=027425&zoneId=98269700&compId=85132021&divisionName=%E4%B8%AD%E5%9B%BD%E5%8C%BA&type=C002&isCollectGender=N&enrollmentDeadline=2026-11-30%2023%3A59%3A59&compTotalApplicantCount=1113>.
  Topic 2 requires AgentArts construction/orchestration/deployment and a visual
  demo. Coordinator reports preliminary weighting innovation 60%, application
  40%, and an online interactive demo for the final. Unchanged duplicate entries
  from other competitions are not acceptable.
- iCAN official source: <https://www.g-ican.com/competition/details?id=138>.
  Coordinator reports software track accepts an online demo or runnable program,
  2026-09-30 registration/work submission deadline, PDF at most 20 pages, MP4 at
  most 5 minutes, and link or source. A Windows installer is not today's prerequisite.

Freeze the iCAN first functional version with commit, artifact and evidence date.
For Huawei, record actual later improvements, such as deeper AgentArts workflow /
multi-agent orchestration, repeatable cloud evaluation and trace-linked repair
evidence, with before/after commits and measured results. These are a planned
improvement checklist, not completed claims; changing only the name is insufficient.

## Open evidence gaps

- The trusted Desktop host loads an existing AgentArts key from an ignored,
  current-user Windows DPAPI file for manual runs. Credential presence is not
  proof of any cloud request; the one-time loopback setup is closed.
- Independent real AgentArts proposal and graph-bound candidate queries passed,
  but they are not the same Desktop task. The Desktop first invocation, local
  allow-once, confirmed read and graph revision 6 passed; its second invocation
  returned an application-specific JSON object without `kind`, so the source
  task failed closed. No candidate preview, approved CAS or restart receipt from
  that real Desktop task exists yet.
- Native same-cloud-run resume remains unavailable. The selected MVP uses two
  separate published invocations correlated by one local task and Evidence.
- Runtime now has a provisional task/Evidence/FactRef-bound local repair path;
  its Fake-cloud SQLite test covers separate Policy approval and restart. This
  is not real-cloud repair acceptance. Do not parse task summaries into writes.
- No claim of real microphone/speaker acceptance or packaging delivery.

## D controlled integration receipt (2026-09-24)

This is not main and not a real-cloud acceptance. Composition tested at
`b69dcaa`: main `c5c4ada`, A PR #99 `cfdb170`, A PR #103 `bcee4d7`,
B PR #101 `f04086a`, D PR #102 `970bb35`, and D synthetic tool composition
`66efd54`. Newer source PR heads must be explicitly incorporated and rechecked
only for their affected paths.

- Node 24.15.0: matching Client/Coordination/Runtime incremental compilation passed.
- `apps/desktop/test/competition-synthetic-workspace.test.mjs`: 3/3 passed.
- `tests/manual/agentarts/mvp-readonly-runtime.test.mjs`: 1/1 passed. This uses a
  Fake cloud port with unverified proposals but real Runtime/Policy/ToolGateway,
  actual synthetic file read, explicit allow-once, minimal export, persisted
  conditional execution Evidence and same-database restart. It does not count as
  two real cloud invocations or a real Desktop interaction.
- `tests/architecture/dependency-boundaries.test.mjs`: 1/1 passed.
- Node syntax checks and `git diff --check`: passed.

The factory-level immediate-before-send host guard is still being connected by B;
do not treat the earlier handoff guard alone as closing every revocation window.
Versioned repair-candidate binding and Runtime-approved local graph commit remain
separate pending work. The read-only test does not silently perform that repair.

## D2 integrated receipt (2026-09-24)

The clean D2 branch at `2d947ffa` incorporates the final A/B/C source commits
available at this checkpoint. Node 24 targeted Desktop synthetic/cognition/real
SQLite host tests passed 7/7; B local repair tests passed 11/11. The existing
Electron Runtime Application smoke passed, and Electron 44.2.0 was installed
from its official cached package. The opt-in manual harness is
`tests/manual/agentarts/support/desktop-synthetic-e2e.cjs`; it uses isolated
ignored user data and saves only a redacted receipt. It automates the synthetic
UI approval clicks for validation, which are not a human authorization claim.

A's separate published AgentArts probes each returned HTTP 200: text,
`tool_proposal`, then graph-bound `repair_candidate` v1.0 matching the three
synthetic target references and dependencies. These are three independent query
receipts, not a resumed provider run or a Desktop completion.

The latest real Desktop attempt used the exact successful first-stage proposal
goal. The source task received a strict `tool_proposal`, displayed a local
read approval, consumed `allow_once`, confirmed `workspace.read_text`, projected
Fact revision 2 to graph revision 6, and saved the task/Evidence binding.
Its second published invocation was sent and returned HTTP 200 with complete
SSE and no error event. The final answer was valid JSON but lacked the required
`kind`/candidate shape, so the adapter rejected it and the Runtime marked the
source task `EXTERNAL_FAILURE`. No plan write occurred. The next integration
step is a bounded trusted continuation query that asks for the strict candidate
using only the approved synthetic projection, followed by the real Desktop
preview, local approval, CAS and same-database restart check.
