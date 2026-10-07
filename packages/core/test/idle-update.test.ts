import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HiveError, type Actor } from "#core/index.ts";
import { SqliteHive, migrationIndex } from "#core/node.ts";

const admin: Actor = { name: "duy", role: "admin" };
const machine: Actor = { name: "runner.mac@mac", role: "agent" };
const run = { runId: "R-1", project: "demo", taskId: "T-1", taskTitle: "Page", role: "implement" as const, status: "running" as const, profileId: "p1", createdAt: "2026-10-07T00:00:00Z" };
const beat = (hive: SqliteHive, extra = {}) => hive.call("machines.heartbeat", { machine: "mac", instance: "abcdef01", acceptsRuns: true, projects: ["demo"], ...extra }, machine);
const noIntake = (e: unknown) => e instanceof HiveError && e.key === "errors.machineNoHubRuns";

describe("hub intake during idle update", () => {
  it("keeps new work pending and allows new steering/cancellation until consent is revoked", async () => {
    const hive = new SqliteHive(":memory:");
    try {
      await hive.call("tasks.create", { id: "T-1", project: "demo", title: "Page", kind: "feature" }, admin);
      await beat(hive);
      await hive.call("runs.push", { machine: "mac", runs: [run] }, machine);
      const request = await hive.call("runs.dispatch", { machineId: machine.name, project: "demo", taskId: "T-1" }, admin);
      const held = await beat(hive, { acceptsRuns: false, updateDraining: true });
      assert.deepEqual(held.runRequests, []);
      assert.equal((await hive.call("runs.requests", {}, admin))[0]!.status, "pending");
      await assert.rejects(hive.call("runs.dispatch", { machineId: machine.name, project: "demo", taskId: "T-1" }, admin), noIntake);
      const steer = await hive.call("runs.steer", { machineId: machine.name, runId: run.runId, text: "Finish the existing run" }, admin);
      await hive.call("runs.cancel", { machineId: machine.name, runId: run.runId }, admin);
      const controls = await beat(hive, { acceptsRuns: false, updateDraining: true });
      assert.deepEqual(controls.runMessages, [steer]);
      assert.deepEqual(controls.cancelRuns, [{ runId: run.runId, requestedBy: admin.name }]);
      assert.equal((await beat(hive)).runRequests[0]!.id, request.id);
      await beat(hive, { acceptsRuns: false });
      await assert.rejects(hive.call("runs.steer", { machineId: machine.name, runId: run.runId, text: "No consent" }, admin), noIntake);
      await assert.rejects(hive.call("runs.cancel", { machineId: machine.name, runId: run.runId }, admin), noIntake);
    } finally { hive.close(); }
  });

  it("upgrades the complete main schema without changing machines, runs or earlier migrations", async () => {
    const hive = new SqliteHive(":memory:");
    try {
      await beat(hive);
      await hive.call("runs.push", { machine: "mac", runs: [run] }, machine);
      const version = Number(hive.db.prepare("PRAGMA user_version").get()!.user_version);
      const index = migrationIndex("ALTER TABLE machines ADD COLUMN update_draining");
      assert.equal(index, version - 1, "update drain is appended after main's migrations");
      hive.db.exec(`ALTER TABLE machines DROP COLUMN update_draining; PRAGMA user_version = ${index}`);
      const upgraded = new SqliteHive(hive.db);
      assert.equal(Number(upgraded.db.prepare("PRAGMA user_version").get()!.user_version), version);
      assert.equal(upgraded.db.prepare("SELECT update_draining FROM machines").get()!.update_draining, 0);
      assert.equal((await upgraded.call("runs.get", { machineId: machine.name, runId: run.runId }, admin))!.status, "running");
      assert.equal((await beat(upgraded, { acceptsRuns: false, updateDraining: true })).supportsUpdateDrain, true);
      await upgraded.call("runs.steer", { machineId: machine.name, runId: run.runId, text: "Still steerable" }, admin);
    } finally { hive.close(); }
  });
});
