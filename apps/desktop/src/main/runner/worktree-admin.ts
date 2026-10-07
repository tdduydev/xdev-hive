import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readdir, realpath, statfs } from "node:fs/promises";
import path from "node:path";
import { HiveError, type DesktopProject, type Task, type WorktreeEntry, type WorktreeCleanup } from "@xdev-hive/core";
import { AGENT_CONFIG_FILES, AGENT_CLI_DIRS, renderedPaths } from "#desktop/main/runner/worktree.ts";

// Git's successful stderr can contain platform diagnostics; it is never part of a ref or status record.
function gitAsync(repo: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile("git", args, { cwd: repo, encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) reject(Object.assign(err, { stderr }));
    else resolve(stdout.trim());
  }));
}

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
  const [head, status, modifiedMs, bytes] = await Promise.all([
    gitAsync(dir, ["rev-parse", "HEAD"]),
    // Rendered context and copied untracked configuration never belong to an agent commit.
    gitAsync(dir, ["status", "--porcelain", "-z", "--", ".", ...renderedPaths(dir).map(f => `:(exclude)${f}`),
      ...copied.map(f => `:(exclude)${f}`)]),
    modified(dir), diskBytes(dir),
  ]);
  const target = project.targetBranch ?? await gitAsync(project.repo, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])
    .then(ref => ref.replace(/^refs\/remotes\/origin\//, "")).catch(() => "main");
  const remote = await gitAsync(project.repo, ["rev-parse", "--verify", `refs/remotes/origin/${target}^{commit}`]).catch(() => null);
  const ref = remote ?? await gitAsync(project.repo, ["rev-parse", "--verify", `refs/heads/${target}^{commit}`]).catch(() => null);
  const targetRef = mergeRef === undefined ? ref : mergeRef;
  const merged = targetRef ? await gitAsync(project.repo, ["merge-base", "--is-ancestor", head, targetRef]).then(() => true, () => false) : null;
  return {
    ...item, project: project.name, head, fingerprint: hash(JSON.stringify([dir, item.branch, head, status, modifiedMs])),
    bytes, modifiedAt: new Date(modifiedMs).toISOString(), dirty: !!status, merged, active,
    taskStatus: task?.status ?? null, taskUpdatedAt: task?.updatedAt ?? null,
    error: bytes === null ? "worktrees.measureFailed" : null,
  };
}

export function cleanupReason(entry: WorktreeEntry, cleanup: WorktreeCleanup, now: Date): "merged" | "retention" | null {
  if (!cleanup.enabled || entry.active || entry.dirty || entry.taskStatus !== "done") return null;
  if (entry.merged === true) return "merged";
  return entry.taskUpdatedAt && +now - Date.parse(entry.taskUpdatedAt) >= cleanup.retentionDays * 86400_000 ? "retention" : null;
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
