# Coordination ports

COMPETITION-PORTS-01 provides provisional, in-process `CoordinationPort.execute` and
`CloudAgentPort.invoke` types. The consuming coordination package owns their shape.
Runtime injects CoordinationPort; `AgentArtsCloudAgentPort` is the explicit,
offline-testable HTTP implementation of the text-only CloudAgentPort boundary.

MOD-04B adds `CompetitionCoordinator`, which validates each bounded text/tool-proposal
exchange with an explicitly injected `CloudAgentPort`. It forwards task revision and
deadline, relays cancellation through a child signal, bounds non-cooperative calls,
and validates results before returning them. Provider exception messages are not
exposed. `UnavailableCloudAgentPort` explicitly rejects with
`UNSUPPORTED_CAPABILITY`; provider-owned lifecycle errors are sanitized because only
the coordinator owns cancellation and deadlines. There is no automatic fallback or retry.

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
recovery. The coordinator creates no second task store. Runtime owns the tool loop,
Policy/Approval/ToolGateway and Evidence; the cloud may only propose a registered tool.
A non-cooperative provider may continue its own internal work after cancellation, but
its late result is discarded. The coordinator is an in-process boundary, not a sandbox
or a data-export authorizer.

Input is the submitted goal, task ID/revision, deadline and AbortSignal. It excludes
conversation history, attachments, credentials, authorization and Runtime methods.
After a locally confirmed tool execution, Runtime may add a bounded continuation with
the proposal ID and JSON result only for the explicit offline `mock` path. The host must
authorize any real cloud transmission; an available port is not consent. Results may be
bounded text or a strict tool proposal (`mock` or `unverified`), but Runtime rejects
`unverified` tool execution/export in this slice. Proposals cannot contain authorization, Evidence or task state.

Explicit offline fixtures live at `@personal-agent/coordination/testing`:
`new FakeCoordinationPort(request => 'Fake: ' + request.goal)` and
`new FakeCloudAgentPort(request => 'Fake cloud: ' + request.goal)`.
Responders may return text or a strict result object. Fixtures do not automatically
enforce cancellation; responders must honor the supplied signal.

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
`application/json` or `text/event-stream`; both forms are byte-limited. Metadata or tool
payloads are not treated as executable proposals. SSE follows standard event boundaries and joins
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

Ports are not frozen. The in-process Fake path covers strict tool proposals and
confirmed-result continuation, but the real HTTP adapter remains text-only.
Deployment/version/trace, usage, resumable real cloud runs and data-export consent need
separate verified contracts. No wire Schema or storage migration changes.
