# 69h2 — Gate executor v1

Status: built, **off in production**. The hub takes no gate job unless `HIVE_GATE_JOBS=1`, and a machine runs nothing
unless the person at it wrote `gate-jobs.json` next to its config. Contract: [69h1-gate-job-contract.md](69h1-gate-job-contract.md).
Parent spec: [69-remote-terminal.md](69-remote-terminal.md) §13.

## Pieces

| Where | File | Role |
|---|---|---|
| core (browser-safe) | `packages/core/src/gate.ts` | manifest/template/receipt schemas, `canonicalJson`, placeholders, `gateGlobMatch`, `gateOutcome` (green/red), RPC inputs |
| core (node) | `packages/core/src/gate-hash.ts` | `gateManifestHash` / `gateTemplateHash` (sha256 of the canonical manifest) |
| hub | `packages/core/src/gate-store.ts` | `gate_jobs`, `gate_manifests`, capability; CAS transitions, sweep, lease, receipt |
| hub | `packages/core/src/sqlite.ts` | `gate.*` methods, who may call them, heartbeat `gate` field, `#putArtifact` shared with `artifacts.put` |
| machine | `apps/desktop/src/main/runner/gate.ts` | `GateExecutor`: local policy, capability, take, clone, spawn, artifacts, receipt |
| machine | `apps/desktop/scripts/gate-evidence.mjs` | runs real jobs through the executor against an in-memory hub (AC09 evidence) |

## Local policy

`<config dir>/gate-jobs.json`, read like the terminal's policy: a regular file of this OS user, mode 0600, not a link,
≤64 KiB. `{ enabled: true, osUser, projects: { <name>: { autoApprove, templates: GateTemplate[] } } }`. The whole file
is void (no gate field in the heartbeat) when a template fails the schema, repeats an id, has a known secret in argv,
or lists an env name that starts with `HIVE_` or is a profile/agent secret name. No UI writes it yet.

Placeholders: an argv element holds at most one of `{sha}`, `{jobId}`, `{artifactDir}`, once; other braces stay literal,
so a `/bin/sh -c '<script>'` template works and its script is inside the hash. `argv[0]` holds none.

## Run

1. The hub's `gate.take({project})` gives the oldest approved free job of this machine (never one with `batchId`), only
   while the machine is not draining or duplicate. Before take, the executor holds `project/gate` in `ResourceLocks`
   (and `*/gui` when a template of the project needs a GUI); merge queue and auto-release skip a held project, and the
   gate does not take while either of them is busy.
2. The local template must hash to `job.templateHash`, else `error/templateChanged` and nothing runs. GUI templates
   need a real session (`launchctl managername` = Aqua; DISPLAY/WAYLAND_DISPLAY on Linux), else `error/noGui`.
3. Clone into `<config dir>/gate/<sha256(jobId)>/clone` from the local repo; with an `origin`, fetch `refs/heads/<ref>`
   from it, else read the local ref. `merge-base --is-ancestor sha tip` or `error/shaNotOnRef`. Then the remote is
   removed and the SHA checked out detached.
4. Spawn argv without a shell, cwd the clone, env from scratch (PATH, HOME, USER, LOGNAME, LANG, LC_ALL, TMPDIR in the
   job dir, TERM=dumb, GIT_TERMINAL_PROMPT=0, Linux display vars, the template's env names, HIVE_GATE_JOB/SHA/ARTIFACTS).
   stdout/stderr go to `<job dir>/log` (0600) and stay there. Timeout = the template's, then `killTree`.
5. `gate.progress` every 30 s renews the lease; `cancelled` kills the tree (receipt `cancelled`), refused (lease gone)
   kills it as `error/leaseLost`.
6. After exit: HEAD and `git status --porcelain --untracked-files=no`, the result file (≤64 KiB, schema, no link), and
   the artifacts the globs match (no link, realpath inside, artifact types of 41, ≤5 MB, ≤20). Text is filtered
   (`redactLines`, the hub/profile tokens, the values of the template's env names) before `gate.artifact`; images go as they are.
7. The receipt is written to `<config dir>/gate/receipts/<key>.json` (0600, with the lease token, tmp + rename) before
   `gate.result`. A lost reply leaves it there; the next poll resends it and never runs the command again. The clone is
   removed once the hub has the receipt.

## Hub

- `gate.create/approve/cancel/reconcile`: a person's web session only (`isTerminalHuman`: no bearer, run, MCP, chat
  leader). Create and approve need `projectSettings`; cancel also the requester or the machine's owner.
- `gate.take/progress/artifact/result`: the machine of the job (`actor.name`), `taskWork`, the lease token (hub keeps its
  sha256). Another machine and a wrong token get the same `forbidden`.
- `gate.get/list/templates`: `view`; `gate.get/list` are in `AGENT_METHODS`, no write is.
- A claimed green is checked again from the receipt's facts (exit, signal, timeout, result file the manifest expects,
  HEAD, tree); a required glob without an uploaded file makes it `failed/artifactMissing`, an upload whose sha256 differs
  `error/uploadFailed`. A job ended meanwhile (cancelled, uncertain) keeps its state and gets a late receipt as evidence.
- Lease: 2 min, renewed to at most `claimedAt + timeoutMinutes + 10 min`. Past it the sweep makes the job `uncertain`;
  only `gate.reconcile` ends it. Requested/approved past `expiresAt` become `expired`.
- Gate artifacts are rows of `artifacts` with `run_id` = job id and an empty `task_id`: `artifact_list {runId}` reads them.

## AC09 evidence (2026-10-08, hc-duytd20-macmini, Aqua, no sandbox-exec in the chain)

Through `gate-evidence.mjs` with `/bin/sh -c` templates (`npm ci`, the check, `result.json` from its exit code):
desktop smoke, web e2e and e2e:mobile all `passed` on main @ 7522eabb with screenshots and `checkedSha` = SHA; the
same `web-e2e --only login-token` template is `failed/exitNonZero` (result `ok:false`, its FAIL screenshot uploaded)
on a branch that renames the menu labels that step checks, and `passed` on main. Receipts and screenshots are the
run's artifacts (`ac09-report.md`, `ac09-gate-receipts.json`). Smoke and e2e make more than 20 screenshots: only the
first 20 by name go up.

## Not done here

- Merge queue binding (spec 69h1 §5 auto-approve, §7 lock hand-over, §9 `mergeQueue.gates`, `requiredGates`,
  `gateWaitMinutes`, finish refusing without green jobs) — G07, G09. Jobs with `batchId` are refused by the executor.
- Web UI: approval screen with the manifest, changed files and risky paths (gotcha #1045: unpublished refs need a
  machine-made preview), job list, reconcile; desktop settings page for templates. Until then jobs are made by RPC.
- Step-up on approve (69c) for a SHA not on the target branch.
- Receipt resend on heartbeat is by poll (each beat), not an ACK field in the heartbeat (gotcha #1044).
- Orphan processes after an app crash are not killed at the next start (the hub makes the job `uncertain`).
- Gate artifacts have no task, so `pruneArtifacts` (which joins on done tasks) never removes them.
