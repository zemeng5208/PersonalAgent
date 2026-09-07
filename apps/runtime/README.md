# Runtime task core

@personal-agent/runtime is the MOD-03 local task and event core for PA-004 and the scheduling boundary of PA-009.

## Implemented

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

The Runtime Application text entrypoint is exported as `@personal-agent/runtime/text`. It owns the text Agent loop, `ModelGateway`, explicit Fake/Unavailable/Pangu provider selection, the read-only text task composition and the model connection probe. Desktop supplies the trusted model configuration and calls this entrypoint; it does not import Agent or Model implementation packages for production orchestration. The current text slice intentionally registers no tools and does not expose thinking parameters as a public contract.

TaskRuntime also implements the MOD-02 Transport shape for handshake, task.submit, task.get, task.cancel and event.subscribe, so the public Client can use it directly. When a MOD-05 RuntimeToolGateway is injected, handshake additionally advertises capability.list and tool.invoke; tool scopes come from the authorization reference rather than the client. The `@personal-agent/runtime/weather` composition entrypoint wires an explicit weather provider through `InMemoryAuthorizationPolicy` and `ToolGateway`. Production composition uses `OpenMeteoProvider` in strict location mode; tests must pass `FakeWeatherProvider` explicitly.

dispatchDueSchedules() handles due schedules during normal operation. recoverMissedSchedules() is called after a stopped period and applies each schedule's run_once or skip policy atomically.

## Limits

- This is an in-process Runtime core, not a daemon or IPC server.
- Schedules are one-shot; recurring rules, wake timers and sleep detection are not implemented.
- Event history is retained without pruning, so CURSOR_EXPIRED is not produced yet.
- Restart recovery is intentionally conservative because MOD-05 side-effect evidence is not available: interrupted active work requires reconciliation.
- SQLite migration ownership remains with goo122; other modules must not add competing root migration sequences.
- No real model, desktop or external write has been verified. Weather production composition is conditional on outbound Open-Meteo access; the vertical integration test is fake-backed. MOD-05 authorization and tool execution remain in-process without persistent grants.
