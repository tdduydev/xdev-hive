// Adding a folder that holds several repositories (roadmap 38d): the folder a customer's system lives in is no
// repository itself, it holds eight. Instead of refusing and leaving the person to add them one by one, the app offers
// each repository it finds as its own project, with the key and target branch it would get, and puts them in a system.
import path from "node:path";
import { suggestProjectKey, type DesktopProject, type RepoCandidate, type RepoImportResult } from "@xdev-hive/core";
import { defaultBranch } from "./git.ts";

/**
 * What adding `root` would offer: one candidate per repository found under it, with a key that clashes with no
 * project of this app nor with another candidate, and the branch its remote points at.
 */
export function planLocalImport(root: string, repos: string[], projects: DesktopProject[]): RepoCandidate[] {
  const taken = new Set(projects.map((p) => p.name));
  const byDir = new Map(projects.map((p) => [path.resolve(p.repo), p.name]));
  return repos.map((dir) => {
    const already = byDir.get(path.resolve(dir));
    // The path under the root, not only the folder's name: two repos named `backend` then get `his-backend` and
    // `iam-backend` from suggestProjectKey, as the GitLab import does with a group path.
    const rel = path.relative(root, dir).split(path.sep).join("/") || path.basename(dir);
    const key = already ?? suggestProjectKey(rel, taken);
    taken.add(key);
    return { dir, rel, key, targetBranch: defaultBranch(dir), state: already ? ("added" as const) : ("new" as const) };
  });
}

export interface AddReposDeps {
  /** Adds the project to the app; throws when the key is taken, invalid, or the folder is not a repository. */
  add(project: DesktopProject): void;
}

/** One after another, so a repository that cannot be added is reported on its own and the rest still come in. */
export function addRepos(items: DesktopProject[], deps: AddReposDeps): RepoImportResult[] {
  return items.map((item) => {
    try {
      deps.add(item);
      return { key: item.name, dir: item.repo, ok: true, error: null };
    } catch (err) {
      return { key: item.name, dir: item.repo, ok: false, error: String((err as Error).message ?? err).slice(0, 500) };
    }
  });
}
