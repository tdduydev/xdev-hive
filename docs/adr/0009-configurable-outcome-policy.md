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

## Implementation note (14 October 2026)

Checked against `origin/main` at `bf891f4`: spec 009 T090 implements worker execution of `spec.checks.commands` in
the code run worktree after the agent and before push. Results in `run_result.report.commands` include exit code,
duration and redacted output tails. This does not yet make outcome `command` operational: T091 still needs to send
commands from the policy/workflow and evaluate their results in the hub. Keep RUN-07 partial and the unsupported
fallback for missing evidence. Once T091 lands, update this ADR's status and RUN-07 using its verification results;
outcome `ci` remains a separate outstanding check.

[ADR 0018](0018-code-review-workflows.md) adds a per-run exception: a matching Code workflow handles review, so the
hub skips the policy's `review` check and direct merge enqueue while retaining other checks. No match preserves the
old policy. The run-side integration exists (T021), but full hub wiring still awaits T070. Workflow CI gates do not
implement the outcome policy's `ci` check.

## Links

- [decisions.md](../decisions.md) section on outcome policy, [sdd.md section 6.3](../sdd.md#63-outcome-policy)
