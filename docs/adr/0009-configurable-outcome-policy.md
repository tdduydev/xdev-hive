# 0009. Judge runs with a configurable outcome policy per project

- Status: Accepted (checks `command` and `ci` not yet evaluated)
- Date: 2026-10-11
- Deciders: maintainers

## Context

"Success" differs by project and task type: some need tests to pass, some only a report from the agent.

## Decision

Each project defines ordered checks (`changes`, `agentReport`, `command`, `review`, `ci`), each required or optional,
with overrides by task type. A run ends as `succeeded`, `no_changes`, `needs_review` or `failed`. The policy is
snapshotted on the run so later edits do not change past results. Checks the hub cannot evaluate yet lead to
`needs_review`.

## Consequences

- Good: projects choose their own bar; results are reproducible.
- Bad: until `command` and `ci` are implemented, projects that require them get `needs_review` (SRS RUN-07).

## Links

- [decisions.md](../decisions.md) section on outcome policy, [sdd.md section 6.3](../sdd.md#63-outcome-policy)
