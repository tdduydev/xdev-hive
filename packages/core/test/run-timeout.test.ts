import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_RUN_TIMEOUT, HiveError, type Actor } from "#core/index.ts";
import { SqliteHive, migrationIndex } from "#core/node.ts";

const admin: Actor = { name: "admin", role: "admin" };
const runner: Actor = { name: "runner.test", role: "agent" };
const profile = (id: string, timeoutMinutes?: number) => ({ id, label: id, kind: "codex", enabled: true, installed: true, account: null, cooldownUntil: null, runs: 0, rateLimited: 0, timeoutMinutes });
async function setup() {
  const hive = new SqliteHive(":memory:");
  const beat = () => hive.call("machines.heartbeat", { machine: "test", instance: "aabbccdd", projects: ["demo"], acceptsRuns: true, profiles: [profile("short", 60), profile("long", 240)] }, runner);
  await beat();
  for (const id of ["T-1", "INT-1", "LAND-1", "INT-2", "LAND-2"]) await hive.call("tasks.create", { id, project: "demo", title: "Task", kind: "feature" }, admin);
  const dispatch = (taskId: string, profileId: string | null = "long", timeoutMinutes?: number) => hive.call("runs.dispatch", { project: "demo", taskId, machineId: runner.name, profileId, timeoutMinutes }, admin);
  return { hive, beat, dispatch };
}

describe("run timeout", () => {
  it("uses type defaults, the profile's default, and the hub ceiling, delivered through heartbeat", async () => {
    const { hive, beat, dispatch } = await setup();
    try {
      assert.deepEqual(await hive.call("runs.timeoutSettings", {}, admin), DEFAULT_RUN_TIMEOUT);
      assert.equal((await dispatch("T-1")).timeoutMinutes, 180);
      assert.equal((await dispatch("INT-1")).timeoutMinutes, 120);
      assert.equal((await dispatch("LAND-1")).timeoutMinutes, 120);
      assert.equal((await dispatch("INT-2", "short")).timeoutMinutes, 60);
      assert.equal((await dispatch("LAND-2", null, 150)).timeoutMinutes, 150);
      assert.deepEqual((await beat()).runRequests.map((r) => r.timeoutMinutes), [180, 120, 120, 60, 150]);
    } finally { hive.close(); }
  });

  it("rejects explicit values beyond the hub or pinned profile and validates input", async () => {
    const { hive, dispatch } = await setup();
    try {
      for (const [p, minutes] of [["long", 181], ["short", 61]] as const) {
        await assert.rejects(dispatch("T-1", p, minutes), (e: unknown) => e instanceof HiveError && e.key === "errors.runTimeoutCeiling");
      }
      for (const minutes of [0, -1, 1.5, 721]) await assert.rejects(dispatch("T-1", "long", minutes));
      assert.equal(hive.db.prepare("SELECT count(*) AS n FROM run_requests").get()?.n, 0);
      assert.equal((await dispatch("T-1", "short", 30)).timeoutMinutes, 30);
    } finally { hive.close(); }
  });

  it("allows only hub admins to change the table and preserves profile defaults when blank", async () => {
    const { hive, dispatch } = await setup();
    try {
      for (const actor of [runner, { name: "lead", role: "admin", access: { projects: { demo: "manage" } } } as Actor]) {
        await assert.rejects(hive.call("runs.setTimeoutSettings", DEFAULT_RUN_TIMEOUT, actor));
      }
      await hive.call("runs.setTimeoutSettings", { maxMinutes: 300, defaults: { integration: 200, land: null } }, admin);
      assert.equal((await dispatch("INT-1")).timeoutMinutes, 200);
      assert.equal((await dispatch("LAND-1")).timeoutMinutes, 240);
      assert.equal((await dispatch("T-1")).timeoutMinutes, 240);
      assert.equal((await hive.call("admin.audit", { action: "runs.setTimeoutSettings" }, admin)).length, 1);
      await hive.call("runs.setTimeoutSettings", { maxMinutes: 80, defaults: { integration: 200, land: 120 } }, admin);
      assert.equal((await dispatch("INT-2")).timeoutMinutes, 80);
      assert.equal((await dispatch("LAND-2", "short")).timeoutMinutes, 60);
    } finally { hive.close(); }
  });

  it("uses the historical profile timeout for old heartbeats", async () => {
    const { hive, dispatch } = await setup();
    try {
      await hive.call("machines.heartbeat", { machine: "test", instance: "aabbccdd", profiles: [profile("old")] }, runner);
      assert.equal((await dispatch("INT-1", "old")).timeoutMinutes, 60);
    } finally { hive.close(); }
  });

  it("migrates existing requests without changing their historical timeout", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hive-timeout-"));
    const file = path.join(dir, "hive.db");
    try {
      const before = migrationIndex("ALTER TABLE run_requests ADD COLUMN timeout_minutes");
      // Start from the historical schema: rewinding user_version on today's schema replays later migrations too.
      const hive = new SqliteHive(file, { migrateTo: before });
      let requestId: number;
      try {
        const at = new Date().toISOString();
        const inserted = hive.db.prepare(`INSERT INTO run_requests(machine_id, machine, project, task_id, task_title,
          role, requested_by, requested_at, updated_at) VALUES (?, 'test', 'demo', 'T-1', 'Task', 'implement', 'admin', ?, ?)`).run(runner.name, at, at);
        requestId = Number(inserted.lastInsertRowid);
      } finally { hive.close(); }
      const upgraded = new SqliteHive(file);
      try {
        assert.equal((await upgraded.call("runs.requests", { project: "demo" }, admin)).find((r) => r.id === requestId)?.timeoutMinutes, null);
      } finally { upgraded.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
