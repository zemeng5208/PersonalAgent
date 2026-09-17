# @personal-agent/memory — MOD-09B query Fake

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
`FactChangeFeed`, acknowledgement, durable checkpoints, production storage,
physical deletion, fact ingestion and cognition/Runtime composition remain later
reviewed increments.
