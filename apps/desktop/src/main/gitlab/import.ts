// Importing a GitLab group (roadmap 19a): each repository of the group (and its subgroups) becomes a project of this
// app, cloned under one folder, with its GitLab path set so merge requests go to the right place. A folder that is
// already there is used as it is; a repository a project already has is left alone.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { suggestProjectKey, type DesktopProject, type GitLabGroupRepo, type GitLabImportCandidate, type GitLabImportResult } from "@xdev-hive/core";
import type { GitLabClient } from "./client.ts";
import { parseRemoteUrl } from "./remote.ts";
import { pushEnv } from "./mr.ts";

/** What the import offers: keys that do not clash with this app's projects or each other, and the folder of each. */
export function planImport(repos: GitLabGroupRepo[], baseDir: string, projects: DesktopProject[]): GitLabImportCandidate[] {
  const taken = new Set(projects.map((p) => p.name));
  const known = new Map(projects.map((p) => [p.gitlabProject ?? "", p.name]));
  const dirs = new Set<string>();
  return [...repos]
    .sort((a, b) => a.pathWithNamespace.localeCompare(b.pathWithNamespace))
    .map((repo) => {
      const already = known.get(repo.pathWithNamespace);
      if (already) return { repo, key: already, dir: projects.find((p) => p.name === already)!.repo, state: "added" as const };
      const key = suggestProjectKey(repo.pathWithNamespace, taken);
      taken.add(key);
      // The repository's own name under the base folder, like `git clone` would; two of the same name in different
      // groups: the later one gets its key, which no other has.
      let dir = path.join(baseDir, repo.pathWithNamespace.split("/").at(-1)!);
      if (dirs.has(dir)) dir = path.join(baseDir, key);
      dirs.add(dir);
      return { repo, key, dir, state: existsSync(dir) ? ("folder" as const) : ("new" as const) };
    });
}

export interface ImportItem {
  key: string;
  pathWithNamespace: string;
  dir: string;
  url: string;
}

export interface ImportDeps {
  /** Throws when the key cannot be a project here (not valid, or taken), before anything is cloned for it. */
  check(key: string): void;
  /** Clones `url` into `dir`; rejects with git's last words. */
  clone(url: string, dir: string): Promise<void>;
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
      if (!there) {
        mkdirSync(path.dirname(item.dir), { recursive: true });
        await deps.clone(item.url, item.dir);
        result.cloned = true;
      }
      deps.add({ name: item.key, repo: item.dir, gitlabProject: item.pathWithNamespace });
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
