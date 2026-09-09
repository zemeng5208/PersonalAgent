# Runtime task core

@personal-agent/runtime is the MOD-03 local task and event core for PA-004 and the scheduling boundary of PA-009.

Interface status is tracked per operation in the [current interface catalog](../../docs/interfaces/CURRENT_INTERFACE_CATALOG.md). The Core Runtime Profile 1 message, task, conversation, and approval-query subset is frozen. Event-channel lifecycle, model/tool execution, Evidence content, settings, connector routing, and external host boundaries remain provisional or unavailable.

当前新增装配只面向 [Huawei ICT AgentArts Competition Profile](../../docs/competition/HUAWEI_ICT_AGENTARTS_PROFILE.md)：Runtime 后续通过 `CoordinationPort` / `CloudAgentPort` 调用比赛编排，并继续拥有任务、授权、真实执行、读回和终态。现有本地 `runAgent()` 与模型装配仅作为可选基线留存，当前不扩展、不作为比赛验收路径；Competition 运行不得在 AgentArts 不可用时静默回退本地链路。

## Implemented

### Competition text-port increment (COMPETITION-PORTS-01)

Trusted composition may pass `profile: 'huawei_ict_agentarts'` and an explicit
`coordination: CoordinationPort`. Only bounded text results are supported.
Runtime owns submission, deduplication, cancellation, deadline and persisted terminal
state. The request deadline is the execution deadline for this slice; it is not reset.
Missing coordination fails with UNSUPPORTED_CAPABILITY. Local text/tools options and
model configuration APIs are rejected in Competition mode. Existing Desktop callers
without a profile retain their existing Local composition; no UI switch is delivered.

Adapters receive no Runtime object, authorization, history or attachments. Late results
after cancellation/timeout are ignored. This detaches a read-only request; it does not
prove a remote cloud run has stopped. Adapters must honor cancellation, must not perform
writes and must not start real cloud traffic without separately authorized composition.
No real adapter is included. Results are mock/unverified text, not trusted tool Evidence.
Approval resume, tool proposals, deployment trace, usage and cloud recovery remain outside
this provisional slice. See [work package](../../docs/modules/COMPETITION-PORTS-01.md).

- SQLite-backed tasks, checkpoints, events and one-shot schedules.
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

Text tasks now build multi-turn context in Runtime Application from the same conversation's preceding successful tasks. The default window is the latest 20 turns; failed, cancelled and other-conversation tasks are excluded, and stored model metadata is stripped before messages are sent back to the model. The context is persisted as an application checkpoint so approval resume and Runtime Application restart retain the same input, while an `agent-loop` checkpoint remains authoritative for an already-started tool execution.

TaskRuntime implements the MOD-02 transport. With a tool gateway it also advertises capability.list, tool.invoke and authorization.respond. The weather entrypoint now uses Runtime-owned persistent policy. `createWeatherApplication` accepts an explicit provider; `createOpenMeteoApplication` uses strict location resolution. Tests pass Fake providers explicitly.

The base Runtime advertises only operations it implements. `settings.get`, `settings.update`, `connector.connect`, `connector.disconnect`, `voice.start`, and `voice.stop` are schema-known but unavailable in production and must return `UNSUPPORTED_CAPABILITY`. Tool operations are advertised only when a ToolGateway is configured; their interfaces remain provisional until the real model-to-tool path is verified.

Approvals persist for ten minutes and grant one use bound to task, tool and argument digest. Agent checkpoints retain the original proposal. After restart, repeating the matching approval response resumes an approved waiting task. Tool run IDs return confirmed stored results; unfinished runs require reconciliation. `readToolExecutions(taskId)` returns execution metadata and `readEvidence(taskId)` returns schema-valid summaries. Raw approved tool results are local task checkpoints, not public Evidence or logs.

dispatchDueSchedules() handles due schedules during normal operation. recoverMissedSchedules() is called after a stopped period and applies each schedule's run_once or skip policy atomically.

## Limits

- This is an in-process Runtime core, not a daemon or IPC server.
- Schedules are one-shot; recurring rules, wake timers and sleep detection are not implemented.
- Event history is retained without pruning, so CURSOR_EXPIRED is not produced yet.
- Restart recovery remains conservative: interrupted active work requires reconciliation; waiting approvals have an explicit resume path.
- SQLite migration ownership remains with goo122; other modules must not add competing root migration sequences.
- This work package verifies Fake model/tool behavior and Desktop smoke tests. Real model and external-write acceptance remain separate. Cross-task continuing grants and the Windows SecretStore adapter remain outside this slice.
- `event.subscribe` and `readEvents` have local replay tests, but no unsubscribe, pruning/expiry policy, or frozen cross-process stream lifecycle.
