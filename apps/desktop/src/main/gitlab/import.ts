// Importing a GitLab group (roadmap 19a): each repository of the group (and its subgroups) becomes a project of this
// app, cloned under its subgroup path or reused at a matching local clone, with its GitLab path set so merge requests
// go to the right place. An occupied folder with a different remote is left alone.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { suggestProjectKey, type DesktopProject, type GitLabGroupRepo, type GitLabImportCandidate, type GitLabImportResult } from "@xdev-hive/core";
import type { GitLabClient } from "./client.ts";
import { parseRemoteUrl } from "./remote.ts";
import { pushEnv } from "./mr.ts";

export interface LocalClone { dir: string; remote: string | null }

/** Keep the path relative to the selected group, including subgroups. */
export function subgroupPath(repo: GitLabGroupRepo, group: string): string {
  const prefix = `${group.toLowerCase()}/`;
  return repo.pathWithNamespace.toLowerCase().startsWith(prefix)
    ? repo.pathWithNamespace.slice(prefix.length)
    : repo.pathWithNamespace.split("/").at(-1)!;
}

/** Compare the full paths GitLab actually gives us; self-hosted HTTPS may have a prefix such as /gitlab. */
export function matchesRemote(remote: string | null, repo: Pick<GitLabGroupRepo, "sshUrl" | "httpUrl">): boolean {
  const actual = remote && parseRemoteUrl(remote);
  if (!actual) return false;
  return [repo.sshUrl, repo.httpUrl].some((url) => {
    const expected = parseRemoteUrl(url);
    return expected?.host === actual.host && expected.path.toLowerCase() === actual.path.toLowerCase();
  });
}

/** What the import offers: keys that do not clash with this app's projects or each other, and the folder of each. */
export function planImport(repos: GitLabGroupRepo[], baseDir: string, projects: DesktopProject[], group: string, local: LocalClone[]): GitLabImportCandidate[] {
  const taken = new Set(projects.map((p) => p.name));
  const known = new Map(projects.filter((p) => p.gitlabProject).map((p) => [p.gitlabProject!.toLowerCase(), p]));
  const byDir = new Map(projects.map((p) => [path.resolve(p.repo), p]));
  const byLocalDir = new Map(local.map((clone) => [path.resolve(clone.dir), clone]));
  const dirs = new Set<string>();
  return [...repos]
    .sort((a, b) => a.pathWithNamespace.localeCompare(b.pathWithNamespace))
    .map((repo) => {
      const already = known.get(repo.pathWithNamespace.toLowerCase());
      if (already) return { repo, key: already.name, dir: already.repo, state: "added" as const };
      const matching = local.filter((clone) => matchesRemote(clone.remote, repo));
      // An already registered clone wins even when an unregistered copy sorts first in the scan.
      const clone = matching.find((c) => byDir.has(path.resolve(c.dir))) ?? matching[0];
      const owner = clone && byDir.get(path.resolve(clone.dir));
      if (owner) return { repo, key: owner.name, dir: owner.repo, state: "added" as const };
      const key = suggestProjectKey(repo.pathWithNamespace, taken);
      taken.add(key);
      if (clone) return { repo, key, dir: clone.dir, state: "folder" as const };
      let dir = path.join(baseDir, subgroupPath(repo, group));
      if (dirs.has(dir)) dir = path.join(baseDir, key);
      dirs.add(dir);
      const occupied = existsSync(dir);
      return { repo, key, dir, state: occupied && matchesRemote(byLocalDir.get(path.resolve(dir))?.remote ?? null, repo) ? "folder" as const : occupied ? "conflict" as const : "new" as const };
    });
}

export interface ImportItem {
  key: string;
  pathWithNamespace: string;
  dir: string;
  url: string;
  sshUrl: string;
  httpUrl: string;
  targetBranch: string | null;
}

export interface ImportDeps {
  /** Throws when the key cannot be a project here (not valid, or taken), before anything is cloned for it. */
  check(key: string): void;
  /** Clones `url` into `dir`; rejects with git's last words. */
  clone(url: string, dir: string): Promise<void>;
  /** Reads origin again so stale or forged UI selections cannot reuse another repository. */
  remote(dir: string): string | null;
  /** Adds the project to the app (throws when the key is taken or the folder is missing). */
  add(project: DesktopProject): void;
}

/** One after another, so a slow or failing clone is reported on its own and the rest still come in. */
export async function importRepos(items: ImportItem[], deps: ImportDeps): Promise<GitLabImportResult[]> {
  const out: GitLabImportResult[] = [];
  for (const item of items) {
    const result: GitLabImportResult = { key: item.key, pathWithNamespace: item.pathWithNamespace, ok: false, cloned: false, error: null };
    try {
      deps.check(item.key);
      const there = existsSync(item.dir);
      if (there && !statSync(item.dir).isDirectory()) throw new Error(`${item.dir} is a file.`);
      if (there && !matchesRemote(deps.remote(item.dir), item)) {
        throw new Error(`${item.dir} belongs to another repository or is not a Git repository.`);
      }
      if (!there) {
        mkdirSync(path.dirname(item.dir), { recursive: true });
        await deps.clone(item.url, item.dir);
        result.cloned = true;
      }
      deps.add({ name: item.key, repo: item.dir, gitlabProject: item.pathWithNamespace, targetBranch: item.targetBranch ?? undefined });
      result.ok = true;
    } catch (err) {
      result.error = String((err as Error).message ?? err).slice(0, 500);
    }
    out.push(result);
  }
  return out;
}

/**
 * `git clone` that never waits for a password or a host-key question; over HTTPS to the GitLab host the token goes as
 * a header in env-scoped git config, never into .git/config (as pushes do).
 */
export function gitClone(client: GitLabClient, token: string): ImportDeps["clone"] {
  return (url, dir) =>
    new Promise((resolve, reject) => {
      const env = { ...process.env, ...pushEnv(url, parseRemoteUrl(url), client.host, { user: "oauth2", token }) };
      execFile("git", ["clone", "--quiet", url, dir], { env, timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024 }, (err, _out, stderr) => {
        if (!err) return resolve();
        const last = String(stderr).trim().split("\n").filter(Boolean).at(-1);
        reject(new Error(last || err.message));
      });
    });
}
