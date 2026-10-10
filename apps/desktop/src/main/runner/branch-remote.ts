import { redactLines, stripHidden } from "@xdev-hive/core";
import { git, gitAsync, gitErrorText } from "#desktop/main/git.ts";
import { execFileSync } from "node:child_process";
import { lstatSync, readlinkSync, renameSync } from "node:fs";
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
  const incoming = git(worktree, ["ls-tree", "-r", "-z", ref]).split("\0").filter(Boolean);
  const tracked = new Set(git(worktree, ["ls-files", "-z"]).split("\0").filter(Boolean));
  const moved: string[] = [];
  const preserve = (source: string): void => {
    const stamp = Date.now();
    let backup = `${source}.pre-merge-${stamp}`;
    for (let n = 1; lstatSync(backup, { throwIfNoEntry: false }); n++) backup = `${source}.pre-merge-${stamp}-${n}`;
    renameSync(source, backup);
    moved.push(path.relative(worktree, backup));
  };
  for (const entry of incoming) {
    const match = /^(\d{6}) (?:blob|commit) ([a-f0-9]+)\t(.*)$/s.exec(entry);
    if (!match) throw new Error(`Unexpected git ls-tree entry: ${entry}`);
    const mode = match[1]!;
    const hash = match[2]!;
    const file = match[3]!;
    if (tracked.has(file)) continue;
    const parts = file.split("/");
    let parent = "";
    let blocked = false;
    for (const part of parts.slice(0, -1)) {
      parent = parent ? `${parent}/${part}` : part;
      const localParent = lstatSync(path.join(worktree, parent), { throwIfNoEntry: false });
      if (!localParent) break;
      if (localParent.isDirectory()) continue;
      // A file or symlink at a parent path makes lstat on the incoming file throw ENOTDIR.
      if (!tracked.has(parent)) preserve(path.join(worktree, parent));
      blocked = true;
      break;
    }
    if (blocked) continue;
    const source = path.join(worktree, file);
    const local = lstatSync(source, { throwIfNoEntry: false });
    if (!local) continue;
    const matchingFile = local.isFile() && (local.mode & 0o111 ? "100755" : "100644") === mode
      && git(worktree, ["hash-object", "--", file]) === hash;
    const matchingLink = local.isSymbolicLink() && mode === "120000"
      && execFileSync("git", ["hash-object", "--stdin"], { cwd: worktree, input: readlinkSync(source), encoding: "utf8" }).trim() === hash;
    if (matchingFile || matchingLink) {
      // Git checks both blob and mode before adopting an untracked path in a fast-forward.
      git(worktree, ["add", "-f", "--", file]);
      continue;
    }
    preserve(source);
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
