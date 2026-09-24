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

- A's current local authorization environment is absent; secure loading unresolved.
- Final A/B/D integrated commit and real cloud/local tool continuation not verified.
- Persistent meeting repair and Desktop restart not verified under one local task
  with separate real cloud invocations; native same-run resume unavailable.
- Existing `StoredRepairRequest` checks graph versions and RECHECK, but does not
  itself bind task/Evidence/FactRef authorization. Existing Coordination `text`
  is display text, not an implicit repair protocol. Do not parse task summaries
  into graph mutations. Runtime-approved candidate submission requires an explicit
  agreed port; until delivered, only the offline fixture proves persistence.
- No claim of real microphone/speaker acceptance or packaging delivery.
