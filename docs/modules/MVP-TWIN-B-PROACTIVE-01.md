# MVP-TWIN-B-PROACTIVE-01

- Profile `huawei_ict_agentarts`; MOD-27/28 consumer increment; owner zemeng.
- Status `review`; registered non-author review and root integration pending.
- Ownership: cognition plus the new `proactive-cognition-host.ts` and dedicated test.
  Runtime public export, Desktop and AgentArts composition remain main-task work.
- Reuses PR #187 (`0dd49e5`). Remote main `a651585` was inspected before implementation.
- No wire capability, database migration, new dependency, scheduler or second task store.

## Intended product chain

Trusted changes → versioned Facts / Goal revision → affected dependencies → several
legal approaches → **Laya proactively selects → AgentArts orchestrates** → local
Runtime / Policy / ToolGateway execution and Evidence. Routine low-risk work should
proceed inside the current authorization scope; only major permissions prompt the
user. Laya does not issue permission, and its selection does not bypass AgentArts.

The host automatically consumes existing Memory confirmation/projection receipts,
records its review in TaskRuntime checkpoints and hands the chosen approach to the
existing AgentArts application path. It never directly commits a repair or invokes
a local repair tool. Private mailbox classifications cannot enter the public Fact
host or a cloud prompt simply because Laya analyzed them locally.

`buildMinimalRepairCandidate` retains existing text and dependency identities while
proposing exact new dependency revisions in topological order. Expired, future,
withdrawn or cyclic heads remain RECHECK. Changed meeting times may require new
plan text; a structural rebind is not semantic proof. The candidate is input for
AgentArts, not a completed repair. KEEP means no affected dependency in this scope;
RECHECK and REVISE are recorded approaches, not task or tool completion.

## Host interface

`createProactiveCognitionHost({application, facts, graphNamespace, bindingVersion,
chooser, prepareOptions?, selectionHandoff?})` exposes:

- `consumeAndReview({at, limit, afterGraphRevision, deadline, signal})`: bounded
  consumption plus persisted impact/review processing. Returns `reviews`,
  `nextGraphRevision`, feed `atWatermark` and independent `hasMoreReviews`.
- `reviewGoalRevision({expectedGraphRevision, previousGoal, currentGoal}, context)`.
- `readReview(taskId)`: trusted-host readback, not a raw Renderer or cloud payload.
- `handoffReview(taskId, context)`: recover the same AgentArts handoff without
  repeating a completed Laya choice.
- `close()`: stop this host; its Fact host remains owned by the caller.

Default approaches ask AgentArts to verify the change, defer/recheck, or evaluate
a minimal repair. Optional `prepareOptions(review, context)` supplies 2–16 specific
legal approaches `{id, revision, description, action: 'RECHECK' | 'REVISE', repair?}`.
Repair candidates are checked against exact graph revision and affected node refs,
then previewed without writing. Options never contain authorization or tool calls.
Laya selection scores retain `calibrated: false`.
The local decision context includes the changed facts and affected plan summaries.
The earlier demo-only 4,000-character context, 800-character option description,
three-node excerpt and cloud goal truncation limits are removed. Existing transport
body limits and actual server option-count constraints still apply. Local context
is not automatically copied into the independently approved cloud projection.

### Time-only expiry consumption

`consumeAndReview` also detects current public Facts whose `validUntil` has elapsed,
even if the source feed has no new event. Once the feed reaches its watermark and
the receipt backlog is empty, an idle consumption pass uses the existing
`analyzeImpact` to select their affected Goal/Decision/Plan versions. A pass that
already processed Fact reviews leaves the expiry scan to the next existing tick.
The Desktop goal cognition host already calls this entry point; no new scheduler
or store is introduced.

An expiry review uses the same TaskRuntime intent/review checkpoints, Laya chooser
and AgentArts handoff. Its key binds exact expired Fact and consumer references,
excluding polling time, deadline and unrelated graph revision changes. It does not
advance the Fact receipt cursor. Only active, public, current Fact versions past
their end time qualify; future or superseded versions do not. Expiry offers RECHECK
and defer, without a local repair or an extension to the source validity period.
Custom options for this trigger must also remain RECHECK without a repair payload.

Targeted validation: Runtime build passed; the existing Fact correction and Goal
revision cases plus the new expiry-to-AgentArts case passed 3/3 using real SQLite
and explicit Fake Laya/AgentArts. The new case covers the expiry boundary, repeated
polling, restart and an unrelated graph append. No live cloud/model or Desktop
smoke was run for this host-only increment.

This consumes graph validity, not the separate knowledge-cache or interest helpers.
Those still need trusted providers: knowledge requires cache version, exact content
hash, successful-check time, bound changed/withdrawn receipts and exact consumer
references; interests require topic/interaction evidence, verified source transport,
tracking scope and revocation state. Public Fact summaries cannot supply these
fields. Do not derive a body hash from a summary or treat observation time as a
successful source check. No missing provider is replaced with a production Fake.

`selectionHandoff` implements:

```ts
prepare(review: ProactiveCognitionReview, context: MemoryReadContext): Promise<{
  exportPolicyVersion: string; goal: string;
} | undefined>;
read(commandId: string): TaskSnapshot | undefined;
dispatch(request: ProactiveSelectionHandoff, context: MemoryReadContext): Promise<TaskSnapshot>;
```

`ProactiveSelectionHandoff` contains `commandId`, `reviewTaskId`, `selectionDigest`,
`exportPolicyVersion`, `goal`, `deadline`. This is an internal host envelope, not a
new cloud protocol. Only the explicitly permitted, minimized `goal` should enter
the existing `CoordinationRequest`. `prepare` must check data egress permission and
return undefined when unavailable. `dispatch` must revalidate scope/revocation and
policy version, honor cancellation/deadline, and use existing Runtime idempotency
for the exact command. `read` only looks up an existing task and causes no network
activity. Never upload raw review checkpoints, Fact history, private headers or
authorization objects. Root owns the actual approved projection and cloud binding.

## Durability and boundaries

Memory staging/confirmation/projection retain their existing recovery protocol.
Review identity is bound to namespace, binding version and exact trigger. Existing
created review tasks resume the original intent; interrupted tasks with saved review
output are reconciled without another model call. Missing interrupted output is
explicitly not performed; cancellation and terminal failure do not reopen tasks.

The handoff envelope is saved before dispatch. Replay first reads the existing
AgentArts Runtime task, otherwise submits the same command and immutable payload.
An expired undispatched envelope returns `expired` without blocking the review
cursor or extending authorization. A callback failure can be retried via
`handoffReview`, which reuses the same envelope. Submitted is task acceptance only;
real AgentArts completion, local writes and Evidence need their own readback.
Cancellation during dispatch reads back the stable command: an existing task is
returned as submitted; otherwise `pending` makes the possible submission explicit.
Cancellation before an envelope is saved prevents dispatch. The root adapter must
forward the signal and check it immediately before actual Runtime/network submission.

## Validation and remaining work

Verification uses synthetic SQLite sources, Fake Laya and Fake AgentArts. No real
model process, cloud, mailbox, microphone, Electron or installer is started.
Available Node 26.3.0/npm 11.16.0 differs from required Node 24.15.x/npm 11.12.x;
the mismatch is recorded rather than changing global tools.

Completed checks: cognition build/typecheck, Runtime dependency build and Runtime
build passed; cognition workspace tests 51/51; dedicated proactive host tests 10/10;
architecture checks 3/3; `git diff --check` passed. The final host tests propagate
signal/remaining timeout into Client. The affected Laya choice test also passed
after removing demo text caps.
No full repository check was run for this bounded work package. Fake AgentArts
tests exercise the actual Client → Runtime Application → Coordination path, including
restart idempotency, export denial, expiry, cancellation/close, custom options and
scope rejection. They assert that the host itself never appends repaired plans.

Real source adapters, private Fact ingestion, Desktop source lifecycle, authorized
cloud projection, Laya/AgentArts live execution and later Policy/Evidence write
acceptance remain main integration/live-validation work. Interest policy from #187
is reusable, but this increment does not start permanent subscriptions or crawling.
