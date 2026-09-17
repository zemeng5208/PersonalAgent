# Coordination text ports

COMPETITION-PORTS-01 provides provisional, in-process `CoordinationPort.execute` and
`CloudAgentPort.invoke` types. The consuming coordination package owns their shape.
Runtime injects CoordinationPort; `AgentArtsCloudAgentPort` is the explicit,
offline-testable HTTP implementation of the text-only CloudAgentPort boundary.

MOD-04B adds `CompetitionCoordinator`, which implements the existing text port by
calling an explicitly injected `CloudAgentPort` once. It validates input, forwards
the task revision and deadline, relays cancellation through a child signal, bounds
non-cooperative calls by the deadline, and validates results before returning them.
Provider exception messages are not exposed. `UnavailableCloudAgentPort` explicitly
rejects with `UNSUPPORTED_CAPABILITY`; provider-owned `CANCELLED`/`TIMEOUT` errors are
sanitized as `EXTERNAL_FAILURE` because only the coordinator owns those lifecycle
signals. There is no automatic fallback or retry.

```ts
import {CompetitionCoordinator} from '@personal-agent/coordination';
import {FakeCloudAgentPort} from '@personal-agent/coordination/testing';

const coordination = new CompetitionCoordinator(
  new FakeCloudAgentPort(request => `Offline: ${request.goal}`),
);
// Trusted composition can pass this instance to the existing Runtime Application:
// {path, profile: 'huawei_ict_agentarts', coordination}
```

Runtime retains submission deduplication, persistent run identity, task state and
recovery. The coordinator creates no second task store. Its fulfilled text promise
does not certify external execution. A non-cooperative provider may continue its
own internal work after cancellation, but its late result is discarded. The
coordinator is an in-process boundary, not a sandbox or a data-export authorizer.

Input is the submitted goal, task ID/revision, deadline and AbortSignal. It excludes
conversation history, attachments, credentials, authorization and Runtime methods.
The host must authorize any future cloud transmission; an available port is not consent.
Only bounded text (`mock` or `unverified`) is accepted. Text completion is not proof
of tools, real AgentArts deployment or a verified external action. Unknown fields,
tool proposals, task-state and Evidence claims are rejected at the Runtime boundary.

Explicit offline fixtures live at `@personal-agent/coordination/testing`:
`new FakeCoordinationPort(request => 'Fake: ' + request.goal)` and
`new FakeCloudAgentPort(request => 'Fake cloud: ' + request.goal)`.
Fixtures do not automatically enforce cancellation; responders must honor the supplied
signal, allowing tests of both cooperative and non-cooperative adapters.

## AgentArts HTTP adapter (Competition Profile)

`AgentArtsCloudAgentPort` is an offline-testable HTTP adapter for the
`huawei_ict_agentarts` Competition Profile. It follows the 2026-09-08 Huawei Cloud
Invoke Runtime shape: `POST /runtimes/{runtime_name}/invocations`, with a body of
`{"query": goal}` and the AgentArts session/request headers. The gateway must be an
HTTPS origin and the runtime name is validated before construction.

The trusted host supplies an `AgentArtsAuthorizationProvider`; its `read(signal)` is
called for every invocation and its complete Authorization header value is never
cached, logged, placed in the request body, or returned in an error. Do not put an API
key in an environment example, Renderer state, test fixture, or repository. The
adapter does not read environment variables and does not implement IAM signing. Session
and request IDs are stable, ASCII-safe header values bounded to 64 characters; local
task IDs are always represented by a deterministic one-way hash rather than exported
directly. Authorization must be non-empty,
bounded, and free of HTTP control characters such as CR/LF.

```ts
const cloud = new AgentArtsCloudAgentPort(
  {gatewayUrl: 'https://agentarts.example', runtimeName: 'agent-arts-demo'},
  {read: signal => trustedHostSecretStore.readAuthorization(signal)},
);
const result = await cloud.invoke(request);
```

Only bounded text is returned (`verification: 'unverified'`). Responses must declare
`application/json` or `text/event-stream`; both forms are byte-limited and metadata/tool
proposals are discarded. SSE follows the standard blank-line event boundary and joins
multiple `data:` lines with `\n`; for gateways that omit separators, a conservative
fallback accepts only one complete JSON event per `data:` line. Malformed or conflicting
events are rejected. This adapter uses the existing contract error names: `CANCELLED`
for cancellation, `TIMEOUT` for a deadline (the contract has no
`DEADLINE_EXCEEDED`), and `EXTERNAL_FAILURE` for authorization, transport, HTTP, or
malformed-response failures (the contract has no `EXTERNAL_SERVICE_ERROR`).

For responses containing `workflow_start` or `workflow_end`, intermediate
`message.data.text` is not the final result. The adapter keeps the latest
`workflow_end.data.answer` candidate and requires a subsequent `task_end` then
`end` before returning it. A new workflow start clears an earlier candidate;
workflow events after termination and failure events are rejected. As an explicit
compatibility choice, `workflow_end` can introduce this mode without a preceding
`workflow_start`; the two terminal events are still mandatory. This does not
validate a workflow's internal execution or elevate its answer to trusted Evidence.
Pure `message` responses retain their existing text-only behavior. The synthetic
multi-agent fixture reflects observed event fields, not a complete raw cloud trace.
An explicit `workflow_start` begins a new message-index scope. Conflicting text for
the same index inside that scope is still rejected, and the 16,000-character
message budget remains cumulative across all workflows in the response. An
end-only workflow does not reset indexes. This compatibility rule has synthetic
coverage; the live global-conflict report does not identify each conflict's scope.

The adapter is not a claim that AgentArts is available. Real project/runtime setup,
deployment, authentication, streaming behavior, trace/usage, and local Policy or
ToolGateway read-back remain unverified; without explicit configuration composition
must keep the capability unavailable and must not silently fall back to Local or Fake.

Ports are text-only and not frozen. Tool proposals/results, deployment/version/trace,
usage, resumable cloud runs and data-export consent require the next reviewed contract
increment before real AgentArts is enabled. No wire Schema or storage migration changes.

For a Workflow whose start node accepts a single goal string, the trusted host may
set `workflowGoalInput: 'query'` (replace `query` with the configured variable).
The adapter then sends `{inputs: {query: goal}}` instead of the default agent body
`{query: goal}`. It never guesses the application type, sends both forms, adds
plugin credentials, or retries with a different request shape. This first slice
accepts ASCII variable identifiers of 1–128 characters; this is a local supported
subset, not a statement of Huawei's complete naming rules. Workflows requiring
additional inputs need a later explicit mapping, not fabricated placeholder values.
`createAgentArtsRuntimeApplication` forwards this trusted option; Desktop settings
do not yet expose it. Existing `event: 'message', data: {text, index}` parsing is
reused without treating text as tool instructions. See the official
[InvokeRuntime reference](https://support.huaweicloud.com/api-agentarts/InvokeRuntime.html)
and [work package](../../docs/modules/MOD-30-WORKFLOW-INPUT-01.md).
