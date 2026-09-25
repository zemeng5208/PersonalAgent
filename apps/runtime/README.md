# Runtime task core

@personal-agent/runtime is the MOD-03 local task and event core for PA-004 and the scheduling boundary of PA-009.

Interface status is tracked per operation in the [current interface catalog](../../docs/interfaces/CURRENT_INTERFACE_CATALOG.md). The Core Runtime Profile 1 message, task, conversation, and approval-query subset is frozen. Event-channel lifecycle, model/tool execution, Evidence content, settings, connector routing, and external host boundaries remain provisional or unavailable.

当前新增装配只面向 [Huawei ICT AgentArts Competition Profile](../../docs/competition/HUAWEI_ICT_AGENTARTS_PROFILE.md)：Runtime 后续通过 `CoordinationPort` / `CloudAgentPort` 调用比赛编排，并继续拥有任务、授权、真实执行、读回和终态。现有本地 `runAgent()` 与模型装配仅作为可选基线留存，当前不扩展、不作为比赛验收路径；Competition 运行不得在 AgentArts 不可用时静默回退本地链路。

`createAgentArtsRuntimeApplication(options)` 是可信 Competition 文字装配入口：
它用显式的 HTTPS gateway、runtime 名称、调用模式和宿主
`AgentArtsAuthorizationProvider` 构造云适配器，再注入现有
`RuntimeApplication`。工厂不接受 Local text 配置，可注入本地
`RegisteredTool`；当前 HTTP Adapter 返回仍只是 `unverified` 文字，
任务持久化、授权、工具执行和终态继续由 TaskRuntime 决定。

## Implemented

### Provisional trusted-host Evidence metadata

`RuntimeApplication.createEvidenceReader({subjectRef, conversationId, taskId, authorize})`
returns a fixed-scope, read-only metadata reader. The trusted host must derive the
scope from its authenticated session and check `authorize` on every `list` or `get`.
The reader also compares the task's persisted conversation ID. It returns bounded
execution metadata with `conditional` verification, never tool arguments, results,
credentials or raw checkpoint content. Runtime does not store a subject ACL, so this
is not a Renderer/Client wire `EvidencePort` and cannot be enabled without a real
host authorization source. No Evidence capability is announced.

`RuntimeApplication.revokeHostAuthorization` is a separate trusted-host call.
It checks the authenticated subject through a caller-supplied callback, the
persisted task/conversation and approval revision, then removes the matching
SQLite-backed Policy grant and reads back its absence. Repeated calls return
`revoked: false`; an idempotent approval response cannot recreate the grant.
Revocation prevents later grant consumption. It does not roll back a tool that
has already started, so the task's cancellation and result reconciliation stay
separate. There is no public revoke wire operation or persisted subject ACL yet.

### Provisional graph storage

Trusted hosts may call `provisionCoordinationStore(namespace)` or
`bindCoordinationStore(namespace)` and pass only the returned
`CoordinationStorePort` to a consumer. Migration 5 stores immutable graph history
in the existing Runtime database, with transaction-protected revision comparison.
No wire capability or AgentArts integration is enabled by this host-only API.
See [COORDINATION-STORE-01](../../docs/modules/COORDINATION-STORE-01.md).

### Competition coordination and offline tool loop

Trusted composition may pass `profile: 'huawei_ict_agentarts'`, an explicit
`coordination: CoordinationPort`, and local `RegisteredTool` values. Bounded text and
strict proposals are parsed; `unverified` proposals are denied by default. Runtime owns submission, deduplication, cancellation,
deadline and persisted terminal state. Missing coordination, or a proposal without a
trusted local tool, fails with UNSUPPORTED_CAPABILITY. Local text/model configuration APIs
remain rejected in Competition mode.

Adapters receive no Runtime object, authorization, history or attachments. For the offline
Fake path, Runtime checkpoints a proposal, enters `waiting_approval`, executes through the
existing Policy/ToolGateway after `allow_once`, accumulates trusted Evidence references,
and sends only a confirmed JSON result to the next coordination exchange. Unknown write
results remain in reconciliation. The real AgentArts HTTP adapter is still text-only;
deployment trace, usage and real cloud recovery remain unavailable. See
[work package](../../docs/modules/COMPETITION-TOOL-LOOP-01.md).

Trusted composition can explicitly configure `competitionToolExports` for selected tools with
bounded result projections. Each binding fixes a tool name/version and an `exportPolicyVersion`, checks task/proposal/arguments with
`accepts`, and projects the confirmed result with `project`. This export permission does not
grant tool execution: local approval, deadline and Policy still apply. Only the bounded JSON
projection reaches continuation; raw results and Evidence remain local. Repeated confirmed
proposal IDs replay the saved projection and changed inputs are rejected. No export binding
is configured by default. The complete continuation JSON, including its envelope, is limited
to 8KiB. Change `exportPolicyVersion` when changing the export rules: saved projections with
a missing or different version are denied, never re-executed. Dynamic scope is checked again
at the adapter handoff after projection. `createAgentArtsRuntimeApplication` also forwards `workflowGoalInput`
and explicit `responseMode: 'tool-proposal-json'` (default `text`), and supplies a final
synchronous receipt/scope check after credential reads, immediately before the adapter fetch
to the cloud adapter. See [export work package](../../docs/modules/MOD-30-COMPETITION-EXPORT-01.md)
for the precise offline boundary and the unresolved real cloud/MCP lifecycle.

Optional `competitionToolAvailability` requires a trusted, task-specific readiness check for
each advertised tool. Runtime selects only registered descriptors with an explicit
result export binding and a ready provider, stores that selection with task revision/deadline,
and exposes `prepareCompetitionToolCatalog` as `{name,version,inputSchema}`. The input Schema
projection removes descriptions, examples, enums and patterns so private paths and hints do
not leave the host through catalog metadata. An unverified proposal is checked against the
persisted selection, the original local Schema and current readiness before local approval.
The cloud adapter must call `assertCompetitionToolCatalogAllowed` after credential reads and
immediately before sending an initial request with the directory. Catalog selection does not
grant tool execution or authorize sending tool results. Local and external writes can be
advertised only through these explicit bindings; each proposal still needs Policy approval,
and an unknown write result waits for reconciliation. Tools requiring a live presence signal
are omitted until the Runtime invocation carries that signal. The trusted AgentArts factory
requires `initialRequestMode: 'goal-with-tools-json'` whenever a catalog is configured.

- SQLite-backed tasks, checkpoints, events and one-shot schedules.
- `createSqliteFactProjectionHost` binds a pre-provisioned public Memory namespace
  to one fixed consumer, the SQLite feed/query, durable Runtime graph projection,
  host-only confirmation and pending impact processor. `consume` advances one exact
  batch; `drain` catches up within an explicit batch limit and reports whether it
  reached the watermark. `processImpacts` filters pending items by the fixed
  consumer/Memory namespace before applying its limit and returns batch-tokened
  completed reports; `readCompletedImpact` reads one known token. For a crash after
  projection or completion commits but before the token is returned,
  `listImpactReceipts({afterGraphRevision, limit})` pages pending and completed
  receipts by increasing graph revision within that fixed consumer scope. The
  consumer persists its last fully handled graph revision only after processing
  the page. Batches without new Fact nodes need no cognition impact receipt.
  A trusted host must trigger it after verified source
  changes and on startup recovery; it does not poll private sources or publish to
  AgentArts. Source correction and withdrawal remain append-only Fact revisions.
- Explicit task transition rules and immutable terminal states.
- Submission idempotency: the same key and input returns the original task; different input is rejected.
- Ordered event replay after a persisted sequence.
- Abort propagation to an active worker. A task becomes cancelled only after the worker settles.
- Conservative restart recovery: interrupted work moves to waiting_reconciliation.
- External-write deadline handling that records RESULT_UNKNOWN and never retries automatically.
- One-shot schedule recovery with explicit run_once or skip policy.

## Verified commands

From the repository root:

    npm.cmd run check
    npm.cmd run demo:runtime

The test suite uses local fixtures and temporary SQLite files under the ignored .cache/ directory. It does not call a model, account, connector or paid service.

## Integration

Consumers create one TaskRuntime for a SQLite file, submit a task with an idempotency key, and call runTask with an injected worker. Workers receive an AbortSignal, deadline, checkpoint methods and progress reporting. MOD-04 and MOD-05 provide model and policy-checked tool workers; they must not bypass this Runtime with a second task store.

The Runtime Application text entrypoint is exported as `@personal-agent/runtime/text`. The higher-level `@personal-agent/runtime/application` entrypoint owns `TaskRuntime`, model composition and active executions. A successful `task.submit` dispatches automatically; optional trusted `tools` enable the approval-checked Agent loop. Desktop supplies configuration, submits tasks and subscribes to events. Duplicate submissions never start a second execution, cancellation is delegated to Runtime, and close rejects active work.

For an explicitly configured Competition host, `RuntimeApplicationOptions.hostUserNamespace` enables the host-only `submitHostToolTask({commandId, toolName, toolVersion, arguments, deadline})` entrypoint. The namespace is fixed by trusted composition, and the stable command ID identifies one task within it. Runtime commits the tool intent with task idempotency, validates the registered tool version and input Schema, requests the existing Policy approval, and resumes the same intent after `authorization.respond`. The caller can use `readHostToolTask(taskId)` to distinguish a pending approval, a confirmed tool result, and `waiting_reconciliation`; readback also includes the persisted command ID and tool name/version so the trusted host can choose a safe UI projection. `task.cancel` remains the cancellation path. After restart, the trusted host calls `resumeHostToolTask(taskId)` for a persisted allowed approval that was not yet dispatched. Repeating the original `submitHostToolTask` command also resumes that state. Neither path repeats a confirmed or unknown write. Tool output stays in the trusted host readback, not in the public task snapshot. Interrupted or unknown writes require reconciliation and are never automatically replayed. This host API does not publish a new wire capability or make any particular Goal/Windows tool available without explicit registration.

Text tasks now build multi-turn context in Runtime Application from the same conversation's preceding successful tasks. The default window is the latest 20 turns; failed, cancelled and other-conversation tasks are excluded, and stored model metadata is stripped before messages are sent back to the model. The context is persisted as an application checkpoint so approval resume and Runtime Application restart retain the same input, while an `agent-loop` checkpoint remains authoritative for an already-started tool execution.

TaskRuntime implements the MOD-02 transport. With a tool gateway it also advertises capability.list, tool.invoke and authorization.respond. The weather entrypoint now uses Runtime-owned persistent policy. `createWeatherApplication` accepts an explicit provider; `createOpenMeteoApplication` uses strict location resolution. Tests pass Fake providers explicitly.

The base Runtime advertises only operations it implements. `settings.get`, `settings.update`, `connector.connect`, `connector.disconnect`, `voice.start`, and `voice.stop` are schema-known but unavailable in production and must return `UNSUPPORTED_CAPABILITY`. Tool operations are advertised only when a ToolGateway is configured; their interfaces remain provisional until the real model-to-tool path is verified.

Approvals persist for ten minutes and grant one use bound to task, tool and argument digest. Agent checkpoints retain the original proposal. After restart, repeating the matching approval response resumes an approved waiting task. Tool run IDs return confirmed stored results; unfinished runs require reconciliation. `readToolExecutions(taskId)` returns execution metadata and `readEvidence(taskId)` returns schema-valid summaries. Raw approved tool results are local task checkpoints, not public Evidence or logs.
Competition checkpoints separately retain the cloud proposal, step, continuation and Evidence references; approval resumes the Competition loop without invoking Local Agent.

dispatchDueSchedules() handles due schedules during normal operation. recoverMissedSchedules() is called after a stopped period and applies each schedule's run_once or skip policy atomically.

## Limits

- This is an in-process Runtime core, not a daemon or IPC server.
- Schedules are one-shot; recurring rules, wake timers and sleep detection are not implemented.
- Event history is retained without pruning, so CURSOR_EXPIRED is not produced yet.
- Restart recovery remains conservative: interrupted active work requires reconciliation; waiting approvals have an explicit resume path.
- SQLite migration ownership remains with goo122; other modules must not add competing root migration sequences.
- This work package verifies Fake model/tool behavior and Desktop smoke tests. Real model and external-write acceptance remain separate. Cross-task continuing grants and the Windows SecretStore adapter remain outside this slice.
- `event.subscribe` and `readEvents` have local replay tests, but no unsubscribe, pruning/expiry policy, or frozen cross-process stream lifecycle.
