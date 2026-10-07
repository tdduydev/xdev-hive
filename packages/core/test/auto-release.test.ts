import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { SqliteHive, migrationIndex, type Actor, type GreenBatch } from "#core/node.ts";

const admin: Actor = { name: "admin", role: "admin" };
const gate: Actor = { name: "runner.gate@fixture", role: "agent" };
const batch: GreenBatch = { project: "app", batchId: "green-1", sha: "a".repeat(40), version: "1.2.3", taskIds: ["T-1"], checks: [{ name: "all project checks", passed: true }], landed: true };
async function fixture(mode: "human" | "auto" = "auto") {
  const h = new SqliteHive(":memory:");
  await h.call("tasks.create", { project: "app", id: "T-1", title: "Landed feature" }, admin);
  await h.call("tasks.update", { id: "T-1", status: "done" }, admin);
  await h.call("sdlc.setProject", { project: "app", settings: { gates: { release: mode }, releaseMachine: gate.name } }, admin);
  return h;
}

describe("60c green-batch release boundary", () => {
  it("migrates a full database by rewinding only the new migration", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hive-release-"));
    try {
      const file = path.join(dir, "db"); const h = new SqliteHive(file);
      await h.call("tasks.create", { project: "app", id: "KEEP", title: "Preserved" }, admin);
      h.db.exec(`DROP TABLE auto_releases; DROP TABLE auto_release_pauses; PRAGMA user_version = ${migrationIndex("CREATE TABLE auto_releases")}`); h.close();
      const upgraded = new SqliteHive(file, { migrateTo: migrationIndex("CREATE TABLE auto_releases") + 1 });
      assert.equal((await upgraded.call("tasks.list", { project: "app" }, admin)).length, 1);
      assert.deepEqual(await upgraded.call("autoRelease.list", { project: "app" }, admin), { releases: [], paused: false }); upgraded.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("deduplicates green events and receipts, refuses changed identity, and takes once", async () => {
    const h = await fixture(); try {
      const r = await h.call("autoRelease.green", batch, gate);
      assert.equal(r.state, "queued"); assert.deepEqual(await h.call("autoRelease.green", batch, gate), r);
      await assert.rejects(h.call("autoRelease.green", { ...batch, sha: "b".repeat(40) }, gate));
      await h.call("machines.heartbeat", { machine: "gate", instance: "aabbccdd", projects: ["app"], updateDraining: true }, gate);
      assert.equal(await h.call("autoRelease.take", { project: "app" }, gate), null, "an app update must drain without starting a release");
      await h.call("machines.heartbeat", { machine: "gate", instance: "aabbccdd", projects: ["app"], updateDraining: false }, gate);
      assert.equal((await h.call("autoRelease.take", { project: "app" }, gate))?.state, "running");
      assert.equal(await h.call("autoRelease.take", { project: "app" }, gate), null);
      const receipt = { project: "app", batchId: batch.batchId, success: true, step: "release" as const };
      const result = await h.call("autoRelease.result", receipt, gate);
      assert.deepEqual(await h.call("autoRelease.result", receipt, gate), result);
      assert.equal((await h.call("sdlc.gates", { project: "app" }, admin))[0]?.gate, "release");
    } finally { h.close(); }
  });
  it("requires the configured machine, fully green event, landed tasks and exact version identity", async () => {
    const h = await fixture(); try {
      await assert.rejects(h.call("autoRelease.green", batch, { ...gate, name: "another" }));
      await assert.rejects(h.call("autoRelease.green", { ...batch, checks: [] }, gate));
      await assert.rejects(h.call("autoRelease.green", { ...batch, landed: false as true }, gate));
      await assert.rejects(h.call("autoRelease.green", { ...batch, taskIds: ["missing"] }, gate));
      await h.call("autoRelease.green", batch, gate);
      await assert.rejects(h.call("autoRelease.green", { ...batch, batchId: "duplicate-version" }, gate));
      await assert.rejects(h.call("autoRelease.list", { project: "app" }, { name: "outsider", role: "member", access: { projects: { other: "manage" } } }));
    } finally { h.close(); }
  });
  it("holds human gates and tightened ceilings for a person with project settings permission", async () => {
    const h = await fixture(); try {
      await h.call("autoRelease.green", batch, gate);
      await h.call("sdlc.setCeiling", { ceiling: { release: "human" } }, admin);
      assert.equal(await h.call("autoRelease.take", { project: "app" }, gate), null);
      assert.equal((await h.call("autoRelease.list", { project: "app" }, admin)).releases[0]?.state, "waiting");
      await assert.rejects(h.call("autoRelease.decide", { project: "app", batchId: batch.batchId, pass: true }, gate));
      await h.call("autoRelease.decide", { project: "app", batchId: batch.batchId, pass: true }, admin);
      assert.equal((await h.call("autoRelease.take", { project: "app" }, gate))?.state, "running");
    } finally { h.close(); }
  });
  it("fails closed, creates one OPS task and stops further batches until a person resumes", async () => {
    const h = await fixture(); try {
      await h.call("autoRelease.green", batch, gate); await h.call("autoRelease.take", { project: "app" }, gate);
      const receipt = { project: "app", batchId: batch.batchId, success: false, step: "deploy" as const };
      await h.call("autoRelease.result", receipt, gate); await h.call("autoRelease.result", receipt, gate);
      assert.equal((await h.call("autoRelease.list", { project: "app" }, admin)).paused, true);
      const tasks = await h.call("tasks.list", { project: "app" }, admin);
      assert.equal(tasks.filter(t => t.id === "OPS-release-1.2.3").length, 1);
      assert.match(tasks.find(t => t.id === "OPS-release-1.2.3")!.note!, /deploy/);
      await assert.rejects(h.call("autoRelease.green", { ...batch, batchId: "green-2", version: "1.2.4" }, gate));
      await assert.rejects(h.call("autoRelease.resume", { project: "app" }, gate));
      await h.call("autoRelease.resume", { project: "app" }, admin);
      assert.equal((await h.call("autoRelease.green", { ...batch, batchId: "green-2", version: "1.2.4" }, gate)).state, "queued");
    } finally { h.close(); }
  });
  it("does not restart interrupted releases and offers human reconciliation", async () => {
    const h = await fixture(); try {
      await h.call("autoRelease.green", batch, gate); await h.call("autoRelease.take", { project: "app" }, gate);
      await assert.rejects(h.call("autoRelease.resume", { project: "app" }, admin));
      assert.equal((await h.call("autoRelease.reconcile", { project: "app", batchId: batch.batchId }, admin)).state, "failed");
      assert.equal((await h.call("autoRelease.list", { project: "app" }, admin)).paused, true);
    } finally { h.close(); }
  });
  it("tracks ordered stages, rechecks the ceiling before side effects, and records log warnings", async () => {
    const h = await fixture(); try {
      await h.call("autoRelease.green", batch, gate); await h.call("autoRelease.take", { project: "app" }, gate);
      await assert.rejects(h.call("autoRelease.progress", { project: "app", batchId: batch.batchId, step: "release" }, gate));
      await h.call("autoRelease.progress", { project: "app", batchId: batch.batchId, step: "prepare" }, gate);
      await assert.rejects(h.call("autoRelease.progress", { project: "app", batchId: batch.batchId, step: "prepare" }, gate));
      await h.call("autoRelease.progress", { project: "app", batchId: batch.batchId, step: "release" }, gate);
      await h.call("autoRelease.progress", { project: "app", batchId: batch.batchId, step: "checkLogs" }, gate);
      await h.call("autoRelease.result", { project: "app", batchId: batch.batchId, step: "checkLogs", success: true, warning: true }, gate);
      assert.equal((await h.call("autoRelease.list", { project: "app" }, admin)).paused, false);
      assert.ok((await h.call("tasks.list", { project: "app" }, admin)).some(t => t.id === "OPS-release-log-1.2.3-app"));
    } finally { h.close(); }
  });
  it("stops after a ceiling change and ignores late receipts after human reconciliation", async () => {
    const h = await fixture(); try {
      await h.call("autoRelease.green", batch, gate); await h.call("autoRelease.take", { project: "app" }, gate);
      await h.call("autoRelease.progress", { project: "app", batchId: batch.batchId, step: "prepare" }, gate);
      await h.call("sdlc.setCeiling", { ceiling: { release: "human" } }, admin);
      await assert.rejects(h.call("autoRelease.progress", { project: "app", batchId: batch.batchId, step: "release" }, gate));
      await h.call("autoRelease.result", { project: "app", batchId: batch.batchId, success: false, step: "release" }, gate);
      assert.equal((await h.call("autoRelease.list", { project: "app" }, admin)).paused, true);
    } finally { h.close(); }
    const h2 = await fixture(); try {
      await h2.call("autoRelease.green", batch, gate); await h2.call("autoRelease.take", { project: "app" }, gate);
      await h2.call("autoRelease.reconcile", { project: "app", batchId: batch.batchId }, admin);
      const r = await h2.call("autoRelease.result", { project: "app", batchId: batch.batchId, success: true, step: "release" }, gate);
      assert.equal(r.state, "failed"); assert.equal(r.reconciled, true);
      assert.equal((await h2.call("autoRelease.list", { project: "app" }, admin)).paused, true);
    } finally { h2.close(); }
  });

  it("honors stop-all before taking a release and before each new step", async () => {
    const h = await fixture(); try {
      await h.call("autoRelease.green", batch, gate);
      await h.call("agents.stop", { project: "app" }, admin);
      await assert.rejects(h.call("autoRelease.take", { project: "app" }, gate));
      await h.call("agents.resume", { project: "app" }, admin);
      await h.call("autoRelease.take", { project: "app" }, gate);
      await h.call("agents.stop", { project: "app" }, admin);
      await assert.rejects(h.call("autoRelease.progress", { project: "app", batchId: batch.batchId, step: "prepare" }, gate));
      await h.call("autoRelease.result", { project: "app", batchId: batch.batchId, success: false, step: "prepare" }, gate);
      assert.equal((await h.call("autoRelease.list", { project: "app" }, admin)).paused, true);
    } finally { h.close(); }
  });

});
