// One git worktree + branch per task (ai/<task-id>), so agents never share a working copy.
import { copyFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { HiveError, RULES_DIR } from "@xdev-hive/core";
import { git, gitErrorText, isGitRepo } from "../git.ts";
import { tr } from "../i18n.ts";
import { RENDERED_FILES } from "../installer.ts";

/** Agent config that may exist in the repo but not be committed yet; copied into new worktrees. */
export const AGENT_CONFIG_FILES = [".mcp.json", ".gemini/settings.json", ".claude/settings.json", ".xdev-hive/guard-docs.sh"];

export interface Worktree {
  path: string;
  branch: string;
  baseSha: string;
  created: boolean;
  /** Untracked agent config in the worktree; excluded from the runner's auto-commit. */
  copied: string[];
}

export const branchFor = (taskId: string) => `ai/${taskId}`;
/** A best-of-n candidate's branch and folder name: "+" never appears in a task id, so it cannot collide with one. */
export const candidateName = (taskId: string, n: number) => `${taskId}+c${n}`;

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

function tryGit(repo: string, args: string[]): string | null {
  try {
    return git(repo, args);
  } catch {
    return null;
  }
}

/**
 * `opts.branch` + `opts.from`: a best-of-n candidate's branch, (re)started at `from` whenever its worktree is
 * created, so a new group never builds on an older group's candidate.
 */
export function ensureWorktree(
  repo: string,
  dir: string,
  taskId: string,
  knownBase: string | null,
  opts: { branch?: string; from?: string } = {},
): Worktree {
  if (!isGitRepo(repo)) throw new HiveError("bad_request", `${repo} không phải git repo`, { key: "errors.notGitRepo", vars: { path: repo } });
  const branch = opts.branch ?? branchFor(taskId);
  git(repo, ["worktree", "prune"]);
  const registered = git(repo, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .some((l) => real(l.slice(9)) === real(dir));

  let created = false;
  if (!registered) {
    if (existsSync(dir)) throw new HiveError("conflict", `${dir} đã tồn tại nhưng không phải worktree của repo này`, { key: "errors.worktreeTaken", vars: { path: dir } });
    mkdirSync(path.dirname(dir), { recursive: true });
    const branchExists = tryGit(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]) !== null;
    try {
      git(
        repo,
        opts.from
          ? ["worktree", "add", "-B", branch, dir, opts.from]
          : branchExists
            ? ["worktree", "add", dir, branch]
            : ["worktree", "add", "-b", branch, dir, "HEAD"],
      );
    } catch (err) {
      const reason = gitErrorText(err);
      throw new HiveError("bad_request", `Không tạo được worktree: ${reason}`, { key: "errors.worktreeCreate", vars: { reason } });
    }
    created = true;
  }

  const baseSha = knownBase ?? git(repo, ["merge-base", "HEAD", branch]);
  for (const file of AGENT_CONFIG_FILES) {
    const from = path.join(repo, file);
    const to = path.join(dir, file);
    if (existsSync(from) && !existsSync(to)) {
      mkdirSync(path.dirname(to), { recursive: true });
      copyFileSync(from, to);
    }
  }
  // Untracked config (copied now or on an earlier attempt) must never land in the task branch.
  const copied = AGENT_CONFIG_FILES.filter((f) => existsSync(path.join(dir, f)) && !tryGit(dir, ["ls-files", "--", f]));
  return { path: dir, branch, baseSha, created, copied };
}

/**
 * Config that agent CLIs write into a working copy on their own, not the agent's work. Codex 0.157 can copy a repo's
 * Claude Code setup there (`.mcp.json` → `.codex/config.toml`, hooks → `.codex/hooks.json`, skills →
 * `.agents/skills/`) when its external agent import sync is on; that setting cannot be turned off for one run.
 */
export const AGENT_CLI_DIRS = [".codex", ".agents"];

/**
 * Commits whatever the agent left uncommitted. No git hook runs: the agent could have written one into
 * the working copy (.githooks), and the app is not sandboxed. Docs rendered from Hive stay out, as the
 * pre-commit guard would have kept them; they show up as uncommitted in the run's summary. So do the agent CLIs'
 * folders (AGENT_CLI_DIRS), unless the branch already tracks something in one: then the project keeps it on purpose.
 */
export function commitAll(dir: string, message: string, exclude: string[]): { sha: string | null; error: string | null } {
  try {
    if (!git(dir, ["status", "--porcelain"])) return { sha: null, error: null };
    // Nested AGENTS.md and skills with Hive's block, as the branch had them (the agent may have taken the block out).
    const nested = (
      tryGit(dir, ["grep", "-l", "--fixed-strings", "xdev-hive:start", "HEAD", "--", ":(glob)**/AGENTS.md", ":(glob).claude/skills/*/SKILL.md"]) ?? ""
    )
      .split("\n")
      .map((l) => l.replace(/^HEAD:/, ""))
      .filter((f) => f && f !== "AGENTS.md");
    const cliDirs = AGENT_CLI_DIRS.filter((d) => !tryGit(dir, ["ls-tree", "-r", "--name-only", "HEAD", "--", d]));
    const keepOut = [...exclude, ...RENDERED_FILES, RULES_DIR, ...nested, ...cliDirs];
    git(dir, ["add", "-A", "--", ".", ...keepOut.map((f) => `:(exclude)${f}`)]);
    if (!git(dir, ["diff", "--cached", "--name-only"])) return { sha: null, error: null };
    git(dir, ["-c", `core.hooksPath=${os.devNull}`, "commit", "-m", message]);
    return { sha: git(dir, ["rev-parse", "--short", "HEAD"]), error: null };
  } catch (err) {
    return { sha: null, error: gitErrorText(err) };
  }
}

/**
 * Checks out `branch` at `ref` (the kept candidate) in a worktree, dropping what the working copy held: the judge
 * may have left changes or another checkout behind. Ignored files (dependencies, builds) stay.
 */
export function resetTo(dir: string, branch: string, ref: string): void {
  try {
    git(dir, ["checkout", "-q", "-f", "-B", branch, ref]);
    git(dir, ["clean", "-q", "-fd"]);
  } catch (err) {
    const reason = gitErrorText(err);
    throw new HiveError("bad_request", `Không chuyển được branch sang bản đã chọn: ${reason}`, { key: "errors.pickReset", vars: { reason } });
  }
}

export function branchState(dir: string, baseSha: string): { commits: number; headSha: string | null } {
  const count = tryGit(dir, ["rev-list", "--count", `${baseSha}..HEAD`]);
  return { commits: count ? Number(count) : 0, headSha: tryGit(dir, ["rev-parse", "--short", "HEAD"]) };
}

/** `ref`: another branch than the one checked out (a candidate whose worktree is gone), with no working copy to show. */
export function describeBranch(dir: string, baseSha: string, ref = "HEAD"): string {
  if (!existsSync(dir)) return tr("runNote.worktreeGone");
  const log = tryGit(dir, ["log", "--oneline", "--no-decorate", `${baseSha}..${ref}`]) || tr("runNote.noCommits");
  const stat = tryGit(dir, ["diff", "--stat", `${baseSha}...${ref}`]) || tr("runNote.noChanges");
  const dirty = ref === "HEAD" ? tryGit(dir, ["status", "--short"]) : null;
  return [`Commits:\n${log}`, `${tr("runNote.changesFromBase")}\n${stat}`, dirty ? `${tr("runNote.uncommitted")}\n${dirty}` : ""].filter(Boolean).join("\n\n");
}

/** `force`: also with untracked files (a candidate's: everything it made is committed on its branch). */
export function removeWorktree(repo: string, dir: string, force = false): void {
  try {
    git(repo, ["worktree", "remove", ...(force ? ["--force"] : []), dir]);
  } catch (err) {
    const reason = gitErrorText(err);
    throw new HiveError("bad_request", `Không xoá được worktree: ${reason}`, { key: "errors.worktreeRemove", vars: { reason } });
  }
}
