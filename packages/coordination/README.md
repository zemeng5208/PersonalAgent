# Coordination text ports

COMPETITION-PORTS-01 provides provisional, in-process `CoordinationPort.execute` and
`CloudAgentPort.invoke` types. The consuming coordination package owns their shape.
Runtime injects CoordinationPort; a later AgentArts adapter implements CloudAgentPort.
No production cloud adapter or cloud API is implemented here.

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
