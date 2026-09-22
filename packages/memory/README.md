# @personal-agent/memory — provisional queries and fact feed Fake

This provisional Competition Profile package defines the first in-process
`MemoryQueryPort` slice: current effective facts, bounded history, exact immutable
versions, and an explicit `FakeMemoryHost`. It is not a wire protocol, production
database, Local Profile extension, or proof that Memory is available.

The trusted host provisions and binds a namespace. Binding requires an explicit,
non-empty enumeration of allowed sensitivities; no ordering such as “restricted
implies private” is inferred. The returned consumer port has no namespace, scope,
writer, task, scheduler, credential, or cloud method. Hidden and nonexistent exact
FactRefs produce the same fixed `SCOPE_DENIED` result.

Facts use stable ID/revision, source, canonical UTC observation and half-open validity,
sensitivity, active/withdrawn state, confirmation origin, and an exact correction
reference. Summary text is bounded to 4,096 characters and source references to 1,024.
Revision history is append-only inside the Fake. A withdrawn latest version is not
replaced by an older active version; a hidden latest version likewise does not expose
an older visible value as current.

`listCurrent` and `listHistory` return isolated copies with random opaque snapshot and
cursor tokens held only by the Fake host. Tokens bind namespace, exact scope set,
query kind, filter and watermark. New versions cannot appear in an older snapshot.
There is deliberately no default retention/expiry policy; unknown, mismatched or
cross-scope tokens are rejected uniformly. These in-memory tokens do not survive a
process restart and are not evidence of a persistent cursor implementation.

`readFactForImpact` is the minimal pure consumer: it requests one exact `FactRef`
through the public query port, verifies that reference and returns an isolated copy.
It assumes a conforming typed port and does not fully revalidate arbitrary hostile
port output. It does not import a
storage implementation, create tasks, modify a Goal graph, schedule work, execute a
tool or send data to AgentArts.

Malformed Fake inputs, including throwing getters or proxies, are reduced to the
same fixed validation error. This is fixture-boundary hardening, not a host-process
security sandbox.

Build and test this package directly after workspace dependency setup:

```powershell
npm.cmd run build --workspace=@personal-agent/memory
npm.cmd run test --workspace=@personal-agent/memory
```

The workspace is registered in the root build order and lockfile without adding
external dependencies.
The provisional `FactChangeFeedPort` adds host-bound, bounded bootstrap/change
batches without exposing internal sequence numbers. A reader has no ack method;
confirmation belongs to the trusted host and must match the complete delivered
batch and checkpoint. `parseFactChangeBatch` validates the fixed envelope and
isolates its references; it does not prove processing or advance consumption.
The Fake increment exercises protocol semantics only. The optional
`@personal-agent/memory/sqlite` entry now persists immutable fact versions, opaque
query snapshots/cursors, pending feed batches, checkpoints and idempotent receipts
in a dedicated SQLite database. It uses `@personal-agent/storage` migrations and
must not share a database file with another independent migration sequence.

This adapter is not registered as a Runtime capability and does not make the ports
`frozen`. Its confirmation transaction covers only the memory-owned delivery journal;
Goal/cognition projection and feed confirmation are not yet one atomic host
transaction. Physical deletion, retention/backup policy, real ingestion and
cognition/Runtime projection remain unavailable. See
[ADR-0008](../../docs/adr/0008-fact-feed-consumption.md) (proposed) and
[MOD-09C](../../docs/modules/MOD-09C-MEMORY-SQLITE-01.md).

Feed transactions check cancellation/deadline after acquiring the write lock and
immediately before commit. Expired or cancelled work rolls back; a committed
confirmation returns its durable receipt. Synchronous SQLite lock waits cannot
be interrupted immediately. Recovery tests cover a second-process writer and
injected receipt-write failure without using private user data.
