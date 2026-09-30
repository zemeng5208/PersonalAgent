# @personal-agent/learning — provisional workflow candidate lifecycle

This Competition Profile package stores descriptive workflow candidates. It does not
execute steps, call tools, train a model, or register a Runtime/Desktop capability.

`SqliteLearningHost.propose()` appends an immutable version with source and operation
identity. Exact retries return the same version; a stale head or altered retry fails.
An injected, trusted `WorkflowValidatorPort` must return a pass plus an evidence
reference before `activateVersion()` can select that version. A failed validation
cannot activate it; a validator exception leaves it a candidate. A later validated
version can be activated, and an older validated version can be selected again to
roll back. Each switch has a durable, idempotent activation receipt.

`eraseWorkflow()` removes all candidate versions, validation references and
activation history for one exact workflow after a head revision check. It leaves a
content-free marker to prevent ID reuse and requires a successful WAL truncate before
reporting success. `secure_delete=ON` applies to writes by this host. Previously freed
pages and independent backup copies are outside this guarantee. No real user source,
authorization, production validator, or external readback has been supplied yet;
test validators are synthetic.

The package uses its own SQLite file and ordered migrations through
`@personal-agent/storage`. Do not share the file with another module's migration
sequence. The host is a trusted local API, not a consumer or wire protocol.

```powershell
npm.cmd run build --workspace=@personal-agent/learning
npm.cmd run test --workspace=@personal-agent/learning
```
