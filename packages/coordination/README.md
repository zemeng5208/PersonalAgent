# Coordination ports

COMPETITION-PORTS-01 provides provisional, in-process `CoordinationPort.execute` and
`CloudAgentPort.invoke` types. The consuming coordination package owns their shape.
Runtime injects CoordinationPort; `AgentArtsCloudAgentPort` is the explicit,
offline-testable HTTP implementation of the CloudAgentPort boundary.

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

Input is the submitted goal, task ID/revision, deadline and AbortSignal. An explicitly
enabled initial request may also carry a trusted, per-task directory containing only
`name`, `version` and `inputSchema` for selected tools. It excludes conversation
history, attachments, credentials, authorization and Runtime methods.
After a locally confirmed tool execution, Runtime may add a bounded continuation with
the proposal ID and a host-selected JSON result. Real cloud export requires an explicit
read-only tool binding, a bounded projection, and a final host permission check
before transport dispatch. An available port is not consent. Results may be bounded
text, a strict tool proposal (`mock` or `unverified`), or an explicitly enabled
versioned repair candidate. Proposals cannot contain authorization, Evidence or task
state; Runtime and Policy retain execution and task authority.

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
adapter does not read environment variables and does not implement IAM signing. The
session ID is a stable hash of the local task ID; text mode derives a stable request ID,
while proposal mode uses a fresh UUID for each invocation. Header values are ASCII-safe
and bounded to 64 characters. The local task ID is not exported directly.
Authorization must be non-empty,
bounded, and free of HTTP control characters such as CR/LF.

```ts
const cloud = new AgentArtsCloudAgentPort(
  {gatewayUrl: 'https://agentarts.example', runtimeName: 'agent-arts-demo'},
  {read: signal => trustedHostSecretStore.readAuthorization(signal)},
);
const result = await cloud.invoke(request);
```

Default mode returns only bounded text (`verification: 'unverified'`). Explicit
`responseMode: 'tool-proposal-json'` accepts a strict application JSON text or tool
proposal; `repairCandidateVersion: '1.0'` additionally permits a strict repair
candidate. All remain unverified cloud output, not execution evidence. Responses must
declare `application/json` or `text/event-stream`; both forms are byte-limited. SSE
follows standard event boundaries and joins
multiple `data:` lines with `\n`; for gateways that omit separators, a conservative
fallback accepts only one complete JSON event per `data:` line. Malformed or conflicting
events are rejected. This adapter uses the existing contract error names: `CANCELLED`
for cancellation, `TIMEOUT` for a deadline (the contract has no
`DEADLINE_EXCEEDED`), and `EXTERNAL_FAILURE` for authorization, transport, HTTP, or
malformed-response failures (the contract has no `EXTERNAL_SERVICE_ERROR`).

When a response uses workflow events, each `workflow_start` must pair with a
`workflow_end`; supplied workflow IDs/names must match. The adapter keeps the latest
workflow answer and returns it only after the ordered `task_end` then `end` events.
Intermediate message text is not the final answer, and malformed ordering or a
provider failure rejects the response. The result remains unverified cloud text.

For a cloud deployment whose prompt accepts tool selection, trusted composition may
set `responseMode: 'tool-proposal-json'` and `initialRequestMode: 'goal-with-tools-json'`.
The initial `query` then contains exactly `{"goal": string, "availableTools":
[{"name": string, "version": string, "inputSchema": object}]}`. The host selects
and minimizes the directory for that task; it is capped at 16 entries and 8 KiB.
Missing or empty directories fail locally with `UNSUPPORTED_CAPABILITY`, before
credentials or network. The host must provide `beforeInitialToolCatalogSend` as the
fifth constructor argument to recheck its current task binding after credential read;
absence or rejection prevents transport. The fourth `beforeSend` argument remains the
existing synchronous continuation guard. A confirmed-result continuation keeps its
existing separate query and does not resend the tool directory. Without the opt-in,
the adapter sends the raw goal and rejects a supplied directory.

The adapter alone does not establish AgentArts availability. Deployment, API,
trace/usage and local tool read-back require their own operational evidence. Without
explicit trusted configuration, composition keeps the capability unavailable and never
silently falls back to Local or Fake.

For a Workflow whose start node accepts one text input, trusted composition may set
`workflowGoalInput` to its variable name. The adapter maps the computed request text to
that `inputs` entry; without this opt-in it sends the existing `query` shape. It never
guesses a variable, sends both forms, or retries with another request shape. This
provisional option is not evidence that a deployed Workflow accepts the input.

Trusted composition may pass a sixth constructor argument, `onDiagnostic`, to receive
one content-free receipt when an invocation fails. It contains a fixed failure stage
and error code, with available local request ID, HTTP status, coarse response media
type, observed SSE terminal-event flags, and a fixed schema category. It contains no
goal, response text, authorization, transcript, tool arguments or endpoint. The host
may forward this receipt to its existing private diagnostic outlet. Observer errors
do not change the invocation result; the callback does not authorize retry or change
Runtime task state. Request validation failures before an invocation starts do not
produce a receipt.
For `provider_failure`, the receipt may additionally identify the first matching
fixed field path (`event`, `type`, `status`, or one of those under `data`) and the
matched `error`/`failed`/`failure` token. It includes `providerErrorCode` only when
an `error_code` field is a short service prefix followed by a numeric code, such as
`SERVICE.1234`; arbitrary provider text is discarded. These hints do not change
response acceptance or establish which cloud node failed.

Ports are not frozen. The real adapter's confirmed-result continuation is a separate
invocation, not a native AgentArts run resume. Its bounded projection needs host
authorization; the original goal is not automatically sent again. Request-level
deployment/version/trace and usage association need separate verified contracts. No
wire Schema or storage migration changes.

Tool proposal and confirmed continuation JSON copies preserve own special keys such
as `__proto__` as ordinary data properties. They do not change the copied object's
prototype or silently drop fields before validation and authorization. Repeated
parsing preserves the same JSON payload; schema and Policy checks still apply.
