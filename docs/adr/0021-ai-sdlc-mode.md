# 0021. Run an AI SDLC mode as data-defined presets over existing review, task and run machinery

- Status: Proposed
- Date: 2026-10-13
- Deciders: product owner (tdduydev), maintainers

## Context

The product owner asked for an "AI SDLC" mode and decided on 2026-10-13:

- AI-DLC, Spec Kit, BMAD and Kiro/OpenSpec are presets of one mode model held as data, with light presets for bug
  fixes and small changes and a size-based suggestion.
- Documents live in both places and stay in sync: written and approved on the hub with the existing editor, committed
  as Markdown into the project repository after approval, and edits made in the repository come back as proposals.
- Code runs are hard-gated: a task's code run starts only when the required documents of earlier phases have a
  baseline; team administrators may override with a reason, which is audited; light presets have fewer gates.
- Agents write, people approve: agents draft requirements, design and tasks and ask clarifying questions that people
  answer on the web or in the app; approved task lists become hub tasks with dependencies, small steps are checklists
  inside a task, tasks run in waves, and each task is one pull request through code review (spec 009).
- The desktop app is where users do the whole flow (review and documents only, no agent execution); the web does the
  whole flow with the same shared screens plus configuration; agent work runs on dedicated "AI SDLC worker" machines
  that need only `hive-worker`, with machine labels to keep other runs off them.

What exists: document review workflows with gates and baselines (spec 004, `knowledge/reviews.ts`), the block editor
(spec 005, `packages/doc-editor`), commits to Git through `GitProvider` (spec 006 skill sync), tasks without
dependencies, runs dispatched by `pickMachine` with ownership rules ([0017](0017-admin-web-client-app-and-machine-ownership.md)),
code review workflows (spec 009, schema only). Approved documents are never written to Git today. Machines have no
labels and the hub does not know CLI accounts on a machine.

Constraints: projects that do not enable the mode behave exactly as today; older workers keep working; hub modules
must not import each other in a cycle; one PostgreSQL, no new service.

## Decision

1. **Mode as data.** A zod schema `sdlcMode` in `packages/contracts/src/sdlc.ts` describes phases (each of one of seven
   standard kinds: intake, requirements, design, decomposition, implementation, verification, release), documents with
   repository path templates and required sections, agent steps with prompts, gates as spec 004 `reviewPhase` lists,
   decomposition rules (parser, granularity, requirement id pattern, limits), blocking level (`hard`, `soft`, `none`)
   and converge rounds. Built-in presets are constants in contracts; organizations and teams clone them into
   `sdlc_modes`. A work item ("hạng mục") snapshots its mode at creation.
2. **New hub module `sdlc`.** It owns items, item phases, documents and their sync state, clarifying questions, agent
   steps, task slices, trace links and gate overrides. It imports `knowledge`, `tasks`, `scm`, `notify`, `tenancy` and
   `governance`; it never imports `runs`, `codereview`, `leader` or `fleet`. `runs` imports `sdlc` for the code run gate
   and run callbacks; run creation reaches `sdlc` through dependencies injected in `main.ts`.
3. **Gates reuse document review workflows.** `knowledge.startReview` asks an injected `workflowFor(docKey)` before
   prefix matching; for documents of an item it returns a workflow built from the phase's gates. `knowledge.finish`
   calls an injected `onBaseline` in the same transaction. Baselines stay `doc_versions` rows.
4. **New run kind `sdlc`.** Agent steps run as `sdlc` runs in a temporary worktree from the default branch, may write
   files there, never commit or push, receive the item's current baselines as seed files, and return the files listed
   by the step in `run_result.report.artifacts`. Questions and structured results go through MCP tools `sdlc_ask`,
   `sdlc_report` and `sdlc_context`. Only workers announcing the `sdlc` capability receive these runs. Prompts are built
   on the hub per preset step, and call a method skill when the repository has it.
5. **Repository sync.** After a baseline, a job writes the item's changed documents in one commit with a
   `Hive-Sdlc-Item` trailer, by pull request (proposed default) or direct commit per project. Pushes to the default
   branch (webhook, plus a periodic scan) are compared by content hash; a difference not made by the hub becomes a
   document proposal that goes through the phase gate. Repository edits never become a baseline on their own.
6. **Tasks get dependencies and checklists.** The `tasks` module gains `task_dependencies` and `tasks.checklist`. The
   hub parses the approved task document into a breakdown (one hub task per run and pull request, steps as checklist
   items, dependency graph, waves); the breakdown review screen edits the structure and writes the Markdown back, so
   the document stays the single source.
7. **Hard gate in `queueRun`.** Every code run path goes through `queueRun`, which calls `sdlc.codeRunGate`: open
   dependencies fail with `TASK_DEPENDENCIES_OPEN`, missing required baselines before the implementation phase fail
   with `SDLC_GATE_BLOCKED`, unless an unexpired, unrevoked override exists. Overrides need the danger permission
   `sdlc.override`, a reason and are audited and notified.
8. **Machine labels and filters on the hub.** Machines get `labels` and `labels_only`; runs get `required_labels`.
   `pickMachine` keeps only machines with every required label, and `labels_only` machines take only runs carrying one
   of their labels. Labels are set by team administrators on the hub or carried by the registration token; workers do
   not declare them, so the WebSocket protocol does not change for labels.
9. **Accounts visible on the web.** Heartbeats carry an optional summary of CLI accounts without secrets. A new hub to
   worker message `account_set` enables or disables an account on shared machines whose worker announces
   `accounts-remote`. Adding an account stays on the machine (`hive-worker accounts add|discover`).
10. **Shared screens.** A package `@xdev-hive/sdlc-ui` holds the item board, item detail, questions, breakdown review,
    trace matrix, metrics, mode editor and fleet table; the web and the desktop app provide routes, menus and an
    environment object, like `@xdev-hive/doc-editor`.

## Consequences

- Good: one model covers five methods and light paths; adding a method is data plus, at most, a task-document parser.
- Good: reviewers keep one queue and one editor; agents read approved documents in the repository.
- Good: the gate sits where every code run passes, so no path skips it.
- Good: projects that do not enable the mode, and older workers, are unaffected.
- Bad: a second consumer of review workflows (after spec 009) adds injected hooks to `knowledge`.
- Bad: sync by pull request adds a merge step for already approved content; direct commits conflict with branch
  protection.
- Bad: parsers for each task-document format must track upstream format changes.
- Bad: `sdlc` runs may write files on the worker, unlike other non-code runs; they are confined to a temporary
  worktree and never pushed.
- Open: sync method (spec 011 Q1), the app profile for BA/PO (Q2), items spanning several repositories (Q3).

## Alternatives considered

- One hard-coded pipeline per method: duplicates gate and phase logic and conflicts with the product owner's decision.
- Run the methods' own CLIs (`specify`, `aidlc`, BMAD installer) on workers: ties Hive to their release cadence and
  state files; prompts with optional skills give the same documents.
- Keep documents only on the hub (agents read through MCP): agents and developers expect them in the repository; the
  product owner chose both.
- Treat the repository as the only source (like skills in [0014](0014-store-skills-in-git.md)): approval would happen
  in pull requests, losing the editor, suggestions and multi-gate review.
- Gate at dispatch instead of `queueRun`: runs would sit queued without a clear refusal; the check at creation gives
  the user the missing documents at once.
- Push every small Spec Kit task to the board: rejected by the v1 lessons (58 small tasks turned the board into
  noise).
- Let workers declare their labels: a machine could claim a label to receive sensitive runs.

## Links

- [specs/011-ai-sdlc-mode](../../specs/011-ai-sdlc-mode/spec.md), SRS SDLC-01 … SDLC-17
- [0005](0005-contract-first-api.md), [0006](0006-outbound-worker-protocol.md),
  [0012](0012-spec-driven-development.md), [0015](0015-doc-editor-collaborative-engine.md),
  [0017](0017-admin-web-client-app-and-machine-ownership.md), [0018](0018-code-review-workflows.md),
  [0020](0020-local-project-folders-and-machine-full-permission.md)
- [specs/004](../../specs/004-review-workflows/spec.md), [specs/005](../../specs/005-doc-editor/spec.md),
  [specs/009](../../specs/009-code-review-workflows/spec.md)
