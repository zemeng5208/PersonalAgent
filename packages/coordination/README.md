# Coordination text ports

COMPETITION-PORTS-01 provides provisional, in-process `CoordinationPort.execute` and
`CloudAgentPort.invoke` types. The consuming coordination package owns their shape.
Runtime injects CoordinationPort; `AgentArtsCloudAgentPort` is the explicit,
offline-testable HTTP implementation of the text-only CloudAgentPort boundary.

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

The adapter is not a claim that AgentArts is available. Real project/runtime setup,
deployment, authentication, streaming behavior, trace/usage, and local Policy or
ToolGateway read-back remain unverified; without explicit configuration composition
must keep the capability unavailable and must not silently fall back to Local or Fake.

Ports are text-only and not frozen. Tool proposals/results, deployment/version/trace,
usage, resumable cloud runs and data-export consent require the next reviewed contract
increment before real AgentArts is enabled. No wire Schema or storage migration changes.
