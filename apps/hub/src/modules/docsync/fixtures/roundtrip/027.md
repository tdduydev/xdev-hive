# 0025. Let agents propose skills after hard tasks, in cheap daily batches that a team admin approves

- Status: Proposed
- Date: 2026-10-14
- Deciders: product owner (tdduydev), maintainers

## Context

The product owner agreed (2026-10-14) to the idea of agents creating or improving skills after hard tasks, as Hermes
Agent does, but in the Hive way: skills live in the Git repository `tdduydev/xdev-skills` (spec 006, ADR 0014; the
repo's `hive.json` sets `"proposals": "pull-request"` [taken from the product owner's brief; not verifiable from this
repo]), shared notes live in memory and the project brief (ADR 0022), and a default skill pack exists (SKILLPACK).

The constraint that shapes the design is token cost. ADR 0022 reports that subscriptions already run out; a learning
step after *every* run would add a model call to each task. So the feature must run rarely, on few runs, with a cheap
model, and must not repeat what the team already has or has already refused.

Existing machinery reused: run kinds that are read-only and submit through an MCP tool (`brief`, `doccheck`), pg-boss
cron queues (`codereview-sla`), `GitProvider.commitFiles` + `openPR` (spec 006), the org agent policy (spec 002), and
`applySkillSave` with optimistic versions.

## Decision

1. **Worthy runs only.** A code run (one per task, the last one) is worth learning from when the task was retried at
   least twice (`max(attempt - 1, code runs of the task - 1) >= 2`), or its cost is above the project's p90 (USD when
   the CLI reports it, otherwise input+output tokens; at least 10 samples of the last 30 days, otherwise no cost
   trigger), or a team member marked it "should become a skill". "Cost per run" is the reading of the brief's "chi
   phí/lượt" [Inference: the brief does not say whether "lượt" is a run or a turn].
2. **One batch per project per day.** Table `skill_learning_batches` has a unique key `(project_id, day)` (UTC). The
   cron job `skill-learning-tick` (every 15 minutes) first ingests finished batches, then plans: for each project with
   recent code runs and no batch today it selects up to 8 tasks. No worthy task writes an `empty` batch (no agent
   call). No online shared machine with capability `skill_proposal` writes nothing and is retried on the next tick.
   The next batch starts at the previous `window_to`; runs already in a batch are never selected again.
3. **A read-only run kind `skill_proposal`.** It is created by the runs engine through a port injected from `main.ts`
   (the new module `skilllearn` depends on `runs`, not the reverse). The prompt holds *summaries* per task (goal,
   failed attempts and their reasons, the agent's own report, commands if the worker reported them), the names and
   one-line descriptions of skills already available, and the names of proposals the team rejected. It runs on Sonnet
   with effort medium (Claude CLI), without the brief block, on a shared machine only. Worker capability
   `skill_proposal`; the Go worker treats it like `brief` (detached worktree on the base branch, no write flags).
4. **Submit by MCP.** Tool `skill_proposal_submit` takes 0–3 drafts `{kind: new|edit, name, description, content,
   reason}`; the hub stores the last call. The hub, not the agent, writes the frontmatter.
5. **Filter before storing.** Each draft is dropped when it has an existing skill of the same name (for `new`), no
   skill to edit or unchanged content (for `edit`), or is a duplicate: same name as a pack skill, token-set Jaccard
   >= 0.6 against an available skill, a rejected or pending proposal of the project, or description tokens at least
   80% contained in an approved memory. Dropped drafts are counted (`duplicates`) with the reason in `note`.
   Embeddings and FTS are not used in this MVP: they need pgvector and an embedder, and token-set matching is
   enough for a small daily batch [Inference: untested on real data].
6. **Quota and switch in the agent policy.** `agent_policies.policy.skillLearning = {enabled (default false),
   maxPerDay (default 5, 1–50)}`. `maxPerDay` counts proposals stored today (UTC) for the whole organization; running
   batches reserve one each; nothing is planned once the quota is used, and surplus drafts are dropped.
7. **Approve by a team admin.** Table `learned_skill_proposals` keeps pending, approved and rejected proposals. Approve
   (team admin of the target scope; org admin for org scope; `new` defaults to the source project, `edit` keeps the
   scope of the edited skill) does one of two things: if a skill repo is connected, mark approved and enqueue
   `skill-learning-pr`, whose worker commits `<folder>/<name>/SKILL.md` on branch `hive/learned-skill-<id>` and opens a
   PR (the hub copy arrives through the repo webhook sync after merge); otherwise save it as a hub skill with
   `applySkillSave`. A skill changed since the proposal gives CONFLICT and the proposal stays pending. Reject requires a
   reason and keeps the row so later batches skip it.
8. **Measure.** `skillLearning.stats` returns proposals, pending/approved/rejected, approval rate, duplicates dropped,
   cost and tokens of `skill_proposal` runs, and today's quota. The web shows it above the tab "Đề xuất từ agent" of the
   Skills page.

## Consequences

- Good: at most one cheap read-only run per project per day, and none when nothing is worth learning or the feature is
  off; no change to the code-run path.
- Good: approved skills go through the same Git review as human skills; the hub never writes to `main` of the skills
  repo by itself.
- Good: approval, rejection reason and costs are auditable (`skill_learning.*` audit actions, run cost columns).
- Bad: worker and hub must both be new for the kind to run; old workers do not declare `skill_proposal`, so batches
  wait (`waiting`) instead of running.
- Bad: the digest has no transcript; commands appear only if the worker emits `tool_call` events with a command
  field [the current worker does not emit them, so `Lệnh đã dùng` is empty until it does].
- Bad: the "marked" state is not returned by the run API, so the web button only remembers within the page view.
- Bad: a skill_proposal run left queued (machine goes away) keeps its batch `running` until the run ends; nothing
  cancels it automatically.

## Alternatives considered

- Learn after every run: highest recall, rejected for token cost (the reason this ADR exists).
- Let the agent open the PR directly (as `skill_propose` does): no human gate before Git noise; rejected, the PO wants
  approval in the hub first. The existing `proposals` table was not reused because its approve path saves to the hub and
  closes a PR opened at creation time, the opposite of "approve, then open the PR", and it has no batch, trigger or
  dedupe data.
- Embedding or FTS dedupe: better recall, needs infrastructure that is optional here; left as a follow-up.
- A pull-based ingest from the engine to `skilllearn`: chosen (the module reads the `skill_proposal_report` event of
  finished runs) over a callback from `runs`, to keep `runs` free of a dependency on the new module.

## Links

- Spec [014-skill-learning](../../specs/014-skill-learning/spec.md); ADR [0014](0014-store-skills-in-git.md),
  [0022](0022-project-brief-and-agent-memory.md); spec [006](../../specs/006-skills-repo-sync/spec.md).
