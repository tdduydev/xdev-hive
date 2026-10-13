# 0018. Review agent pull requests with code review workflows

- Status: Proposed
- Date: 2026-10-13
- Deciders: product owner (tdduydev), maintainers

## Context

The product owner asked for automatic code review "theo workflow" on the web. Two mechanisms exist and neither covers
it:

- Review workflows ([specs/004](../../specs/004-review-workflows/spec.md), WF-01 … WF-05) have phases, AI, rule, CI
  and human gates with quorum, SLA and routing, but only for document proposals (`review_instances.proposal_id` is
  required).
- The outcome policy ([0009](0009-configurable-outcome-policy.md), RUN-07, RUN-08) judges a code run once, with at most
  one cross-review run, no human reviewer inside Hive and no feedback loop to the agent.

Constraints: projects that do not opt in must behave exactly as today; run ownership follows
[0017](0017-admin-web-client-app-and-machine-ownership.md); hub modules must not import each other in a cycle.

## Decision

1. **One configuration surface.** A review workflow has a `subject`, `doc` or `code`, chosen at creation and fixed. Code
   workflows live in `review_workflows` with a `code` column (trigger scope by project, target branch, task type and
   changed paths; merge mode; agent revision limit; stale-approval rule) and are edited on the existing review workflow
   page.
2. **Separate runtime.** Code review instances and gate runs are stored in `code_reviews` and `code_review_gate_runs`,
   owned by a new hub module `codereview`. One instance per pull request head commit; a new commit supersedes it and
   opens the next round with the snapshot of the first round.
3. **Workflow replaces cross-review per run.** When a code run ends `succeeded` or `needs_review` with a pull request and
   a code workflow matches, the hub skips the outcome policy's `review` check, does not auto-enqueue the pull request,
   and starts a code review instance. Without a match the outcome policy behaves as before. Conversion is an explicit
   "create from project settings" draft, never automatic.
4. **AI review runs are team runs by default.** Each reviewer of an AI gate is a run of kind `review` with no owner,
   created by `workflow:<id>`, so it runs only on shared machines or runner hosts (0017). A gate may choose
   `runner: requester` to run on the requester's machine instead.
5. **Agent fixes reuse the comment re-run path.** "Agent revises" queues a new `code` run on the same task and branch
   with the feedback as instructions, without planning, owned like the original run, limited by
   `maxAgentRevisions`.
6. **Commands run inside the code run.** Rule gates of type `command` (and the outcome policy `command` check) are run
   by the worker in the run's worktree after the agent finishes; results come back in `run_result.report.commands`.
   Older workers ignore the new job field and the gate waits for a person.
7. **Module wiring.** `runs` imports `codereview` (start an instance, report finished review runs). `codereview` never
   imports `runs`; it receives `startReviewRuns` and `queueFixRun` through deps from `main.ts`. The merge queue receives
   a `reviewGate` dependency the same way and keeps entries waiting until the instance is approved.

## Consequences

- Good: administrators learn one workflow model for documents and code; reviewers get one "Awaiting my review" queue
  with two tabs on web and app.
- Good: existing projects are unaffected; teams can trial a workflow on one branch.
- Good: the worker command runner also closes the `command` gap of RUN-07.
- Bad: two runtime implementations of the gate state machine (documents and code) share only pure helpers.
- Bad: a team without shared machines must pick `runner: requester` or its AI gates wait.
- Open: how Hive approval relates to provider branch protection (spec 009, Q1). Proposed: a `xdev-hive/review` commit
  status that branch protection can require.

## Alternatives considered

- Store code reviews in `review_instances`: would make `proposal_id` and document fields optional and pull Git and run
  logic into `knowledge`.
- Extend the outcome policy with more checks and human approvals: the policy is evaluated once per run and has no
  phases, routing or queue; it would duplicate the workflow model.
- A separate "Code review workflows" page: would copy most of the gate editor.
- AI review runs owned by the requester (as cross-review today): ties the team's review policy to one person's
  subscription and machine, and often lacks the reviewer CLI.

## Links

- [specs/009-code-review-workflows](../../specs/009-code-review-workflows/spec.md), SRS CR-01 … CR-09
- [0009](0009-configurable-outcome-policy.md), [0017](0017-admin-web-client-app-and-machine-ownership.md),
  [specs/004](../../specs/004-review-workflows/spec.md)
