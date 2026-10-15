# 0022. Give every run a project brief, let agents propose memories, and measure exploration before the first edit

- Status: Proposed
- Date: 2026-10-13
- Deciders: product owner (tdduydev), maintainers

## Context

The product owner reported that subscriptions run out because "each task seems to re-read the whole project". A
7-day sample of worker runs (coordinator scratchpad, `tokens/out2.txt`) showed:

- 73% of worker run cost (about 39% for runs that edit code) is spent before the first edit, mostly on Bash
  `ls`/`find`/`cat`/`grep` (4,320 commands, 17.2M characters, about 13 per session) and `Read`.
- Files re-read across sessions account for little (1.7M characters); AGENTS.md points at `docs/architecture.md` but
  only 1% of sessions open it.
- The estimate is that a brief of about 3k tokens cuts 12–27% of worker run cost [estimate, not measured yet].

The hub already has shared memory (module `knowledge`: `memories`, `memory_search` for runs, `memory_write` for users,
the Memory page). The ask is to reuse it, not to build a new memory system.

## Decision

1. **Project brief.** Each project has at most one brief: Markdown of at most 12,000 characters (purpose, main folders
   and modules, build/test/lint commands, conventions, traps) in table `hive.project_briefs` of module `knowledge`,
   with `version` (optimistic locking), `commit_sha` (the base-branch commit the agent read), `source` (`agent` or
   `user`) and the last drift a worker reported (`head_sha`, `commits_behind`).
2. **Refresh by a read-only run.** A new run kind `brief` (read-only like `plan`, worker capability `brief`, worktree
   detached on the base branch) asks a cheap model (Sonnet when the CLI is Claude and the project did not pick a
   model) to write the brief and submit it with MCP tool `brief_submit`; the hub saves it when the run finishes
   cleanly. The prompt carries the current brief so human edits are kept. The hub queues it, at most one live per
   project (`runs_brief_active`, filtered on branch `brief/%` because of 55P04), when:
   - the project has no brief and a run is started (`settings.brief.auto`, on by default);
   - a worker reports the base branch is `refreshCommits` (default 50) commits past `commit_sha`;
   - the brief is older than `refreshDays` (default 7) when a run is started;
   - a team member presses "Làm mới" on the web.
   A brief run belongs to the user whose action caused it (the one who started the code run, or pressed "Làm
   mới"), so a project without a shared machine still gets a brief from that user's machine; drift reported by a team
   run makes a team run. Automatic triggers only queue when an online machine usable for that owner declares the
   `brief` capability, so old workers never leave a brief run waiting forever.
3. **Brief in every prompt.** `buildSpec` prepends the brief and a short instruction block to the prompt of every run
   kind that works on the repository (code, review, plan, leader, doccheck, docassist): read the brief and call
   `memory_search` first, open only the files that matter, do not list or dump the whole repository; when the brief
   is older than the last known base head, the block names both SHAs. The spec also carries `brief.sha` so the
   worker can report drift.
4. **Agents write memories under an organization policy.** `memory_write` becomes available to `code` and `review`
   runs. Agent policy gains `agentMemory { mode: off | propose | direct, maxPerRun }` (default `propose`, 5). In
   `propose` mode the memory is stored with status `pending` and only shows after a team member approves it on the
   Memory page; `direct` stores it as approved. The hub refuses writes over `maxPerRun` for the run. `memory_search`
   keeps returning at most 500 characters per hit.
5. **Measure exploration.** The worker parses Claude's stream-json: it snapshots usage at the first `tool_use` of
   `Edit`, `Write`, `MultiEdit` or `NotebookEdit` and sends it as `explore` inside the existing `cost` event
   (`edited` false until then, so a run that never edits reports its whole usage). The hub keeps the latest value in
   `runs.explore`, shows it on the run page and adds "Khảo sát trước khi sửa" to the cost summary of code runs. Codex,
   Gemini and Antigravity do not report it yet.
6. **Wire compatibility.** No new `run_event` kind: drift goes in `run_result.report.repo`, exploration in the `cost`
   event (old hubs strip the unknown key). Old workers never get `brief` runs (capability check).

## Consequences

- Good: agents start from a curated 3k-token map instead of rediscovering the repository; the refresh cost is one
  cheap read-only run per 50 commits or 7 days; before/after numbers come from the same table as cost.
- Good: memories discovered by agents are reviewable before they influence other runs.
- Bad: a stale or wrong brief misleads every run until it is refreshed or edited; the prompt says to trust the code
  over the brief.
- Bad: every prompt grows by up to 12,000 characters; cached prompt prefixes make repeat cost low for Claude
  [inference].
- Bad: an automatic brief run spends a little of the subscription of the user who started the triggering run.

## Alternatives considered

- Store the brief as a document (`docs` key): gives history for free, but review workflows and doc proposals apply to
  doc keys and the brief needs commit SHA and drift fields; a dedicated table is simpler.
- Commit the brief into the repository (AGENTS.md section): every refresh becomes a pull request and agents already
  ignore AGENTS.md links.
- Count commits from push webhooks: projects bound to local folders have no webhook, and GitHub/GitLab payloads
  disagree on commit counts; the worker can count with `git rev-list` on the repository it already fetched.
- New `run_event` kinds for drift and exploration: old hubs close the connection on unknown kinds.

## Links

- ADR 0020 (local project folders), ADR 0017 (team runs only on shared machines).
- Coordinator measurement: `explore.py`, `out2.txt` (not in the repository).
