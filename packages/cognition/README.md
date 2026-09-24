# @personal-agent/cognition — MOD-28 local impact core

Owner: zemeng. Profile: huawei_ict_agentarts. Pure local domain increment with
an optional host-bound persistent-store consumer; no AgentArts, Memory,
scheduler, tool execution or TaskRuntime state transition.

`analyzeImpact(graph, evaluatedAt)` validates and replays the complete MOD-27
graph. It returns current Goal/Decision/Plan references with KEEP or RECHECK,
reasons and exact causal references. Superseded, withdrawn and out-of-validity
versions propagate through pinned dependencies. Old unresolved changes remain
visible; unrelated new facts do not invalidate every plan. Time is explicit UTC
so expiry and JSON replay are deterministic. Withdrawn plans KEEP their inactive
state; KEEP is not an assertion of truth, task success or authorization.

`proposePlanRevision(graph, evaluatedAt, {expectedGraphRevision, plan: {id,
revision}, summary, reason})` validates an explicit candidate for an affected
active plan. It returns REVISE with one before/after summary change. It rejects
stale revisions, unchanged text, unaffected plans and extra fields. This is only
a candidate, not a semantic judgment that the new text solves the problem.
It does not rebind dependencies, clear RECHECK, append versions or execute actions.
Host review, fresh revision checks, atomic persistence and Runtime/Policy remain
required before accepting or acting on any proposal. Proposal text is untrusted
data and output identifiers must remain within the host's privacy boundary.

Only the public `@personal-agent/goals` export is consumed. These provisional
types are NOT a frozen PlanPatch wire contract or invented FactChangeFeed.
The MOD-27 source was integrated separately. This package consumes only its public
exports and the host-bound provisional store export; both increments still require
their own review evidence before production use.

Tests: `npm test --workspace=@personal-agent/cognition`. Synthetic meeting data
covers propagation, stale historical paths, expiry, withdrawal, unrelated plans,
deduplication, deterministic replay, revision checks and summary-only proposals.
The module build first builds goals; root production build ordering remains
goo122 integration work. Workspace lock entries are included for clean CI installs.
No new third-party dependency is introduced.
Full-history validation/copying and cause expansion target small graphs; large
graph performance and cloud-assisted semantic plan repair are not delivered.

## Runnable local replay

Run `npm run demo --workspace=@personal-agent/cognition` to replay a synthetic
meeting correction through impact analysis, explicit candidate, manual fixture
version rebinding and reanalysis. The JSON report shows three affected nodes,
two after rebinding only the goal, and zero after the full explicit repair.
It asserts stale candidate rejection, unchanged unrelated plan, historical
snapshot preservation and deterministic JSON replay. All edits are to in-memory
fixture copies. `mock` is deliberate: no host approval, storage, scheduling or
external reminder execution is demonstrated. KEEP means no detected dependency
or validity issue, not that the fixture's chosen times are semantically proven.

## Local evaluation baseline

Run `npm run evaluate --workspace=@personal-agent/cognition` for a fixed synthetic
impact-classification evaluation using the existing meeting replay. Four stages
are scored against explicit expected RECHECK sets and a deliberately simple
recheck-everything reference. The JSON reports confusion counts, precision/recall
(null for zero denominators), accuracy and unnecessary rechecks. Repeated runs
measure determinism only, not independent statistical samples.

This is a `mock` local-domain baseline, not AgentArts/model quality evaluation,
measured latency or token savings. It performs no network calls, external actions
or persistent writes. See [the work package](../../docs/modules/MOD-31-LOCAL-EVALUATION-01.md).

## Bound persistent-store consumer

`analyzeStoredImpact(boundStore, evaluatedAt)` reads and analyzes the exact
snapshot returned by a host-bound provisional `CoordinationStorePort`.
`commitStoredPlanRevision(boundStore, evaluatedAt, request)` revalidates an
explicit Plan candidate, then appends one version with caller-selected exact
dependencies. A stale graph or a commit-time race returns `kind: 'conflict'`
with a fresh snapshot and impact report. A stale Plan `NodeRef` revision keeps
the `proposePlanRevision` `REVISION_CONFLICT` error instead of returning a
graph-conflict object whose graph revisions are equal. It never retries the
write. Invalid, unaffected or extra-field requests are rejected before reading
the bound store. Returned snapshots and proposals are isolated copies. The
consumer cannot select a namespace and does not receive the Runtime host.

An applied result only proves durable domain append. It does not approve text,
change task state, schedule a reminder, execute a tool, or clear RECHECK unless
the caller explicitly rebound the complete affected dependency chain. The Fake
tests run with the workspace suite. The SQLite restart scenario lives at
`tests/integration/mod-27-28-persistent-cognition.test.mjs` and is run after the
root build; it uses only temporary synthetic data.

## Explicit multi-node repair consumer

`previewStoredRepair(boundStore, evaluatedAt, request)` validates a non-empty,
ordered set of explicit Goal/Decision/Plan changes against the original
RECHECK report and applies them only to an isolated graph copy. Each candidate
keeps the current node's source, sensitivity, validity window, state and kind;
only summary, reason and explicitly supplied dependencies can differ. Missing,
future-ordered or otherwise invalid dependency references are rejected by the
public graph append preflight. The preview never calls `append` or
`appendBatch`, and does not provide semantic approval or automatic rebinding.

`commitStoredRepair(atomicStore, evaluatedAt, request)` repeats that preview and
submits its ordered inputs through exactly one `AtomicCoordinationStorePort`
`appendBatch` CAS. An old store port without `appendBatch` is rejected rather
than falling back to partial writes. A graph CAS conflict returns one fresh,
isolated snapshot and impact report without retrying; a stale node reference
with an otherwise matching graph remains `REVISION_CONFLICT`. An applied result
proves only the durable graph append. It does not approve repair text, change
task state, schedule or execute actions, rebind dependencies automatically, or
claim cloud/real execution evidence.

## Provisional Laya advice consumer

`ProactiveDecisionService` takes a bounded local decision model.
`LayaDecisionModel` and `LocalLayaHttpTransport` connect it to an authenticated
loopback Laya server supplied by a trusted host. The service returns suggestions
only; uncalibrated suppression or execution labels, low confidence, and model
failure escalate to AgentArts instead of changing task, approval or tool state.

`decideProjectedFactImpact(decision, {graphNamespace, projection, impact, deadline, signal})`
accepts the committed receipt from Runtime's existing memory projection and a
matching impact report. The trusted host binds `graphNamespace`; each cause's
`currentRevision` must match the projected Fact node revision. It asks the
decision service only for Fact changes that caused RECHECK, with at most four
links per call. Empty and unrelated batches still check cancellation and
deadline without calling the model. This adapter neither polls the
feed nor starts the Laya process. The synthetic local probe is
`examples/projected-fact-laya-probe.mjs`; it requires an already running local
server plus `LAYA_PORT` and `LAYA_API_KEY` in its process environment. The
Desktop production Fact consumer has not been connected yet. See
[`MOD-28-LAYA-DECISION-01`](../../docs/modules/MOD-28-LAYA-DECISION-01.md).
