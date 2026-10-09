import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { DesktopProject, GitLabGroupRepo } from "@xdev-hive/core";
import { GitHubClient } from "#desktop/main/github/client.ts";
import { gitClone, importRepos, planImport } from "#desktop/main/gitlab/import.ts";

const testTmpDirs = new Set<string>();
function testTmpDir(prefix: string): string {
  const dir = mkdtempSync(prefix);
  testTmpDirs.add(dir);
  return dir;
}

const tmp = (name: string) => testTmpDir(path.join(os.tmpdir(), `hive-gh-import-${name}-`));
const raw = (full: string, id: number, archived = false) => ({
  id,
  name: full.split("/").at(-1)!,
  full_name: full,
  default_branch: "main",
  ssh_url: `git@github.com:${full}.git`,
  clone_url: `https://github.com/${full}.git`,
  archived,
});
const repo = (full: string): GitLabGroupRepo => ({ id: 1, name: full.split("/").at(-1)!, pathWithNamespace: full, defaultBranch: "main", sshUrl: `git@github.com:${full}.git`, httpUrl: `https://github.com/${full}.git` });

/** A GitHub API answering /user as `me`, /users/:x with `type`, and repo listings from `pages`. */
function mockGitHub(me: string, type: "User" | "Organization", pages: (url: URL) => unknown[]) {
  const seen: string[] = [];
  const fetchImpl = (async (url: string) => {
    const u = new URL(url);
    seen.push(u.pathname + u.search);
    if (u.pathname === "/user") return new Response(JSON.stringify({ login: me, name: null }), { status: 200 });
    if (/^\/users\/[^/]+$/.test(u.pathname)) return new Response(JSON.stringify({ login: u.pathname.split("/").at(-1), type }), { status: 200 });
    return new Response(JSON.stringify(pages(u)), { status: 200 });
  }) as never;
  return { client: new GitHubClient("https://github.com", "tok", fetchImpl), seen };
}

describe("importing a GitHub organization or user", () => {
  it("lists every page of an organization, archived left out", async () => {
    const { client, seen } = mockGitHub("duy", "Organization", (u) => {
      const page = Number(u.searchParams.get("page"));
      return page === 1 ? Array.from({ length: 100 }, (_, i) => raw(`acme/r${i + 1}`, i + 1, i === 0)) : [raw("acme/last", 101)];
    });
    const repos = await client.ownerRepos("acme");
    assert.equal(repos.length, 100, "100 + 1 listed, the archived one left out");
    assert.deepEqual(repos[0], { id: 2, name: "r2", pathWithNamespace: "acme/r2", defaultBranch: "main", sshUrl: "git@github.com:acme/r2.git", httpUrl: "https://github.com/acme/r2.git" });
    const listings = seen.filter((s) => s.startsWith("/orgs/"));
    assert.equal(listings.length, 2, "stops at the page that is not full");
    assert.match(listings[0]!, /^\/orgs\/acme\/repos\?type=all&.*per_page=100&page=1$/);
  });

  it("lists another user's repositories, and the token's own account with its private ones", async () => {
    const other = mockGitHub("duy", "User", () => [raw("someone/tool", 1)]);
    assert.deepEqual((await other.client.ownerRepos("someone")).map((r) => r.pathWithNamespace), ["someone/tool"]);
    assert.ok(other.seen.some((s) => s.startsWith("/users/someone/repos?type=owner")));
    const self = mockGitHub("Duy", "User", () => [raw("Duy/secret", 1)]);
    await self.client.ownerRepos("duy");
    assert.ok(self.seen.some((s) => s.startsWith("/user/repos?affiliation=owner")), "own account goes through /user/repos");
    assert.ok(!self.seen.some((s) => s.startsWith("/users/")), "no lookup of the owner's type for the own account");
  });

  it("knows a repository this app has by its GitHub owner/repo", () => {
    const base = tmp("plan");
    const projects: DesktopProject[] = [{ name: "web", repo: "/work/web", githubRepo: "acme/web" }, { name: "api-old", repo: "/work/api", gitlabProject: "acme/api" }];
    const plan = planImport([repo("acme/web"), repo("acme/api")], base, projects, "acme", [], "githubRepo");
    assert.deepEqual(
      plan.map((c) => [c.repo.pathWithNamespace, c.key, c.state, path.relative(base, c.dir) || c.dir]),
      [
        ["acme/api", "api", "new", "api"],
        ["acme/web", "web", "added", path.relative(base, "/work/web")],
      ],
    );
  });

  it("adds the project with its owner/repo and clones without the token in .git/config", async () => {
    const source = tmp("source");
    execFileSync("git", ["init", "-q", "-b", "main", source]);
    writeFileSync(path.join(source, "README.md"), "hello\n");
    execFileSync("git", ["-C", source, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "init"]);
    const base = tmp("into");
    const added: DesktopProject[] = [];
    const results = await importRepos(
      [{ key: "web", pathWithNamespace: "acme/web", dir: path.join(base, "web"), url: source, sshUrl: "git@github.com:acme/web.git", httpUrl: "https://github.com/acme/web.git", targetBranch: "main" }],
      { check: () => {}, clone: gitClone("github.com", { user: "x-access-token", token: "secret-token" }), remote: () => null, add: (p) => void added.push(p), field: "githubRepo" },
    );
    assert.deepEqual(results.map((r) => [r.ok, r.cloned, r.error]), [[true, true, null]]);
    assert.deepEqual(added.map((p) => [p.name, p.githubRepo, p.gitlabProject, p.targetBranch]), [["web", "acme/web", undefined, "main"]]);
    assert.doesNotMatch(readFileSync(path.join(base, "web", ".git", "config"), "utf8"), /secret-token|extraHeader/i);
  });
});

after(() => {
  for (const dir of testTmpDirs) rmSync(dir, { recursive: true, force: true });
});
