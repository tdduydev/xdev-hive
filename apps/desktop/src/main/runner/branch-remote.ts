import { redactLines, stripHidden } from "@xdev-hive/core";
import { git, gitAsync, gitErrorText } from "#desktop/main/git.ts";
import { renameSync, existsSync } from "node:fs";
import path from "node:path";

const env = { GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes -o ConnectTimeout=15" };
export function assertTaskBranch(branch: string): void {
  if (!/^ai\/[A-Za-z0-9._+/-]+$/.test(branch) || branch.includes("..")) throw new Error("Only ai/* task branches can be synchronized.");
  gitBranchCheck(branch);
}
function gitBranchCheck(branch: string): void {
  // Git's stricter ref rules also exclude reflog expressions and malformed path components.
  git(process.cwd(), ["check-ref-format", `refs/heads/${branch}`]);
}

/** No missing-ref recovery on a network/auth error: that must never authorize overwriting a remote branch. */
export async function fetchTaskBranch(repo: string, branch: string, remote = "origin"): Promise<{ sha: string | null; ref: string | null }> {
  assertTaskBranch(branch);
  const ref = `refs/remotes/${remote}/${branch}`;
  const result = await gitAsync(repo, ["ls-remote", "--refs", remote, `refs/heads/${branch}`], env, 30_000);
  const exists = result.split("\n").some(line => {
    const [sha, ref] = line.trim().split(/\s+/);
    return !!sha && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha) && ref === `refs/heads/${branch}`;
  });
  // gitAsync also includes stderr: a redirect/SSH warning alone does not mean the ref exists.
  if (!exists) return { sha: null, ref: null };
  await gitAsync(repo, ["fetch", "--quiet", "--no-tags", remote, `+refs/heads/${branch}:${ref}`], env, 30_000);
  return { ref, sha: git(repo, ["rev-parse", `${ref}^{commit}`]) };
}

/** Preserve local untracked files that a fetched fast-forward would replace. */
export function prepareTaskBranchMerge(worktree: string, ref: string): string[] {
  // A divergent branch must fail without moving any local files.
  git(worktree, ["merge-base", "--is-ancestor", "HEAD", ref]);
  const incoming = git(worktree, ["ls-tree", "-r", "--name-only", "-z", ref]).split("\0").filter(Boolean);
  const tracked = new Set(git(worktree, ["ls-files", "-z"]).split("\0").filter(Boolean));
  const moved: string[] = [];
  for (const file of incoming) {
    if (tracked.has(file) || !existsSync(path.join(worktree, file))) continue;
    const targetBlob = git(worktree, ["rev-parse", `${ref}:${file}`]);
    const localBlob = git(worktree, ["hash-object", "--", file]);
    if (localBlob === targetBlob) {
      // Staging matching bytes lets Git adopt the file in the fast-forward.
      git(worktree, ["add", "-f", "--", file]);
      continue;
    }
    const source = path.join(worktree, file);
    const stamp = Date.now();
    let backup = `${source}.pre-merge-${stamp}`;
    for (let n = 1; existsSync(backup); n++) backup = `${source}.pre-merge-${stamp}-${n}`;
    renameSync(source, backup);
    moved.push(path.relative(worktree, backup));
  }
  return moved;
}

export async function pushTaskBranch(repo: string, branch: string, headSha: string, expectedSha: string | null, remote = "origin"): Promise<{ pushed: boolean; pushError: string | null }> {
  try {
    assertTaskBranch(branch);
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(headSha) || (expectedSha !== null && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(expectedSha))) throw new Error("Invalid branch SHA.");
    // Push the recorded revision, even if another local run advances the branch during this upload.
    await gitAsync(repo, ["push", `--force-with-lease=refs/heads/${branch}:${expectedSha ?? ""}`, remote, `${headSha}:refs/heads/${branch}`], env, 30_000);
    return { pushed: true, pushError: null };
  } catch (err) {
    return { pushed: false, pushError: redactLines(stripHidden(gitErrorText(err))).slice(0, 4000) };
  }
}
