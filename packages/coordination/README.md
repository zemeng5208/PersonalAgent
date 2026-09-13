# Coordination text ports

COMPETITION-PORTS-01 provides provisional, in-process `CoordinationPort.execute` and
`CloudAgentPort.invoke` types. The consuming coordination package owns their shape.
Runtime injects CoordinationPort; a later AgentArts adapter implements CloudAgentPort.
No production cloud adapter or cloud API is implemented here.

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

Ports are text-only and not frozen. Tool proposals/results, deployment/version/trace,
usage, resumable cloud runs and data-export consent require the next reviewed contract
increment before real AgentArts is enabled. No wire Schema or storage migration changes.
