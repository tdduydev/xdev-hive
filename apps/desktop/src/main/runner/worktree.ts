// One git worktree + branch per task (ai/<task-id>), so agents never share a working copy.
import { copyFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { HiveError } from "@xdev-hive/core";
import { git, gitErrorText, isGitRepo } from "../git.ts";

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

export function ensureWorktree(repo: string, dir: string, taskId: string, knownBase: string | null): Worktree {
  if (!isGitRepo(repo)) throw new HiveError("bad_request", `${repo} không phải git repo`);
  const branch = branchFor(taskId);
  git(repo, ["worktree", "prune"]);
  const registered = git(repo, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .some((l) => real(l.slice(9)) === real(dir));

  let created = false;
  if (!registered) {
    if (existsSync(dir)) throw new HiveError("conflict", `${dir} đã tồn tại nhưng không phải worktree của repo này`);
    mkdirSync(path.dirname(dir), { recursive: true });
    const branchExists = tryGit(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]) !== null;
    try {
      git(repo, branchExists ? ["worktree", "add", dir, branch] : ["worktree", "add", "-b", branch, dir, "HEAD"]);
    } catch (err) {
      throw new HiveError("bad_request", `Không tạo được worktree: ${gitErrorText(err)}`);
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

/** Commits whatever the agent left uncommitted. The repo's own hooks still run. */
export function commitAll(dir: string, message: string, exclude: string[]): { sha: string | null; error: string | null } {
  try {
    if (!git(dir, ["status", "--porcelain"])) return { sha: null, error: null };
    git(dir, ["add", "-A", "--", ".", ...exclude.map((f) => `:(exclude)${f}`)]);
    if (!git(dir, ["diff", "--cached", "--name-only"])) return { sha: null, error: null };
    git(dir, ["commit", "-m", message]);
    return { sha: git(dir, ["rev-parse", "--short", "HEAD"]), error: null };
  } catch (err) {
    return { sha: null, error: gitErrorText(err) };
  }
}

export function branchState(dir: string, baseSha: string): { commits: number; headSha: string | null } {
  const count = tryGit(dir, ["rev-list", "--count", `${baseSha}..HEAD`]);
  return { commits: count ? Number(count) : 0, headSha: tryGit(dir, ["rev-parse", "--short", "HEAD"]) };
}

export function describeBranch(dir: string, baseSha: string): string {
  if (!existsSync(dir)) return "Worktree đã bị xoá.";
  const log = tryGit(dir, ["log", "--oneline", "--no-decorate", `${baseSha}..HEAD`]) || "(chưa có commit)";
  const stat = tryGit(dir, ["diff", "--stat", `${baseSha}...HEAD`]) || "(không có thay đổi)";
  const dirty = tryGit(dir, ["status", "--short"]);
  return [`Commits:\n${log}`, `Thay đổi so với base:\n${stat}`, dirty ? `Chưa commit:\n${dirty}` : ""].filter(Boolean).join("\n\n");
}

export function removeWorktree(repo: string, dir: string): void {
  try {
    git(repo, ["worktree", "remove", dir]);
  } catch (err) {
    throw new HiveError("bad_request", `Không xoá được worktree: ${gitErrorText(err)}`);
  }
}
