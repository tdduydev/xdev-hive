import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { type Actor } from "#core/index.ts";
import { SqliteHive, migrationIndex } from "#core/node.ts";

const admin: Actor = { name: "duy", role: "admin" };

describe("task audit from application windows", () => {
  for (const via of ["web", "desktop"] as const) {
    it(`records status, note and agent changes from ${via} with their actor and source`, async () => {
      const hive = new SqliteHive(":memory:");
      const person: Actor = {
        name: "lan", role: "member", access: { projects: { app: "lead" } },
        source: { via, ...(via === "desktop" ? { machine: "lan-mbp" } : {}) },
        ...(via === "desktop" ? { agent: "desktop", onBehalf: "lan" } : {}),
      };
      try {
        await hive.call("tasks.create", { id: "T-1", project: "app", title: "Task" }, admin);
        await hive.call("tasks.update", { id: "T-1", status: "review" }, person);
        await hive.call("tasks.update", { id: "T-1", status: "review", note: "Bàn giao" }, person);
        await hive.call("tasks.update", { id: "T-1", status: "review", note: "" }, person);
        await hive.call("machines.heartbeat", { machine: "lan-mbp", instance: "a1b2c3d4", projects: ["app"], acceptsRuns: true }, { name: "runner@lan-mbp", role: "agent" });
        await hive.call("tasks.assign", { id: "T-1", machineId: "runner@lan-mbp" }, person);
        await hive.call("tasks.unassign", { id: "T-1" }, person);
        const rows = (await hive.call("admin.audit", { user: "lan" }, admin)).reverse();
        assert.deepEqual(rows.map((r) => [r.action, r.target, r.detailKey]), [
          ["tasks.update", "T-1", "audit.taskStatus"],
          ["tasks.update", "T-1", "audit.taskStatusNote"],
          ["tasks.update", "T-1", "audit.taskStatusNote"],
          ["tasks.assign", "T-1", "audit.taskAssign"],
          ["tasks.unassign", "T-1", "audit.taskUnassign"],
        ]);
        for (const row of rows) {
          assert.equal(row.actor, person.name);
          assert.equal(row.onBehalf, person.onBehalf ?? null);
          assert.deepEqual(row.source, person.source);
          assert.equal(row.agent, null, "a window label is not an agent");
        }
        assert.deepEqual(rows[0]!.detailVars, { status: "review" });
        assert.equal((await hive.call("tasks.list", { project: "app" }, admin))[0]!.note, "");
        await assert.rejects(hive.call("tasks.update", { id: "missing", status: "review" }, person));
        await assert.rejects(hive.call("tasks.update", { id: "T-1", status: "todo" }, { ...person, access: { projects: { app: "viewer" } } }));
        assert.equal((await hive.call("admin.audit", { user: "lan" }, admin)).length, rows.length, "failed writes have no success audit");
      } finally {
        hive.close();
      }
    });
  }

  it("upgrades historical audit rows without inventing their source", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hive-task-audit-"));
    const file = path.join(dir, "hive.db");
    try {
      const before = new SqliteHive(file, { migrateTo: migrationIndex("ALTER TABLE audit ADD COLUMN source") });
      await before.call("tasks.create", { id: "T-1", project: "app", title: "Task" }, admin);
      before.close();
      const after = new SqliteHive(file);
      try {
        assert.equal((await after.call("admin.audit", {}, admin))[0]!.source, null);
        const actor: Actor = { ...admin, source: { via: "desktop", machine: "duy-mbp" } };
        await after.call("tasks.update", { id: "T-1", status: "review" }, actor);
        const rows = await after.call("admin.audit", {}, admin);
        assert.deepEqual(rows[0]!.source, actor.source);
        assert.equal(rows[1]!.source, null);
      } finally {
        after.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
