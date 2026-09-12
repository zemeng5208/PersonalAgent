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
MemoryQueryPort and FactChangeFeed remain unavailable. See
[COORDINATION-STORE-01](../../docs/modules/COORDINATION-STORE-01.md) for semantics,
migration, synchronous-call limitations and acceptance.
MOD-28 will consume the explicit dependencies to analyze impact and repair plans.
Historical snapshots do not undo any external side effects.

Run `npm run test --workspace=@personal-agent/goals` and
`npm run typecheck --workspace=@personal-agent/goals`. Tests use synthetic in-memory
meeting data. The test script builds this new package because the root build list
now includes goals and cognition after PR #37. No third-party dependency is added.
Live AgentArts/consumer composition remains an integration handoff.
