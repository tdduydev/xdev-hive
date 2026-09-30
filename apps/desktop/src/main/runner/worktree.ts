// One git worktree + branch per task (ai/<task-id>), so agents never share a working copy.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { HiveError, RULES_DIR } from "@xdev-hive/core";
import { git, gitAsync, gitErrorText, isGitRepo } from "../git.ts";
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

export const hasBranch = (repo: string, branch: string) => tryGit(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]) !== null;

/**
 * Where a new task branch starts: the target branch as the remote has it now (`targetBranch`, else the remote's
 * default), so a task queued right after the one it depends on was merged on GitHub or GitLab gets that code.
 * Only fetches: the user's checkout (its branch, its files) stays as it is. No remote, or a fetch that fails:
 * `ref` is null and the branch starts at the checkout's HEAD, as before. `note` goes to the run's log either way.
 */
export async function remoteStart(repo: string, target: string | undefined, timeoutMs = 30_000): Promise<{ ref: string | null; note: string }> {
  const head = tryGit(repo, ["rev-parse", "--short", "HEAD"]) ?? "?";
  const remotes = (tryGit(repo, ["remote"]) ?? "").split("\n").filter(Boolean);
  if (!remotes.length) return { ref: null, note: tr("runNote.startNoRemote", { sha: head }) };
  const remote = remotes.includes("origin") ? "origin" : remotes[0]!;
  // Never wait on a password prompt: the app has no terminal to show it in.
  const env = { GIT_TERMINAL_PROMPT: "0" };
  try {
    let branch = target;
    if (!branch) {
      // The clone's record of the remote's default branch, else the remote itself.
      const known = tryGit(repo, ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`]);
      branch = known?.startsWith(`${remote}/`)
        ? known.slice(remote.length + 1)
        : (await gitAsync(repo, ["ls-remote", "--symref", remote, "HEAD"], env, timeoutMs)).match(/^ref: refs\/heads\/(\S+)\s+HEAD$/m)?.[1];
      if (!branch) throw new Error(`${remote} names no default branch`);
    }
    const ref = `refs/remotes/${remote}/${branch}`;
    await gitAsync(repo, ["fetch", "--quiet", "--no-tags", remote, `+refs/heads/${branch}:${ref}`], env, timeoutMs);
    return { ref, note: tr("runNote.startRemote", { ref: `${remote}/${branch}`, sha: git(repo, ["rev-parse", "--short", `${ref}^{commit}`]) }) };
  } catch (err) {
    return { ref: null, note: tr("runNote.startFetchFailed", { remote, reason: gitErrorText(err), sha: head }) };
  }
}

/**
 * `opts.branch` + `opts.from`: a best-of-n candidate's branch, (re)started at `from` whenever its worktree is
 * created, so a new group never builds on an older group's candidate.
 * `opts.start`: where the task's branch starts if it does not exist yet (see remoteStart); default the checkout's HEAD.
 * An existing branch keeps its own history and base.
 */
export function ensureWorktree(
  repo: string,
  dir: string,
  taskId: string,
  knownBase: string | null,
  opts: { branch?: string; from?: string; start?: string } = {},
): Worktree {
  if (!isGitRepo(repo)) throw new HiveError("bad_request", `${repo} không phải git repo`, { key: "errors.notGitRepo", vars: { path: repo } });
  const branch = opts.branch ?? branchFor(taskId);
  git(repo, ["worktree", "prune"]);
  const registered = git(repo, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .some((l) => real(l.slice(9)) === real(dir));

  let created = false;
  let started: string | null = null;
  if (!registered) {
    if (existsSync(dir)) throw new HiveError("conflict", `${dir} đã tồn tại nhưng không phải worktree của repo này`, { key: "errors.worktreeTaken", vars: { path: dir } });
    mkdirSync(path.dirname(dir), { recursive: true });
    const branchExists = hasBranch(repo, branch);
    if (!opts.from && !branchExists) started = opts.start ?? "HEAD";
    try {
      git(
        repo,
        opts.from
          ? ["worktree", "add", "-B", branch, dir, opts.from]
          : branchExists
            ? ["worktree", "add", dir, branch]
            : ["worktree", "add", "-b", branch, dir, started!],
      );
    } catch (err) {
      const reason = gitErrorText(err);
      throw new HiveError("bad_request", `Không tạo được worktree: ${reason}`, { key: "errors.worktreeCreate", vars: { reason } });
    }
    created = true;
  }

  // A new branch's base is where it started, whatever an earlier run of the task (whose branch is gone) recorded:
  // the checkout's HEAD may be behind the remote it came from.
  const baseSha = started ? git(repo, ["rev-parse", `${started}^{commit}`]) : (knownBase ?? git(repo, ["merge-base", "HEAD", branch]));
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

/** A patch is cut at about this size (the hub keeps what the web shows). */
export const PATCH_MAX = 380_000;

/**
 * What a run changed as a unified diff (roadmap 22l): from its base to the worktree as it is now (commits, edits not
 * committed yet, and new files), or to a branch (a kept candidate). "" when nothing changed or it is gone.
 */
export function branchPatch(dir: string, baseSha: string, ref = "HEAD"): string {
  if (!existsSync(dir)) return "";
  const args = ["-c", "core.quotepath=off", "diff", "--no-color", "--no-ext-diff", "--find-renames"];
  let out = ref === "HEAD" ? (tryGit(dir, [...args, baseSha]) ?? "") : (tryGit(dir, [...args, `${baseSha}...${ref}`]) ?? "");
  if (ref === "HEAD") {
    // New files the agent has not added yet: git diff leaves them out.
    const untracked = (tryGit(dir, ["ls-files", "--others", "--exclude-standard"]) ?? "").split("\n").filter(Boolean).slice(0, 30);
    for (const f of untracked) {
      if (out.length > PATCH_MAX) break;
      try {
        execFileSync("git", [...args, "--no-index", "--", "/dev/null", f], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 8 * 1024 * 1024 });
      } catch (err) {
        // --no-index exits 1 when the files differ, which a new file always does.
        const text = (err as { stdout?: string }).stdout ?? "";
        if (text) out += `${out && !out.endsWith("\n") ? "\n" : ""}${text.trimEnd()}`;
      }
    }
  }
  if (out.length <= PATCH_MAX) return out;
  const cut = out.lastIndexOf("\n", PATCH_MAX);
  return `${out.slice(0, cut > 0 ? cut : PATCH_MAX)}\n${tr("runNote.patchClipped")}`;
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
