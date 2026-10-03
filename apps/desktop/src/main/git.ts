import { execFile, execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

export function git(repo: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Async variant for network operations (push), so the main process never blocks on the network. */
export function gitAsync(repo: string, args: string[], env: Record<string, string> = {}, timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd: repo, encoding: "utf8", env: { ...process.env, ...env }, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(Object.assign(err, { stderr }));
        else resolve(`${stdout}${stderr}`.trim());
      },
    );
  });
}

export function isGitRepo(repo: string): boolean {
  try {
    return git(repo, ["rev-parse", "--is-inside-work-tree"]) === "true";
  } catch {
    return false;
  }
}

/** A folder is a repository when it has `.git`: a folder, or the file a worktree or submodule has instead. */
export const isRepoRoot = (dir: string): boolean => existsSync(path.join(dir, ".git"));

/** Folders a scan never looks inside, on top of hidden ones (`.git`, `.venv`): dependencies, never repositories of ours. */
const SKIP_DIRS = new Set(["node_modules"]);

/**
 * The git repositories in `root` (roadmap 38d): the folder itself when it is one, else those below it, at most
 * `maxDepth` levels down (`<root>/app/backend/billing` is three). Dependencies, hidden folders and anything inside
 * a repository already found are left out, so a repository with submodules counts once. Reads the folder tree only —
 * no `git` process per folder, since a folder someone keeps every project in holds thousands.
 */
export function findGitRepos(root: string, maxDepth = 3): string[] {
  if (isRepoRoot(root)) return [root];
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // A folder this user may not read (or one that went away mid-scan) stops that branch, not the scan.
      return;
    }
    // isDirectory() is false for a symlink, so a link back up the tree cannot loop the scan.
    for (const entry of entries.filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name)).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.join(dir, entry.name);
      if (isRepoRoot(child)) found.push(child);
      else if (depth < maxDepth) walk(child, depth + 1);
    }
  };
  walk(root, 1);
  return found;
}

/**
 * The branch a repository's remote points at (`origin/HEAD`), for a project's targetBranch. A repository cloned
 * by hand or with `git remote add` has no such ref, so this is null and the caller falls back to its own default.
 */
export function defaultBranch(repo: string): string | null {
  try {
    const ref = git(repo, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
    return ref.replace(/^refs\/remotes\/origin\//, "") || null;
  } catch {
    return null;
  }
}

export function gitErrorText(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return (e.stderr || e.message || String(err)).trim().split("\n").slice(-3).join(" ");
}
