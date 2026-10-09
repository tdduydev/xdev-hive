import { redactLines, stripHidden } from "@xdev-hive/core";
import { git, gitAsync, gitErrorText } from "#desktop/main/git.ts";

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
