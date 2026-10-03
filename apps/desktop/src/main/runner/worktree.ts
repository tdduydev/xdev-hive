// One git worktree + branch per task (ai/<task-id>), so agents never share a working copy.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONTEXT_DIR, HiveError, MANAGED_START, RULES_DIR } from "@xdev-hive/core";
import { git, gitAsync, gitErrorText, isGitRepo } from "#desktop/main/git.ts";
import { tr } from "#desktop/main/i18n.ts";
import { RENDERED_FILES } from "#desktop/main/installer.ts";

/** Agent config that may exist in the repo but not be committed yet; copied into new worktrees. */
export const AGENT_CONFIG_FILES = [".mcp.json", ".gemini/settings.json", ".claude/settings.json", ".xdev-hive/guard-docs.sh"];

export interface Worktree {
  path: string;
  branch: string;
  baseSha: string;
  created: boolean;
  /** Untracked agent config in the worktree; excluded from the runner's auto-commit. */
  copied: string[];
  /** Folders the run's tools prepare in it (roadmap 28b, see toolDirs): kept out of the commit like AGENT_CLI_DIRS. */
  toolDirs?: string[];
  /** Context the runner rendered from Hive into it (roadmap 38a): not the agent's work, so not in the commit. */
  context?: string[];
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

/** `dir` is one of the repo's worktrees (call `git worktree prune` first, or a deleted folder still counts). */
const isWorktreeOf = (repo: string, dir: string) =>
  git(repo, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .some((l) => real(l.slice(9)) === real(dir));

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
  const registered = isWorktreeOf(repo, dir);

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
 * `codegraph init` writes `.codegraph/.gitignore` beside the index the runner builds in each worktree.
 */
export const AGENT_CLI_DIRS = [".codex", ".agents", ".codegraph"];

/**
 * What the app renders from Hive in a working copy, by the same rule as the pre-commit guard: the fixed files, our
 * rules and context folders, and a nested AGENTS.md or skill that carries the managed block. Never the agent's work,
 * so it stays out of commits, out of the run's diff and out of what counts as dirty. Read from the working copy,
 * because a run's worktree gets files the branch does not have (roadmap 38a).
 */
export function renderedPaths(dir: string): string[] {
  const out = [...RENDERED_FILES, RULES_DIR, CONTEXT_DIR];
  const listed = (tryGit(dir, ["ls-files", "-co", "--exclude-standard", "--", ":(glob)**/AGENTS.md", ":(glob).claude/skills/*/SKILL.md"]) ?? "")
    .split("\n")
    .filter((f) => f && !RENDERED_FILES.includes(f));
  for (const f of listed) {
    try {
      if (readFileSync(path.join(dir, f), "utf8").includes(MANAGED_START)) out.push(f);
    } catch {
      // listed but gone (or not a file): nothing to keep out
    }
  }
  return out;
}

const exclude = (paths: string[]) => [".", ...paths.map((f) => `:(exclude)${f}`)];
const under = (paths: string[], f: string) => paths.some((p) => f === p || f.startsWith(`${p}/`));

/**
 * Commits whatever the agent left uncommitted. No git hook runs: the agent could have written one into
 * the working copy (.githooks), and the app is not sandboxed. Docs rendered from Hive stay out, as the
 * pre-commit guard would have kept them; they show up as uncommitted in the run's summary. So do the agent CLIs'
 * folders (AGENT_CLI_DIRS), unless the branch already tracks something in one: then the project keeps it on purpose.
 */
export function commitAll(dir: string, message: string, exclude: string[], toolDirs: string[] = []): { sha: string | null; error: string | null } {
  try {
    if (!git(dir, ["status", "--porcelain"])) return { sha: null, error: null };
    // Nested AGENTS.md and skills with Hive's block, as the branch had them (the agent may have taken the block out).
    const nested = (
      tryGit(dir, ["grep", "-l", "--fixed-strings", "xdev-hive:start", "HEAD", "--", ":(glob)**/AGENTS.md", ":(glob).claude/skills/*/SKILL.md"]) ?? ""
    )
      .split("\n")
      .map((l) => l.replace(/^HEAD:/, ""))
      .filter((f) => f && f !== "AGENTS.md");
    const cliDirs = [...new Set([...AGENT_CLI_DIRS, ...toolDirs])].filter((d) => !tryGit(dir, ["ls-tree", "-r", "--name-only", "HEAD", "--", d]));
    // Already ignored by the repo: `add` leaves it out anyway, and git 2.54 fails the whole add ("paths are ignored, use
    // -f") when an exclude names one, so nothing would be committed (.codegraph/ in xdev-mindmap-ai, 2/10).
    const keepOut = [...exclude, ...RENDERED_FILES, RULES_DIR, ...nested, ...cliDirs].filter((f) => tryGit(dir, ["check-ignore", "-q", "--", f]) === null);
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

/**
 * `ref`: another branch than the one checked out (a candidate whose worktree is gone), with no working copy to show.
 * `extra`: more paths to leave out of *uncommitted* (a run's `wt.context` and `wt.copied`), on top of renderedPaths.
 */
export function describeBranch(dir: string, baseSha: string, ref = "HEAD", extra: string[] = []): string {
  if (!existsSync(dir)) return tr("runNote.worktreeGone");
  const log = tryGit(dir, ["log", "--oneline", "--no-decorate", `${baseSha}..${ref}`]) || tr("runNote.noCommits");
  const stat = tryGit(dir, ["diff", "--stat", `${baseSha}...${ref}`]) || tr("runNote.noChanges");
  // The context the app renders is not the agent's work: it never goes in the branch, so it is not "uncommitted".
  const dirty = ref === "HEAD" ? tryGit(dir, ["status", "--short", "--", ...exclude([...renderedPaths(dir), ...extra])]) : null;
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
  // Hive's own context would otherwise fill the diff of every run on a repo whose branch has an older copy of it.
  const hidden = renderedPaths(dir);
  const paths = ["--", ...exclude(hidden)];
  let out = ref === "HEAD" ? (tryGit(dir, [...args, baseSha, ...paths]) ?? "") : (tryGit(dir, [...args, `${baseSha}...${ref}`, ...paths]) ?? "");
  if (ref === "HEAD") {
    // New files the agent has not added yet: git diff leaves them out.
    const untracked = (tryGit(dir, ["ls-files", "--others", "--exclude-standard"]) ?? "").split("\n").filter((f) => f && !under(hidden, f)).slice(0, 30);
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

/** Why the work of a merged MR stayed on the machine (roadmap 21b). */
export type CleanupKept = "noSha" | "newer" | "dirty" | "active" | "failed";

export interface MergedCleanup {
  /** The task's worktree was removed. */
  worktree: boolean;
  /** Its local branch was deleted. */
  branch: boolean;
  /** Why something was kept; null when all of it went (or there was nothing to remove). */
  kept: CleanupKept | null;
  /** Git's own words when `kept` is "failed". */
  reason: string | null;
}

/**
 * After its MR was merged: removes a task's worktree and deletes its local branch, but only when both point at the
 * commit that was merged (`mergedSha`, the MR's head). A newer commit (pushed after, or a run that went on) or edits
 * not committed yet are work the merge does not hold, so then everything stays. Agent config the runner copied in
 * and the docs Hive renders do not count as edits: commitAll keeps them out of the branch too.
 */
export function cleanupMerged(repo: string, dir: string | null, branch: string, mergedSha: string | null): MergedCleanup {
  const kept = (why: CleanupKept, reason: string | null = null): MergedCleanup => ({ worktree: false, branch: false, kept: why, reason });
  const sha = mergedSha?.toLowerCase() ?? null;
  try {
    git(repo, ["worktree", "prune"]);
    const head = tryGit(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]);
    const wt = dir && existsSync(dir) && isWorktreeOf(repo, dir) ? dir : null;
    if (!head && !wt) return { worktree: false, branch: false, kept: null, reason: null };
    // Without the merged commit there is no telling whether the branch holds more: never guess on someone's work.
    if (!sha) return kept("noSha");
    if (head && head !== sha) return kept("newer");
    if (wt) {
      if (tryGit(wt, ["rev-parse", "HEAD"]) !== sha) return kept("newer");
      const keepOut = [...AGENT_CONFIG_FILES, ...renderedPaths(wt), ...AGENT_CLI_DIRS];
      if (git(wt, ["status", "--porcelain", "--", ...exclude(keepOut)])) return kept("dirty");
      // Forced only for what the check above left out (copied config, ignored dependencies and builds).
      git(repo, ["worktree", "remove", "--force", wt]);
    }
    if (head) {
      try {
        // -D: a squash or rebase merge leaves the branch out of the target's history, though its work is in.
        git(repo, ["branch", "-D", branch]);
      } catch (err) {
        // Checked out in another working copy (the user's own, say): the worktree is gone, the branch stays.
        return { worktree: wt !== null, branch: false, kept: "failed", reason: gitErrorText(err) };
      }
    }
    return { worktree: wt !== null, branch: head !== null, kept: null, reason: null };
  } catch (err) {
    return kept("failed", gitErrorText(err));
  }
}
