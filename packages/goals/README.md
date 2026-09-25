# MOD-27 Goal graph domain core

Owner: zemeng. Provisional offline increment for the Competition Profile, based on
5944061 (domain slice merged in PR #37 as 41ea79d). No cloud access or runtime task transitions.

`createGraph(namespace)` creates an empty graph. `appendVersion(snapshot,
expectedRevision, node)` validates and returns a copied snapshot. Each Fact, Goal,
Decision and Plan carries provenance, validity, sensitivity, state and revision.
Dependencies refer to already recorded exact node versions. Thus the version graph
is acyclic; corrections do not silently move existing decisions to new facts.
Reusing an ID cannot change its kind. Withdrawal appends a version and keeps history.

`parseGraph` validates ordered history for JSON round trips. `graphAt` returns an
isolated historical snapshot; restore content through a new append to retain audit
history. `currentNodes` includes withdrawal records. `isEffective` evaluates the
half-open validity interval. These functions do not infer that claims are true.

The pure expectedRevision check alone is not a concurrency lock. The provisional
`@personal-agent/goals/store` port and Fake now allow a host-bound namespace;
Runtime supplies atomic SQLite persistence using its existing database. Only the
trusted host can provision/bind stores. Namespaces alone are not user authorization.
MemoryQueryPort and FactChangeFeed now have provisional offline providers and a
recoverable projection; production automatic consumption and real fact sources
remain unavailable. See
[COORDINATION-STORE-01](../../docs/modules/COORDINATION-STORE-01.md) for semantics,
migration, synchronous-call limitations and acceptance.
MOD-28 will consume the explicit dependencies to analyze impact and repair plans.
Historical snapshots do not undo any external side effects.

Run `npm run test --workspace=@personal-agent/goals` and
`npm run typecheck --workspace=@personal-agent/goals`. Tests use synthetic in-memory
meeting data. The test script builds this new package because the root build list
now includes goals and cognition after PR #37. No third-party dependency is added.
Live AgentArts/consumer composition remains an integration handoff.

## Atomic store extension (provisional)

`@personal-agent/goals/store` additionally exports `AtomicCoordinationStorePort`,
which extends the unchanged `CoordinationStorePort` with
`appendBatch(expectedRevision, inputs)`. A nonempty ordered batch is validated
completely before one atomic replacement; invalid nodes or a revision conflict
must leave the durable snapshot unchanged. Each appended node still receives its
own graph revision, and later batch nodes may reference earlier batch versions.
`appendVersions(snapshot, expectedRevision, inputs)` performs the same operation
on an isolated in-memory candidate only. It is not a storage transaction.

The Fake bound store implements the extension; the Runtime host supplies the SQLite
transaction adapter. Old `read`/`append` providers remain valid, but consumers needing
atomic repair must require the new interface and must not emulate it with sequential
writes. No wire operation, authorization, database migration or cloud access is added.
This is synchronous small-graph storage, not an asynchronous cancellable execution
API or evidence that the proposed repair is semantically correct.

## Host-bound goal commands (provisional)

`@personal-agent/goals/commands` offers `createGoal`, `reviseGoal`, `getGoal`,
and `listGoals` for a host that already provisioned and authorized a bound
`CoordinationStorePort`. The host supplies a stable goal ID, `sourceRef`,
explicit validity, sensitivity, reason, and exact dependencies. Creation
rejects any reused ID, including a withdrawn one. Revision requires both
the graph revision and the current goal revision; the store's commit-time CAS
still decides a concurrent write. The write receipt contains the exact prior
Goal reference (or null on creation), the committed Goal version, and graph
revision so MOD-28 can analyze the persisted change. This is not a durable
event stream. A conflict is returned as `GraphError`
with `REVISION_CONFLICT`; the caller must reread and seek a fresh edit.

`getGoal` returns one Goal or null without exposing unrelated graph nodes to
the caller. `listGoals` returns the latest version of each goal, including withdrawn
goals, with the graph revision. It can read an earlier graph revision without
changing current state. Commands preserve each source and all prior versions;
they do not establish that a source is authentic, authorize a user, delete
private history, or automatically repair dependent decisions. The Runtime and
Desktop user command/query path remains a separate integration task.
