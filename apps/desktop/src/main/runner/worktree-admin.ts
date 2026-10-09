import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readdir, realpath, statfs } from "node:fs/promises";
import path from "node:path";
import { HiveError, type DesktopProject, type Task, type WorktreeEntry } from "@xdev-hive/core";
import { gitOutputAsync as gitAsync } from "#desktop/main/git.ts";
import { AGENT_CONFIG_FILES, AGENT_CLI_DIRS, renderedPathsAsync } from "#desktop/main/runner/worktree.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const inside = (root: string, dir: string) => {
  const rel = path.relative(root, dir);
  return !!rel && !rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel);
};
const ignored = new Set(["node_modules", ".git", "out", "dist", ".codegraph"]);

/** Links are never traversed: a dependency link must not count the source checkout's bytes or edits. */
async function modified(dir: string): Promise<number> {
  let latest = (await lstat(dir)).mtimeMs;
  for (const item of await readdir(dir, { withFileTypes: true })) {
    if (ignored.has(item.name)) continue;
    const file = path.join(dir, item.name);
    const st = await lstat(file);
    latest = Math.max(latest, item.isDirectory() ? await modified(file) : st.mtimeMs);
  }
  return latest;
}

function diskBytes(dir: string): Promise<number | null> {
  return new Promise(resolve => execFile("du", ["-sk", dir], { timeout: 60_000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
    const kb = Number(stdout.match(/^\s*(\d+)/)?.[1]);
    resolve(!err && Number.isFinite(kb) ? kb * 1024 : null);
  }));
}

export async function freeBytes(root: string): Promise<number | null> {
  try { const s = await statfs(root); return s.bavail * s.bsize; }
  catch { const parent = path.dirname(root); return parent === root ? null : freeBytes(parent); }
}

/** Only registered task worktrees directly under the runner's service folder are candidates for deletion. */
export async function registeredWorktrees(project: DesktopProject, root: string): Promise<Array<{ path: string; branch: string; taskId: string }>> {
  const managed = path.join(await realpath(root).catch(() => path.resolve(root)), project.name);
  const realManaged = await realpath(managed).catch(() => managed);
  if (realManaged !== managed) return [];
  const listed = await gitAsync(project.repo, ["worktree", "list", "--porcelain", "-z"]);
  const out = [];
  for (const block of listed.split("\0\0")) {
    const fields = block.split("\0");
    const rawDir = fields.find(f => f.startsWith("worktree "))?.slice(9);
    const dir = rawDir ? path.resolve(rawDir) : null;
    const branch = fields.find(f => f.startsWith("branch refs/heads/"))?.slice(18);
    if (!dir || !branch?.startsWith("ai/") || !inside(managed, dir) || path.dirname(dir) !== managed) continue;
    if (await realpath(dir).catch(() => "") !== dir || (await lstat(dir)).isSymbolicLink()) continue;
    const name = path.basename(dir);
    if (branch !== `ai/${name}` || !/^[A-Za-z0-9._-]+(?:\+c\d+)?$/.test(name)) continue;
    out.push({ path: dir, branch, taskId: name.replace(/\+c\d+$/, "") });
  }
  return out;
}

export async function inspectWorktree(project: DesktopProject, item: { path: string; branch: string; taskId: string }, task: Task | undefined, active: boolean, mergeRef?: string | null): Promise<WorktreeEntry> {
  const dir = item.path;
  const trackedConfig = await gitAsync(dir, ["ls-files", "--", ...AGENT_CONFIG_FILES, ...AGENT_CLI_DIRS]);
  const copied = [...AGENT_CONFIG_FILES, ...AGENT_CLI_DIRS].filter(f => !trackedConfig.split("\n").some(p => p === f || p.startsWith(`${f}/`)));
  const rendered = await renderedPathsAsync(dir);
  const [head, status, modifiedMs, bytes] = await Promise.all([
    gitAsync(dir, ["rev-parse", "HEAD"]),
    // Rendered context and copied untracked configuration never belong to an agent commit.
    gitAsync(dir, ["status", "--porcelain", "-z", "--", ".", ...rendered.map(f => `:(exclude)${f}`),
      ...copied.map(f => `:(exclude)${f}`)]),
    modified(dir), diskBytes(dir),
  ]);
  const target = project.targetBranch ?? await gitAsync(project.repo, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])
    .then(ref => ref.replace(/^refs\/remotes\/origin\//, "")).catch(() => "main");
  const remote = await gitAsync(project.repo, ["rev-parse", "--verify", `refs/remotes/origin/${target}^{commit}`]).catch(() => null);
  const ref = remote ?? await gitAsync(project.repo, ["rev-parse", "--verify", `refs/heads/${target}^{commit}`]).catch(() => null);
  const targetRef = mergeRef === undefined ? ref : mergeRef;
  const merged = targetRef ? await landed(project.repo, head, targetRef) : null;
  return {
    ...item, project: project.name, head, fingerprint: hash(JSON.stringify([dir, item.branch, head, status, modifiedMs])),
    bytes, modifiedAt: new Date(modifiedMs).toISOString(), dirty: !!status, merged, active,
    taskStatus: task?.status ?? null, taskUpdatedAt: task?.updatedAt ?? null,
    error: bytes === null ? "worktrees.measureFailed" : null,
  };
}

/**
 * The branch's work is in the target: as an ancestor, or, for an ai/* branch that landed squashed or re-applied on an
 * integration branch, because merging it into the target would change nothing. A conflict or an old git (no
 * merge-tree --write-tree, before 2.38) answers false, so such a worktree waits for retention as before.
 */
async function landed(repo: string, head: string, target: string): Promise<boolean> {
  if (await gitAsync(repo, ["merge-base", "--is-ancestor", head, target]).then(() => true, () => false)) return true;
  const [targetTree, mergedTree] = await Promise.all([
    gitAsync(repo, ["rev-parse", `${target}^{tree}`]).catch(() => null),
    gitAsync(repo, ["merge-tree", "--write-tree", target, head]).then((out) => out.split("\n")[0]!.trim()).catch(() => null),
  ]);
  return !!targetTree && targetTree === mergedTree;
}

export async function deleteWorktree(project: DesktopProject, root: string, expected: WorktreeEntry, force: boolean, isActive: () => boolean = () => false): Promise<void> {
  const registered = await registeredWorktrees(project, root);
  const item = registered.find(e => e.path === expected.path && e.branch === expected.branch);
  if (!item) throw new HiveError("conflict", "Worktree changed.", { key: "errors.worktreeChanged" });
  const fresh = await inspectWorktree(project, item, undefined, false);
  if (fresh.fingerprint !== expected.fingerprint) throw new HiveError("conflict", "Worktree changed.", { key: "errors.worktreeChanged" });
  if (!force && (fresh.dirty || fresh.merged !== true)) throw new HiveError("conflict", "Confirmation required.", { key: "errors.worktreeConfirm" });
  if (isActive()) throw new HiveError("conflict", "Task has an active run.", { key: "errors.worktreeActive" });
  // Git refuses locked worktrees and submodules. Never remove a folder with rm or delete the branch.
  await gitAsync(project.repo, ["worktree", "remove", "--force", expected.path]);
}
