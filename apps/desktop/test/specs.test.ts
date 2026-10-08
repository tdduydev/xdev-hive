import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { Actor, HiveBackend } from "@xdev-hive/core";
import { SqliteHive } from "@xdev-hive/core/node";
import { collectSpecs, pushSpecs } from "#desktop/main/specs.ts";

const testTmpDirs = new Set<string>();
function testTmpDir(prefix: string): string {
  const dir = mkdtempSync(prefix);
  testTmpDirs.add(dir);
  return dir;
}

const machine: Actor = { name: "runner.duy-mbp@duy-mbp", role: "agent" };
const admin: Actor = { name: "duy", role: "admin" };
const git = (repo: string, ...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

function repo() {
  const dir = testTmpDir(path.join(os.tmpdir(), "hive-specs-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "Test");
  const commit = (files: Record<string, string>, message: string) => {
    for (const [f, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      writeFileSync(path.join(dir, f), text);
    }
    git(dir, "add", ".");
    git(dir, "commit", "-qm", message);
  };
  return { dir, commit };
}

describe("Spec Kit features to the hub (roadmap 20b)", () => {
  it("reads the target branch and the work branches that differ from it, and sends again only when they change", async () => {
    const { dir, commit } = repo();
    commit({ "specs/001-a/spec.md": "# Feature Specification: A\n", "specs/README.md": "not a feature\n" }, "spec A");
    // Spec Kit's own branch for a new feature: spec and plan.
    git(dir, "checkout", "-q", "-b", "002-b");
    commit({ "specs/002-b/spec.md": "# Feature Specification: B\n", "specs/002-b/plan.md": "# Plan B\n" }, "spec B");
    // An agent's run changes A.
    git(dir, "checkout", "-q", "-b", "ai/T-1", "main");
    commit({ "specs/001-a/spec.md": "# Feature Specification: A, sửa\n" }, "edit A");
    // Neither a run's nor Spec Kit's branch: not shown.
    git(dir, "checkout", "-q", "-b", "feature-x", "main");
    commit({ "specs/003-c/spec.md": "# C\n" }, "spec C");
    // A run's branch with nothing new against main.
    git(dir, "checkout", "-q", "-b", "ai/T-2", "main");
    git(dir, "checkout", "-q", "main");

    const features = await collectSpecs(dir, "main");
    assert.deepEqual(
      features.map((f) => [f.dir, f.branch, f.files.spec, f.files.plan]),
      [
        ["001-a", "", "# Feature Specification: A", null],
        ["002-b", "002-b", "# Feature Specification: B", "# Plan B"],
        ["001-a", "ai/T-1", "# Feature Specification: A, sửa", null],
      ],
    );
    assert.equal(features[0]!.commit, git(dir, "rev-parse", "main"));

    const hive = new SqliteHive(":memory:");
    let calls = 0;
    const counting: HiveBackend = {
      call(method, input, actor) {
        if (method === "specs.push") calls++;
        return hive.call(method, input, actor);
      },
    };
    const project = { name: "demo", repo: dir, targetBranch: "main" };
    const first = await pushSpecs(counting, machine, project);
    assert.equal(calls, 1);
    assert.deepEqual((await hive.call("specs.list", { project: "demo" }, admin)).map((f) => [f.dir, f.branch, f.stage]), [
      ["001-a", "", "specify"],
      ["001-a", "ai/T-1", "specify"],
      ["002-b", "002-b", "plan"],
    ]);
    // Nothing changed: nothing sent.
    assert.equal(await pushSpecs(counting, machine, project, first), first);
    assert.equal(calls, 1);
    // The checkout is not what goes out.
    writeFileSync(path.join(dir, "specs/001-a/tasks.md"), "- [ ] T001 draft\n");
    assert.equal(await pushSpecs(counting, machine, project, first), first);
    assert.equal(calls, 1);
  });

  it("leaves out work branches nobody committed to for 30 days", async () => {
    const { dir, commit } = repo();
    commit({ "specs/001-a/spec.md": "# A\n" }, "spec A");
    git(dir, "checkout", "-q", "-b", "002-old");
    commit({ "specs/002-old/spec.md": "# Old\n" }, "old");
    git(dir, "checkout", "-q", "main");
    const later = Date.now() + 31 * 86_400_000;
    assert.deepEqual((await collectSpecs(dir, "main", later)).map((f) => f.dir), ["001-a"]);
  });
});

after(() => {
  for (const dir of testTmpDirs) rmSync(dir, { recursive: true, force: true });
});
