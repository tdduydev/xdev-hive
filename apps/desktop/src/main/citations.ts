// Tells Hive what the files cited by a project's memory are now, so entries about code that changed get
// flagged for review. Reads the project's branch in its own checkout (committed state, not the working
// tree). No Electron imports.
import { execFileSync } from "node:child_process";
import type { Actor, DesktopProject, HiveBackend } from "@xdev-hive/core";
import { isGitRepo } from "./git.ts";

/** Object id of each path on `ref` (file or directory), null when it is not there. */
export function objectIds(repo: string, ref: string, paths: string[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  if (!paths.length) return out;
  // One process for every path: "<ref>:<path>" in, "<id> <type> <size>" or "<ref>:<path> missing" out.
  const lines = execFileSync("git", ["cat-file", "--batch-check=%(objectname)"], {
    cwd: repo,
    input: paths.map((p) => `${ref}:${p}`).join("\n") + "\n",
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  })
    .trimEnd()
    .split("\n");
  paths.forEach((p, i) => {
    const line = lines[i] ?? "";
    out.set(p, /^[0-9a-f]{40,64}$/.test(line) ? line : null);
  });
  return out;
}

/** The branch to read: the local one, else its origin copy; null when neither exists (nothing is checked then). */
export function resolveRef(repo: string, branch: string | undefined): string | null {
  for (const ref of branch ? [branch, `origin/${branch}`] : ["HEAD"]) {
    try {
      execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
      return ref;
    } catch {
      // try the next one
    }
  }
  return null;
}

export async function checkCitations(
  backend: HiveBackend,
  actor: Actor,
  project: DesktopProject,
): Promise<{ flagged: number; baselined: number } | null> {
  if (!isGitRepo(project.repo)) return null;
  const memories = await backend.call("memory.list", { project: project.name, limit: 500 }, actor);
  const paths = [...new Set(memories.filter((m) => m.project === project.name).flatMap((m) => m.files.map((f) => f.path)))];
  if (!paths.length) return null;
  // A wrong branch would make every file look deleted: skip the check instead.
  const ref = resolveRef(project.repo, project.targetBranch);
  if (!ref) return null;
  const ids = objectIds(project.repo, ref, paths);
  return backend.call("memory.checkFiles", { project: project.name, files: paths.map((path) => ({ path, sha: ids.get(path) ?? null })) }, actor);
}
