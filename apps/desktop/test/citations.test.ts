import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { Actor } from "@xdev-hive/core";
import { SqliteHive } from "@xdev-hive/core/node";
import { checkCitations, objectIds, resolveRef } from "../src/main/citations.ts";

const admin: Actor = { name: "duy", role: "admin" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function repo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-cite-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "Test");
  mkdirSync(path.join(dir, "src", "db"), { recursive: true });
  writeFileSync(path.join(dir, "src", "db", "pool.ts"), "export const pool = 1;\n");
  writeFileSync(path.join(dir, "README.md"), "# demo\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "init");
  return dir;
}

describe("citation check on a real repo", () => {
  it("reads object ids from the branch, not the working tree", () => {
    const dir = repo();
    const before = objectIds(dir, "main", ["src/db/pool.ts", "src/db", "nope.ts"]);
    assert.match(before.get("src/db/pool.ts")!, /^[0-9a-f]{40}$/);
    assert.match(before.get("src/db")!, /^[0-9a-f]{40}$/, "a directory has an id too");
    assert.equal(before.get("nope.ts"), null);
    writeFileSync(path.join(dir, "src", "db", "pool.ts"), "uncommitted\n");
    assert.equal(objectIds(dir, "main", ["src/db/pool.ts"]).get("src/db/pool.ts"), before.get("src/db/pool.ts"));
  });

  it("baselines, then flags the entry once the cited code changes on the branch", async () => {
    const dir = repo();
    const hive = new SqliteHive(":memory:");
    const project = { name: "demo", repo: dir, targetBranch: "main" };
    const m = await hive.call("memory.write", { project: "demo", kind: "gotcha", content: "Close the pool in tests", files: ["src/db/pool.ts", "src/db"] }, admin);
    assert.deepEqual(await checkCitations(hive, admin, project), { flagged: 0, baselined: 2 });

    writeFileSync(path.join(dir, "src", "db", "pool.ts"), "export const pool = 2;\n");
    git(dir, "commit", "-qam", "change pool");
    assert.deepEqual(await checkCitations(hive, admin, project), { flagged: 1, baselined: 0 });
    rmSync(path.join(dir, "src", "db"), { recursive: true });
    git(dir, "commit", "-qam", "drop db");
    await checkCitations(hive, admin, project);
    const review = (await hive.call("memory.list", { project: "demo" }, admin)).find((x) => x.id === m.id)!.review!;
    assert.deepEqual([review.changed, review.missing.sort()], [[], ["src/db", "src/db/pool.ts"]]);
  });

  it("checks nothing when the branch does not exist, instead of calling every file gone", async () => {
    const dir = repo();
    assert.equal(resolveRef(dir, "release"), null);
    assert.equal(resolveRef(dir, "main"), "main");
    assert.equal(resolveRef(dir, undefined), "HEAD");
    const hive = new SqliteHive(":memory:");
    await hive.call("memory.write", { project: "demo", kind: "gotcha", content: "x", files: ["README.md"] }, admin);
    assert.equal(await checkCitations(hive, admin, { name: "demo", repo: dir, targetBranch: "release" }), null);
    assert.equal(await checkCitations(hive, admin, { name: "demo", repo: path.join(dir, "missing") }), null);
  });
});
