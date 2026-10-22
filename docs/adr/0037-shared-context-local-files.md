# 0037. Share project context through one source written into local, untracked files

- Status: Proposed
- Date: 2026-10-22
- Deciders: Project owner

## Context

Spec [029](../../specs/029-shared-context-sync/spec.md) gives a developer one context per project for every coding CLI on
the machine. Today the instruction files of Claude Code, Codex, Gemini and Antigravity are separate, and the memory
sharing of spec [015](../../specs/015-client-token-optimizer/spec.md) only links Claude profiles.

Two earlier rules get in the way:

- Spec [025](../../specs/025-token-score/spec.md) FR-012 forbids any one-click fix that edits `CLAUDE.md`, `AGENTS.md`
  or memory. A "Tối ưu" button that also updates context cannot exist under that rule.
- Writing into files the repository tracks would dirty the working tree and push one machine's context to the whole
  team.

On 2026-10-22 the project owner decided D1, D4 and D5 of spec 029 (the table in the spec). The research
([research.md](../../specs/029-shared-context-sync/research.md) sections 1 and 2) found that no CLI has an untracked
context file in the same shape, and that Codex reads exactly one file per directory.

## Decision

1. **One source per project.** The app keeps one source of context per project outside the repository, in
   `~/.xdev-hive/context/<key>/`. The key is the hub project id when the folder is bound to a hub project, otherwise the
   folder key from `memstore.ProjectKey`.
2. **Local, untracked target files.** The worker writes the source into a file each CLI reads on its own, and that git
   does not track:

   | CLI | Target file |
   |---|---|
   | Claude Code | `CLAUDE.local.md` |
   | Codex | `AGENTS.override.md` (mirror, see 5) |
   | Gemini CLI | `GEMINI.local.md`, added to `context.fileName` in `.gemini/settings.json` |
   | Antigravity | `.agents/rules/xdev-hive.md`, with frontmatter `trigger: always_on` |

   Before writing, the worker adds the target to `.git/info/exclude` and never writes a file that git tracks. It
   writes only for CLIs installed on the machine.
3. **Marked block.** The content sits in one block between `<!-- xdev-hive:context v1 sha=<12 hex> -->` and
   `<!-- /xdev-hive:context -->`, with the sections "Tại máy" (the source) and "Từ hub" (approved hub memories).
   Nothing outside the block is edited, removed or reordered (spec 029 SC-002). The `sha` in the opening line is the
   hash of what the app last wrote, so a hand edit inside the block is detected even when local state is lost. A
   changed block is reported as a conflict and never overwritten.
4. **Every write is backed up.** Writes go through the backup, trash and restore store of `memstore`, so the whole
   optimize run can be undone byte for byte.
5. **Codex mirror.** `AGENTS.override.md` replaces `AGENTS.md` in the same directory instead of adding to it. The file
   the app writes is therefore the repository `AGENTS.md` followed by the block. The worker stores the hash of
   `AGENTS.md` and rebuilds the mirror when it changes. An `AGENTS.override.md` the user wrote, with no mark of the
   app, makes the app skip Codex and say why.
6. **Replaces 025 FR-012.** A one-click action may write `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, rules and memory, but
   only inside the block marked by xDev Hive. Still forbidden: turning off MCP servers, deleting skills, writing
   outside the block, and AI compaction (which stays a per-file review on the Memory screen). The hub project policy
   cannot skip the confirmation of the `aggressive` level.

## Consequences

- Good: one place to edit context for every CLI on the machine; the repository stays clean and no machine context
  reaches the team through git.
- Good: the block is the only region the app owns, so "do not touch user text" is testable by comparing bytes.
- Good: the "Tối ưu" button can include context in one reviewable, undoable run.
- Bad: Codex gets a mirror file that goes stale when `AGENTS.md` changes between two syncs; the app marks it stale and
  rebuilds it on the next sync.
- Bad: the marker costs a few dozen bytes for CLIs that do not strip HTML comments.
- Bad: Antigravity and Gemini read paths are taken from their documentation, not yet checked on a machine. A CLI that
  fails the manual check is listed as "not supported" (plan, risks).
- Bad: 025 FR-012 now has an exception, so reviewers must check that "Tối ưu" steps call only `ctxsync` for context
  files.

## Alternatives considered

- Symlink one shared file into each CLI: Claude asks permission for each write through a symlink, and Windows needs
  extra rights.
- `@~/.xdev-hive/...` imports from a tracked file: edits a tracked file, against the decision on local files.
- Write the block into tracked files (`CLAUDE.md`, `AGENTS.md`): dirties the repository and shares one machine's
  context with the team.
- Global files (`~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`): not per project, so several projects overwrite each
  other.
- Keep 025 FR-012 as it was: the button could not update context at all.

## Links

- Spec 029 D1, D4, D5, FR-001 to FR-006, FR-014; [plan](../../specs/029-shared-context-sync/plan.md) section 1 and
  decision W3; [research](../../specs/029-shared-context-sync/research.md) sections 1 and 2.
- Spec 025 FR-012 (amended). Spec 015 memory sharing (replaced by the shared source, with a migration offer).
- [ADR 0026](0026-client-token-optimizer.md).
