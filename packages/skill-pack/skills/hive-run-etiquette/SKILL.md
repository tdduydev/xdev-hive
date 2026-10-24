---
name: hive-run-etiquette
description: How to work inside an xDev Hive run — read the brief, search team memory, explore narrowly, commit in small steps and report clearly. Use at the start of every Hive code or review run, and whenever you are unsure how much to explore or what to hand back.
---

# Working in a Hive run

A Hive run is one task given to you by the hub. You work in a temporary git worktree on the run's branch. People
review your branch and your report afterwards, often without having watched you work.

## 1. Orient before you open files
1. Read the task text and, if there is one, the approved plan in the prompt. Note what "done" means.
2. Read the project brief in the prompt. It is a map of the repo; trust the code when they disagree.
3. Call the `xdev-hive` MCP tool `memory_search` with the task's key words to find decisions, conventions and traps
   the team already recorded. Call `doc_list`/`doc_get` when the task names a feature with a spec or design doc.
4. Call `skill_list` once if you have not seen the project's skills; load a skill with `skill_get` only when it fits.

## 2. Explore narrowly
- Open only files related to the task. Do not run `ls -R`, `find`, `cat` or `grep` over the whole repo.
- Search with `rg` inside a specific folder; read long files in ranges.
- Read the project's own instructions (`AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`) before changing code.

## 3. Change in small, reviewable steps
- Stay inside the task. Note unrelated problems in the report instead of fixing them.
- Match the surrounding code: naming, comment style, error handling, file layout.
- Commit after each coherent step with a clear message in the project's convention. No WIP or "fix" commits.
- Never commit secrets, tokens, `.env` files, generated build output or files the hub writes for you
  (`.hive-*`, skill folders copied into `.claude/skills/`). See "Local secrets" below.
- Do not push, force-push, rewrite history, change CI settings or touch other branches; the worker pushes for you.

## 4. Verify before you say done
- Run the project's format, lint and the tests closest to your change. Run the full suite if it is cheap.
- If something cannot be run (no database, no network), say so and say what you ran instead.
- Never report success for a step you did not check.

## 5. Report
End with a short report the reviewer can read in a minute:
- **What changed** and why, in two to five bullets, with the main files.
- **How it was checked**: commands run and their result.
- **Not done / risks**: anything skipped, assumptions, follow-ups.

If you learned a decision, convention or trap that others will need and memory does not have it yet, record it with
`memory_write` when the run allows it: a few sentences, with the related files. Do not record things that are only
true for this task.

## Local secrets
The user can give a project secrets saved on their machine. When the prompt has a "Bí mật tại máy" section, the
variables it lists are already in your environment.
- Use them by name only (`$DB_PASSWORD`, `process.env.DB_PASSWORD`, `os.Getenv("DB_PASSWORD")`). Never print, echo or
  log a value, and never write one into a file (code, `.env`, config, test fixtures), a commit message, the report or
  memory. Use placeholders in examples and `.env.example`.
- Do not ask the user to paste a value that is listed. If you need a credential that is not listed, stop and say which
  variable name you need and what for: the user adds it on the desktop app's Secrets screen (or imports a `.env` or
  `.hivesecrets` file) and assigns it to the project. Do not search the machine for it (other repos' `.env`,
  `~/.aws`, key stores, shell history).
- If the section says no secret was granted, the organisation or the user refused: stop and report instead of working
  around it.
- Do not run `hive-worker secrets` commands (list, export, import, assign, reveal). Managing secrets is the user's job.
- Output is masked as `[đã che]` in logs, but the model has already seen what a command printed. Masking is a safety
  net, not permission to print.

## Review runs
You only read. Use the diff file the worker wrote (`.hive-review.diff`) and the files it touches, check the change
against the task, then submit with `review_submit`: score, one-line verdict, concrete findings with file and line.
