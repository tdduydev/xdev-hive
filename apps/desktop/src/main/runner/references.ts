// Reference repos of a run (roadmap 38h): the main checkout of other projects on this machine that a task has to
// read (old code, SQL maps, view models). They are never written to, so the run gets them read-only: Claude Code
// with --add-dir plus deny rules, a container with a `:ro` mount, and the prompt says which commit it is reading.
import { existsSync } from "node:fs";
import type { DesktopProject } from "@xdev-hive/core";
import { git } from "#desktop/main/git.ts";

export interface ReferenceRepo {
  /** The project key of the repo, as the prompt names it. */
  project: string;
  /** Its main checkout on this machine (the project's `repo`). */
  path: string;
  /** Branch it is on now, or "HEAD" when it is detached. */
  branch: string;
  sha: string;
}

/** What a checkout is at right now; null when the folder is gone or is not a git repo. */
export type ReadRepo = (dir: string) => { branch: string; sha: string } | null;

const readRepo: ReadRepo = (dir) => {
  if (!existsSync(dir)) return null;
  try {
    return { branch: git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]), sha: git(dir, ["rev-parse", "HEAD"]) };
  } catch {
    return null;
  }
};

/**
 * The reference repos a run gets, and the names it could not use. A reference is context, never a reason to lose a
 * run: a project that was removed, a folder that moved away or a repo without a commit is skipped and said so in
 * the run log.
 */
export function resolveReferences(
  names: string[] | undefined,
  projects: DesktopProject[],
  read: ReadRepo = readRepo,
): { repos: ReferenceRepo[]; skipped: Array<{ project: string; reason: string }> } {
  const repos: ReferenceRepo[] = [];
  const skipped: Array<{ project: string; reason: string }> = [];
  for (const name of [...new Set(names ?? [])]) {
    const project = projects.find((p) => p.name === name);
    if (!project) {
      skipped.push({ project: name, reason: "not on this machine" });
      continue;
    }
    const head = read(project.repo);
    if (!head) {
      skipped.push({ project: name, reason: `no git repo at ${project.repo}` });
      continue;
    }
    repos.push({ project: name, path: project.repo, branch: head.branch, sha: head.sha });
  }
  return { repos, skipped };
}

/** The run log line, next to the one of the Hive context. */
export function describeReferences(out: { repos: ReferenceRepo[]; skipped: Array<{ project: string; reason: string }> }): string | null {
  if (!out.repos.length && !out.skipped.length) return null;
  const parts = [
    ...out.repos.map((r) => `${r.project} ${r.path} (${r.branch} ${r.sha.slice(0, 10)})`),
    ...out.skipped.map((s) => `${s.project}: ${s.reason}`),
  ];
  return `# references (read-only): ${parts.join(" · ")}`;
}
