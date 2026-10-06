import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { diffReviewPrompt, diffReviewSelection, patchHunks, patchRisks, validDiffReview, DEFAULT_MODEL_ROUTER, type Actor } from "#core/index.ts";
import { SqliteHive, migrationIndex } from "#core/node.ts";

const patch = "diff --git a/db.ts b/db.ts\n--- a/db.ts\n+++ b/db.ts\n@@ -1 +1 @@\n-old\n+ALTER TABLE users ADD COLUMN role TEXT;\n@@ -8 +8 @@\n-safe\n+DELETE FROM users;\ndiff --git a/ui.ts b/ui.ts\n--- a/ui.ts\n+++ b/ui.ts\n@@ -1 +1 @@\n-before\n+after\n";
const review = { groups: [{ title: "Database and UI", explanation: "Update user roles.", files: ["db.ts", "ui.ts"] }], risks: [{ path: "db.ts", hunk: 1, kind: "deletion" as const, level: "high" as const, explanation: "Removes users." }] };
const admin: Actor = { name: "admin", role: "admin" };
const machine: Actor = { name: "runner@machine", role: "agent" };
const run = { runId: "R-summary", project: "demo", taskId: "T-1", taskTitle: "Demo", role: "implement" as const, status: "succeeded" as const, profileId: "claude", createdAt: "2026-10-06T01:00:00Z" };

describe("diff reviews", () => {
  it("keeps file order, exact hunk coordinates and text", () => {
    const files = patchHunks(patch);
    assert.deepEqual(files.map(f => [f.path, f.hunks.length]), [["db.ts", 2], ["ui.ts", 1]]);
    assert.equal(files[0]!.hunks[1]!.header, "@@ -8 +8 @@");
    assert.equal(files[0]!.hunks[1]!.before, "safe\n");
    assert.equal(files[0]!.hunks[1]!.after, "DELETE FROM users;\n");
    assert.deepEqual(validDiffReview(review, files), review);
    assert.equal(validDiffReview({ ...review, risks: [{ ...review.risks[0], hunk: 2 }] }, files), null);
    assert.equal(validDiffReview({ ...review, groups: [{ ...review.groups[0], files: ["db.ts"] }] }, files), null);
    assert.equal(validDiffReview({ ...review, groups: [{ ...review.groups[0], files: ["db.ts", "db.ts", "ui.ts"] }] }, files), null);
    assert.equal(validDiffReview({ ...review, groups: [{ ...review.groups[0], files: ["db.ts", "invented.ts"] }] }, files), null);
  });
  it("flags migrations, permissions, deletion, security and large files independently of AI", () => {
    const risks = patchRisks(patchHunks(patch));
    assert.ok(risks.some(r => r.kind === "migration" && r.hunk === 0 && r.level === "high"));
    assert.ok(risks.some(r => r.kind === "permissions" && r.hunk === 0));
    assert.ok(risks.some(r => r.kind === "deletion" && r.hunk === 1));
    const extra = patchHunks(`diff --git a/auth.ts b/auth.ts\n@@ -1 +1 @@\n-old\n+token ${"x".repeat(31_000)}`);
    assert.ok(patchRisks(extra).some(r => r.kind === "security"));
    assert.ok(patchRisks(extra).some(r => r.kind === "large" && r.level === "medium"));
    assert.equal(diffReviewPrompt("x".repeat(60_001)), null);
    assert.equal(diffReviewPrompt(""), null);
    assert.match(diffReviewPrompt(patch)!, /zero-based/);
  });
  it("reads quoted paths and flags metadata-only permissions and deletions", () => {
    const files = patchHunks('diff --git "a/a file.ts" "b/a file.ts"\nold mode 100644\nnew mode 100755\ndiff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\n');
    assert.equal(files[0]!.path, "a file.ts");
    assert.ok(patchRisks(files).some(r => r.kind === "permissions" && r.path === "a file.ts" && r.hunk === 0));
    assert.ok(patchRisks(files).some(r => r.kind === "deletion" && r.path === "gone.txt"));
    assert.ok(validDiffReview({ groups: [{ title: "Metadata", explanation: "", files: files.map(f => f.path) }], risks: patchRisks(files) }, files));
  });
  it("uses the configured light row regardless of project profile", () => {
    const settings = structuredClone(DEFAULT_MODEL_ROUTER);
    settings.tiers.light.codex = { model: "cheap-custom", effort: "low" };
    assert.deepEqual(diffReviewSelection(settings).models.codex, { model: "cheap-custom", effort: "low" });
    assert.equal(diffReviewSelection(settings).tier, "light");
  });
  it("persists a late summary, preserves it for old senders and invalidates it with a new patch", async () => {
    const hive = new SqliteHive(":memory:");
    try {
      await hive.call("runs.push", { machine: "machine", runs: [{ ...run, patch }] }, machine);
      await hive.call("runs.push", { machine: "machine", runs: [{ ...run, diffReview: review }] }, machine);
      const get = () => hive.call("runs.get", { machineId: machine.name, runId: run.runId }, admin);
      assert.deepEqual((await get())?.diffReview, review);
      await hive.call("runs.push", { machine: "machine", runs: [run] }, machine);
      assert.deepEqual((await get())?.diffReview, review);
      await hive.call("runs.push", { machine: "machine", runs: [{ ...run, diffReview: { ...review, risks: [{ ...review.risks[0]!, hunk: 999 }] } }] }, machine);
      assert.equal((await get())?.diffReview, null);
      await hive.call("runs.push", { machine: "machine", runs: [{ ...run, diffReview: review }] }, machine);
      await hive.call("runs.push", { machine: "machine", runs: [{ ...run, patch: "" }] }, machine);
      assert.equal((await get())?.diffReview, null);
      const viewer: Actor = { name: "outsider", role: "member", access: { projects: {} } };
      assert.equal(await hive.call("runs.get", { machineId: machine.name, runId: run.runId }, viewer), null);
    } finally { hive.close(); }
  });
  it("upgrades a database from before this migration", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hive-diff-migration-"));
    try {
      const file = path.join(dir, "hive.db");
      const before = new SqliteHive(file, { migrateTo: migrationIndex("ADD COLUMN diff_review") });
      assert.ok(!before.db.prepare("PRAGMA table_info(run_records)").all().some(row => row.name === "diff_review"));
      before.close();
      const after = new SqliteHive(file);
      assert.ok(after.db.prepare("PRAGMA table_info(run_records)").all().some(row => row.name === "diff_review"));
      after.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
