# MOD-27 Goal graph domain core

Owner: zemeng. Provisional offline increment for the Competition Profile, based on
5944061. No cloud access or persistence adapter. No runtime task transitions.

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

The host must provide atomic persistence CAS and namespace authorization through the
future goo122 storage adapter. The pure expectedRevision check alone is not a
concurrency lock. Namespaces label independent snapshots, not security boundaries.
No MemoryQueryPort, FactChangeFeed or CoordinationStorePort is fabricated here.
MOD-28 will consume the explicit dependencies to analyze impact and repair plans.
Historical snapshots do not undo any external side effects.

Run `npm run test --workspace=@personal-agent/goals` and
`npm run typecheck --workspace=@personal-agent/goals`. Tests use synthetic in-memory
meeting data. The test script builds this new package because the root build list
is maintained separately by goo122. No third-party dependency is added. Workspace
lock entries are included; production composition remains an integration handoff.
