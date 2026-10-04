import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { DesktopProject } from "@xdev-hive/core";
import { defaultBranch, findGitRepos } from "#desktop/main/git.ts";
import { addRepos, planLocalImport } from "#desktop/main/local-import.ts";

const sh = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });

/** A repository at `<root>/<rel>`, with one commit so it looks like a clone someone works in. */
function repoAt(root: string, rel: string): string {
  const dir = path.join(root, rel);
  mkdirSync(dir, { recursive: true });
  sh(dir, ["init", "-q", "-b", "main"]);
  sh(dir, ["config", "user.email", "test@example.com"]);
  sh(dir, ["config", "user.name", "Test"]);
  writeFileSync(path.join(dir, "README.md"), `# ${rel}\n`);
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-qm", "init"]);
  return dir;
}

/** The layout of roadmap 38d: a folder that is no repository, with repositories one to three levels down. */
function nested(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "hive-scan-"));
  repoAt(root, path.join("app", "backend", "billing"));
  repoAt(root, path.join("app", "frontend", "portal"));
  repoAt(root, "iam");
  return root;
}

describe("findGitRepos (roadmap 38d)", () => {
  it("finds the repositories three levels down, by folder name", () => {
    const root = nested();
    assert.deepEqual(
      findGitRepos(root).map((d) => path.relative(root, d).split(path.sep).join("/")),
      ["app/backend/billing", "app/frontend/portal", "iam"],
    );
  });

  it("stops at maxDepth: a repository four levels down is not offered", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "hive-deep-"));
    repoAt(root, path.join("a", "b", "c", "deep"));
    assert.deepEqual(findGitRepos(root), []);
    assert.deepEqual(findGitRepos(root, 4).map((d) => path.basename(d)), ["deep"]);
  });

  it("does not look inside a repository it found, nor into node_modules or hidden folders", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "hive-skip-"));
    const outer = repoAt(root, "outer");
    repoAt(outer, "vendor"); // a repository inside a repository (submodule, or a clone left there)
    repoAt(root, path.join("node_modules", "dep"));
    repoAt(root, path.join(".cache", "hidden"));
    assert.deepEqual(findGitRepos(root), [outer]);
  });

  it("is the folder itself when that is a repository", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "hive-one-"));
    const repo = repoAt(root, "solo");
    repoAt(repo, "inner");
    assert.deepEqual(findGitRepos(repo), [repo]);
  });
});

describe("defaultBranch", () => {
  it("reads origin/HEAD, and is null without a remote", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "hive-branch-"));
    const repo = repoAt(root, "repo");
    assert.equal(defaultBranch(repo), null);
    sh(repo, ["remote", "add", "origin", "https://gitlab.example.com/group/repo.git"]);
    // `git remote add` alone sets no HEAD; a clone does, and so does this.
    assert.equal(defaultBranch(repo), null);
    sh(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop"]);
    assert.equal(defaultBranch(repo), "develop");
  });
});

describe("planLocalImport", () => {
  it("gives each repository a free key, its target branch, and marks the ones already added", () => {
    const root = nested();
    const repos = findGitRepos(root);
    const iam = repos.find((d) => path.basename(d) === "iam")!;
    sh(iam, ["remote", "add", "origin", "https://gitlab.example.com/group/iam.git"]);
    sh(iam, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/dev"]);
    const projects: DesktopProject[] = [{ name: "iam-of-ours", repo: iam }, { name: "billing", repo: "/elsewhere/billing" }];
    const plan = planLocalImport(root, repos, projects);
    assert.deepEqual(
      plan.map((c) => [c.rel, c.key, c.targetBranch, c.state]),
      [
        // billing is taken by another project, so the key falls back to the folder above it, as the GitLab import does.
        ["app/backend/billing", "backend-billing", null, "new"],
        ["app/frontend/portal", "portal", null, "new"],
        // Already a project of this app: listed with its own key, not offered again.
        ["iam", "iam-of-ours", "dev", "added"],
      ],
    );
  });

  it("keeps two candidates from taking the same key", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "hive-dupe-"));
    const repos = [repoAt(root, path.join("app", "portal")), repoAt(root, path.join("iam", "portal"))];
    assert.deepEqual(planLocalImport(root, repos, []).map((c) => c.key), ["portal", "iam-portal"]);
  });
});

describe("addRepos", () => {
  it("adds every repository, and one that fails does not stop the rest", () => {
    const added: DesktopProject[] = [];
    const results = addRepos(
      [
        { name: "billing", repo: "/work/billing", targetBranch: "dev" },
        { name: "portal", repo: "/work/portal" },
        { name: "iam", repo: "/work/iam" },
      ],
      {
        add: (p) => {
          if (p.name === "portal") throw new Error("Đã có dự án portal.");
          added.push(p);
        },
      },
    );
    assert.deepEqual(results.map((r) => [r.key, r.ok, r.error]), [
      ["billing", true, null],
      ["portal", false, "Đã có dự án portal."],
      ["iam", true, null],
    ]);
    assert.deepEqual(added.map((p) => [p.name, p.targetBranch]), [["billing", "dev"], ["iam", undefined]]);
  });
});
