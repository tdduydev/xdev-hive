import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { suggestProjectKey, type DesktopProject, type GitLabGroupRepo } from "@xdev-hive/core";
import { GitLabClient } from "#desktop/main/gitlab/client.ts";
import { importRepos, planImport, subgroupPath } from "#desktop/main/gitlab/import.ts";

const testTmpDirs = new Set<string>();
function testTmpDir(prefix: string): string {
  const dir = mkdtempSync(prefix);
  testTmpDirs.add(dir);
  return dir;
}

const tmp = (name: string) => testTmpDir(path.join(os.tmpdir(), `hive-import-${name}-`));
const repo = (pathWithNamespace: string, id = 1): GitLabGroupRepo => ({
  id,
  name: pathWithNamespace.split("/").at(-1)!,
  pathWithNamespace,
  defaultBranch: "main",
  sshUrl: `git@gitlab.example.test:${pathWithNamespace}.git`,
  httpUrl: `https://gitlab.example.test/${pathWithNamespace}.git`,
});

describe("importing a GitLab group", () => {
  it("suggests a project key from the repository's name, with its group when taken, then a number", () => {
    assert.equal(suggestProjectKey("fis/ehealth/Auth Service", []), "auth-service");
    assert.equal(suggestProjectKey("fis/ehealth/web", ["web"]), "ehealth-web");
    assert.equal(suggestProjectKey("fis/ehealth/web", ["web", "ehealth-web"]), "web-2");
    assert.equal(suggestProjectKey("x/_hidden.", []), "hidden", "starts with a letter or digit, no trailing dot");
  });

  it("lists every page of a group, subgroups included, archived left out", async () => {
    const seen: string[] = [];
    const page = (n: number, from: number) =>
      Array.from({ length: n }, (_, i) => ({ id: from + i, name: `r${from + i}`, path_with_namespace: `g/r${from + i}`, default_branch: "main", ssh_url_to_repo: "s", http_url_to_repo: "h" }));
    const client = new GitLabClient("https://gitlab.example.test/", "tok", (async (url: string) => {
      seen.push(url);
      const n = Number(new URL(url).searchParams.get("page"));
      return new Response(JSON.stringify(n === 1 ? page(100, 1) : page(3, 101)), { status: 200 });
    }) as never);
    const repos = await client.groupProjects("fis/ehealth");
    assert.equal(repos.length, 103);
    assert.deepEqual(repos[0], { id: 1, name: "r1", pathWithNamespace: "g/r1", defaultBranch: "main", sshUrl: "s", httpUrl: "h" });
    assert.equal(seen.length, 2, "stops at the page that is not full");
    const q = new URL(seen[0]!).searchParams;
    assert.equal(new URL(seen[0]!).pathname, "/api/v4/groups/fis%2Fehealth/projects");
    assert.deepEqual([q.get("include_subgroups"), q.get("archived")], ["true", "false"]);
  });

  it("offers each repository with a key and a folder of its own, and knows what this app has already", () => {
    const base = tmp("base");
    mkdirSync(path.join(base, "gateway"));
    const projects: DesktopProject[] = [
      { name: "web", repo: "/work/web", gitlabProject: "fis/ehealth/web" },
      { name: "auth", repo: "/work/auth" },
    ];
    const plan = planImport([repo("fis/ehealth/web"), repo("fis/ehealth/auth"), repo("fis/ehealth/gateway"), repo("fis/billing/auth")], base, projects, "fis/ehealth", []);
    assert.deepEqual(
      plan.map((c) => [c.repo.pathWithNamespace, c.key, path.relative(base, c.dir) || c.dir, c.state]),
      [
        ["fis/billing/auth", "billing-auth", "auth", "new"],
        ["fis/ehealth/auth", "ehealth-auth", "ehealth-auth", "new"],
        ["fis/ehealth/gateway", "gateway", "gateway", "conflict"],
        ["fis/ehealth/web", "web", path.relative(base, "/work/web"), "added"],
      ],
    );
  });

  it("keeps subgroup paths and reuses an HTTPS clone behind a GitLab URL prefix", () => {
    const base = tmp("prefixed");
    const nested = path.join(base, "services", "app");
    const project = { ...repo("team/services/app"), httpUrl: "https://gitlab.example.test/gitlab/team/services/app.git" };
    assert.equal(subgroupPath(project, "team"), "services/app");
    const plan = planImport([project], base, [], "team", [{ dir: nested, remote: "https://gitlab.example.test/gitlab/team/services/app.git" }]);
    assert.deepEqual([plan[0]?.state, plan[0]?.dir], ["folder", nested]);
  });

  it("prefers the matching clone already registered as a project", () => {
    const base = tmp("duplicates");
    const project = repo("team/app");
    const unregistered = path.join(base, "a");
    const registered = path.join(base, "z");
    const plan = planImport([project], base, [{ name: "my-app", repo: registered }], "team", [
      { dir: unregistered, remote: project.sshUrl },
      { dir: registered, remote: project.httpUrl },
    ]);
    assert.deepEqual([plan[0]?.state, plan[0]?.key, plan[0]?.dir], ["added", "my-app", registered]);
  });

  it("two clones of one remote: the one where the group's tree puts it, not the first scanned", () => {
    const base = tmp("tree");
    const project = repo("customer-ai/his/backend/svc-core");
    // findGitRepos sorts by name: the e2e copy comes first at the same depth, and the tree's own one later.
    const e2e = path.join(base, "his", "backend", "svc-core-e2e");
    const tree = path.join(base, "his", "backend", "svc-core");
    const plan = planImport([project], base, [], "customer-ai", [{ dir: e2e, remote: project.sshUrl }, { dir: tree, remote: project.httpUrl }]);
    assert.deepEqual([plan[0]?.state, plan[0]?.dir], ["folder", tree]);
  });

  it("accepts an existing prefixed HTTPS clone during import", async () => {
    const base = tmp("prefixed-import");
    const dir = path.join(base, "app");
    mkdirSync(dir);
    const project = { ...repo("team/app"), httpUrl: "https://gitlab.example.test/gitlab/team/app.git" };
    const added: DesktopProject[] = [];
    const results = await importRepos([{
      key: "app", pathWithNamespace: project.pathWithNamespace, dir, url: project.sshUrl,
      sshUrl: project.sshUrl, httpUrl: project.httpUrl, targetBranch: "main",
    }], {
      check: () => {}, clone: async () => { throw new Error("should not clone"); },
      remote: () => project.httpUrl, add: (item) => void added.push(item),
    });
    assert.deepEqual(results.map((r) => [r.ok, r.cloned]), [[true, false]]);
    assert.deepEqual(added.map((p) => [p.repo, p.targetBranch]), [[dir, "main"]]);
  });

  it("clones new repositories, rejects an unrelated folder, and goes on when one fails", async () => {
    // A real repository to clone from.
    const source = tmp("source");
    execFileSync("git", ["init", "-q", "-b", "main", source]);
    writeFileSync(path.join(source, "README.md"), "hello\n");
    execFileSync("git", ["-C", source, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "init"]);
    const base = tmp("into");
    mkdirSync(path.join(base, "gateway"));
    const added: DesktopProject[] = [];
    const clone = (url: string, dir: string) =>
      new Promise<void>((resolve, reject) => {
        try {
          execFileSync("git", ["clone", "-q", url, dir], { stdio: "pipe" });
          resolve();
        } catch (err) {
          reject(new Error(String((err as { stderr?: Buffer }).stderr ?? err).trim().split("\n").at(-1)));
        }
      });
    const results = await importRepos(
      [
        { key: "auth", pathWithNamespace: "fis/auth", dir: path.join(base, "auth"), url: source, sshUrl: "git@gitlab.example.test:fis/auth.git", httpUrl: "https://gitlab.example.test/fis/auth.git", targetBranch: "main" },
        { key: "gone", pathWithNamespace: "fis/gone", dir: path.join(base, "gone"), url: path.join(base, "no-such-repo"), sshUrl: "git@gitlab.example.test:fis/gone.git", httpUrl: "https://gitlab.example.test/fis/gone.git", targetBranch: "main" },
        { key: "gateway", pathWithNamespace: "fis/gateway", dir: path.join(base, "gateway"), url: "unused", sshUrl: "git@gitlab.example.test:fis/gateway.git", httpUrl: "https://gitlab.example.test/fis/gateway.git", targetBranch: "main" },
        // Taken by the first one: refused before it is cloned, so no folder is left behind.
        { key: "auth", pathWithNamespace: "fis/auth-2", dir: path.join(base, "auth-2"), url: source, sshUrl: "git@gitlab.example.test:fis/auth-2.git", httpUrl: "https://gitlab.example.test/fis/auth-2.git", targetBranch: "main" },
      ],
      {
        check: (key) => {
          if (added.some((p) => p.name === key)) throw new Error(`${key} is taken`);
        },
        clone,
        remote: () => null,
        add: (p) => void added.push(p),
      },
    );
    assert.deepEqual(results.map((r) => [r.key, r.ok, r.cloned]), [["auth", true, true], ["gone", false, false], ["gateway", false, false], ["auth", false, false]]);
    assert.equal(results[3]!.error, "auth is taken");
    assert.equal(existsSync(path.join(base, "auth-2")), false);
    assert.ok(results[1]!.error, "why it failed");
    assert.deepEqual(added.map((p) => [p.name, p.gitlabProject, p.targetBranch]), [["auth", "fis/auth", "main"]], "with its GitLab path and default branch");
    assert.equal(execFileSync("git", ["-C", path.join(base, "auth"), "rev-parse", "--is-inside-work-tree"]).toString().trim(), "true");
  });
});

after(() => {
  for (const dir of testTmpDirs) rmSync(dir, { recursive: true, force: true });
});
