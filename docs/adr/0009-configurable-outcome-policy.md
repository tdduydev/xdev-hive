# 0009. Judge runs with a configurable outcome policy per project

- Status: Accepted (check `ci` not yet evaluated)
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
- Bad: until `ci` is implemented, projects that require it get `needs_review` (SRS RUN-07).

## Implementation note (14 October 2026)

Checked against `origin/main` at `8676c4f`: T090/T091 implement command delivery and evaluation. At dispatch
the hub combines policy-snapshot commands with the matching workflow commands, deduplicating trimmed commands
with the shortest timeout. The worker executes `spec.checks.commands` after the agent and before push. Results
in `run_result.report.commands` include exit code, duration and redacted output tails. The hub treats exit 0 as
passed and nonzero/timeout/start errors as failed; required failures yield `failed`, optional failures yield
`needs_review`. Missing evidence still yields `needs_review`. RUN-07 remains partial only because outcome `ci`
is not evaluated. Verification: `runs.db.test.ts`, `modules/runs/policy.test.ts`, `internal/runner/checks_test.go`.

[ADR 0018](0018-code-review-workflows.md) adds a per-run exception: a matching Code workflow handles review, so the
hub skips the policy's `review` check and direct merge enqueue while retaining other checks. No match preserves the
old policy. Production run ports, router, jobs, SCM handlers and merge gate are connected (T070). Workflow CI gates do not
implement the outcome policy's `ci` check.

## Links

- [decisions.md](../decisions.md) section on outcome policy, [sdd.md section 6.3](../sdd.md#63-outcome-policy)
