# MOD-28 Fact projection graph commit

- Profile: `huawei_ict_agentarts`.
- Owner: zemeng; independent review required before integration.
- State: review (local implementation; independent review and integration pending).
- Dependencies: PR #73 pure projection and PR #57 atomic graph store port.
- Scope: `packages/cognition` graph-only consumer; no shared Schema or migration.

The consumer checks the baseline against the bound store and validates an
append-only, fact-only candidate before a single atomic `appendBatch` CAS.
Existing Goal/Decision/Plan history is preserved. Conflicts are surfaced without
retry; an empty suffix is a no-op. The impact report is recomputed from graph
data rather than trusted from a caller-supplied report.

This increment does not acknowledge FactChangeFeed batches, persist deduplication
or checkpoint state, support skipped initial Memory revisions, grant cloud export
permission, or schedule work. Graph commit and feed acknowledgement are not an
atomic transaction. A provider that commits and then returns malformed data
requires reconciliation; rejection is not proof that the write rolled back.

## Necessary verification

Memory, Goals and Cognition builds passed. Focused synthetic tests passed 3/3
using Node 24.19.0 with `--test-isolation=none`: multi-fact single CAS and unchanged
non-facts; read/CAS revision conflict with no retry; malformed candidate and
isolated no-op. The default test runner was blocked by Windows spawn EPERM
before test execution. `git diff --check` passed.
No cloud service, private data, Electron or packaging acceptance is involved.
