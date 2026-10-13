# 0020. Bind hub projects to local repositories, and grant full permission per project on the machine

- Status: Accepted
- Date: 2026-10-13
- Deciders: product owner (tdduydev), maintainers

## Context

The product owner decided on 2026-10-13:

- The desktop app gets a "Dự án trên máy" screen (group "Máy này"). Each hub project the user can see is bound to a
  repository folder on the machine, like `projects[]` (`{name, repo}`) in `~/.xdev-hive/config.json` of the old app.
  The first time, the app imports that list and matches each folder to a hub project by its `origin` remote, then by
  name. A local repository with no hub project offers "create a hub project from this repository".
- Runs of a bound project on this machine use the bound repository, so the data matches what the developer sees: the
  run's worktree is created from the local repository, not from a separate bare clone and never in the developer's
  working tree. The run's branch is visible in the local repository.
- Full permission ("toàn quyền": Claude `bypassPermissions`, Codex without sandbox, Gemini `yolo`, Antigravity
  `--dangerously-skip-permissions`) is decided per project and switched on at the machine, off by default. A run gets
  it only when this machine enabled it for that project and the organization policy allows full permission
  (`allowFullPermission`).

Before this decision:

- The worker cloned a bare cache per repository URL into `<DataDir>/repos` and created worktrees in
  `<DataDir>/runs/<runId>-<attempt>` (`worker/internal/runner/runner.go`). Nothing mapped a project to a folder.
- The hub sent `runPermissions: workspace|full` from `project.settings.runPermissions` after the policy
  (`resolvePermission`). Antigravity runs code only with full permission, so the hub refused it with
  `CLI_NEEDS_FULL_PERMISSIONS` unless the project setting was `full`, and only picked it on such projects.

Constraints: older workers and older hubs keep working (missing fields mean the old behaviour); personal and shared
machines follow [0017](0017-admin-web-client-app-and-machine-ownership.md); sandboxed runs
([0007](0007-sandbox-gvisor-egress-proxy.md)) are unchanged.

## Decision

### 1. `projects.json` on the machine

The file sits next to `worker.json` and `accounts.json`:

```json
{ "projects": [ { "projectId": "…uuid…", "name": "payment-api", "folder": "/Users/ha/Work/payment-api", "fullPermission": false } ] }
```

- `projectId` is the hub project id. An empty `projectId` is a local repository that is not linked to a hub project
  yet (imported from the old app); it is never used by runs.
- One entry per `projectId`. Binding a folder that is already listed as an unlinked entry replaces that entry.
- Written atomically (temporary file, then rename) under a lock file, with mode 0600, like `accounts.json`.
- The worker reads the file at every run, every heartbeat and every offer that needs full permission, so changes made
  by the app apply without a restart.

Sidecar commands (all accept `--json` and print the list afterwards):

| Command | Effect |
|---|---|
| `hive-worker projects` | List entries with the folder state: exists, is a Git work tree, `origin` URL |
| `projects bind --id ID --folder DIR [--name N] [--repo-url URL]` | Bind; with `--repo-url`, refuse when `origin` does not match |
| `projects unbind --id ID` or `--folder DIR` | Remove a binding or an unlinked entry |
| `projects set --id ID --full=true\|false` | Switch full permission for a bound project |
| `projects import-legacy [--from FILE] [--force]` | Copy `projects[]` of `~/.xdev-hive/config.json` as unlinked entries, once |

**Matching.** Two repository URLs match when host and path are equal, ignoring scheme (`https`, `ssh`, `git@host:`),
user, password, port, a trailing `.git` and letter case. `file://` URLs and plain paths match by cleaned absolute
path (tests). The worker and the app implement the same rule. The app matches imported folders to hub projects by
`origin` first; a folder whose `origin` matches no hub project is matched by name (project key or name, case
insensitive) only when exactly one project has that name.

### 2. Runs of a bound project use the local repository

When the job's `projectId` has a binding and the run is not sandboxed, the runner uses the bound folder instead of the
bare cache:

1. Checks: the folder exists; it is a non-bare Git work tree; its `origin` remote matches `repoUrl`. Otherwise the run
   fails with a Vietnamese message naming the folder and the URLs. The worker never falls back to the bare cache or to
   another remote.
2. `git -C <folder> fetch origin <base>:refs/remotes/origin/<base>` (and the parent branch for review runs).
3. `git -C <folder> worktree add --no-checkout … <DataDir>/runs/<runId>-<attempt> …`, then checkout inside the
   worktree, as before. Code runs use `-B <branch>`, so the branch exists in the local repository.
4. Push goes to the local repository's `origin` with the developer's Git credentials and hooks.
5. Cleanup removes the worktree and prunes, as before.

"Repository not usable" (the PO's "repo bẩn") means the run would overwrite the developer's work, and it fails the run:

- the run's branch is checked out in a worktree that the worker did not create (for example the developer's working
  tree);
- the run's branch exists locally with commits that no `refs/remotes/origin/*` ref contains (unpushed work).

Uncommitted changes in the developer's working tree do not block a run: the run never touches that tree.

The runner records the branch's previous tip in `<DataDir>/runs/<runId>-<attempt>.branch.json` before `-B`. When the
run ends without pushing (failed, cancelled, no changes), cleanup puts the branch back (or deletes it if it was new),
so the local repository looks as before and a retry is not blocked by the run's own commits. After a worker crash,
the start-up orphan sweep does the same from the leftover file.

Git commands that write to the local repository are serialized by a lock file in `<DataDir>/repos/local-<hash>.lock`,
not inside the developer's folder. Codex in workspace mode gets the repository's common Git directory and the
worktree's Git directory as writable roots, like the bare cache before.

### 3. Effective permission

The hub keeps sending `runPermissions` from the project setting and the policy, and adds `fullAllowed` (the policy's
`allowFullPermission`) to the job spec; `projectId` was already in the spec. The worker decides:

| Machine has a binding for `projectId` | Effective permission |
|---|---|
| yes | `full` if and only if `binding.fullPermission && fullAllowed`, else `workspace` |
| no (team machine, or project not bound here) | `runPermissions` from the hub, as before |

A hub that does not send `fullAllowed` counts as allowing full permission only when it sent `runPermissions: full`.
Read-only runs (review, plan, leader, doccheck, docassist) and sandboxed runs ignore bindings for permissions, as before.

### 4. The hub learns which machines grant full permission

`hello` and `heartbeat` carry an optional `localProjects: { bound: string[], full: string[] }` (project ids, at most
256 each). The hub stores them in `machines.bound_projects` and `machines.full_projects` (migration 0057, existing
row-level security of `machines`). A `hello` without the field (older worker) clears both; a `heartbeat` without it
leaves them unchanged. Older hubs strip the unknown field.

Dispatch computes the same effective permission per candidate machine. For a code run whose CLI needs full permission
(Antigravity), only machines where it is `full` are candidates, and a run without a chosen CLI picks Antigravity on a
machine only where it is `full`. `runs.start` no longer refuses Antigravity with `CLI_NEEDS_FULL_PERMISSIONS` when the
policy allows full permission and a machine the user may use (own personal machine or shared machine of the team)
grants it for the project. The policy snapshot of the attempt records the machine's effective permission, and a run
note says when the machine changed it.

### 5. Desktop screen

Screen `projects` ("Dự án trên máy" / "Projects on this machine") in the "Máy này" group, permission `runs.local`. It
lists the hub projects the user can see with name, repository URL, bound folder (chosen with the system folder
picker; the worker checks `origin`), the full permission switch and a state: not bound, bound, remote mismatch, folder
missing. A section lists local repositories without a hub project, each with "create a hub project from this
repository" (the existing `projects.create` contract, with the `origin` URL as an existing repository). Creating needs a
Git connection of the organization for the repository's host; without one the screen says so and links to the Git
connections page of the web (organization administrators).

The full permission switch asks for confirmation and lists the risks per CLI. It is off and locked, with the reason,
when the organization policy forbids full permission.

## Consequences

- Good: run branches and commits appear in the developer's repository; no second clone per repository.
- Good: a developer can let Antigravity (or any CLI) run with full permission on their own machine for one project
  without changing the project for the whole team.
- Good: older workers and hubs behave as before.
- Bad: runs depend on the state of the developer's repository (credentials, hooks, `origin`); a broken repository
  fails the run instead of silently using a clean clone.
- Bad: the developer's Git hooks run for agent commits and pushes in the worktree.
- Bad: whoever controls the machine can grant full permission for a project; the organization can only switch full
  permission off for everyone (`allowFullPermission`). This matches the risk of running a CLI by hand on that machine.
- Bad: a crash between `-B` and cleanup that also loses `<DataDir>` leaves the branch at the run's commits; the next
  run then reports unpushed commits instead of resetting them.

## Alternatives considered

- Run in the developer's working tree: overwrites files being edited and allows only one run at a time.
- Keep the bare cache and add the local repository as an alternate: the run branch would not be in the local
  repository, which the PO asked for.
- Store bindings on the hub: folders are machine paths and differ per machine; the hub only needs the project ids.
- Fall back to the bare cache when the folder is broken: hides the problem and runs on different data than the
  developer sees.

## Links

- [0006](0006-outbound-worker-protocol.md), [0007](0007-sandbox-gvisor-egress-proxy.md),
  [0017](0017-admin-web-client-app-and-machine-ownership.md), [run-permissions.md](../run-permissions.md)
- SRS FLEET-10, DESK-12
- `worker/internal/projects`, `worker/internal/runner/local.go`, `apps/hub/src/modules/runs/engine.ts`
  (`machinePermission`), `apps/desktop/src/screens/projects-screen.tsx`
