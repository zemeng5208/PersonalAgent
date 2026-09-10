# @personal-agent/cognition — MOD-28 local impact core

Owner: zemeng. Profile: huawei_ict_agentarts. Pure local domain increment;
no AgentArts, Memory, persistence, scheduler, tool execution or Runtime writes.

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
The paired MOD-27 source is included in the same graph-impact work package on
baseline 5944061; both increments must be reviewed before production integration.

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
