import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HiveError, worktreeCleanupSchema, type Actor, type WorktreeReport } from "#core/index.ts";
import { SqliteHive, migrationIndex } from "#core/node.ts";

const admin: Actor = { name: "admin", role: "admin" };
const owner: Actor = { name: "owner", account: "owner", role: "viewer", access: { projects: { demo: "viewer" } } };
const machine: Actor = { name: "runner.mac@owner", account: "owner", role: "agent", access: owner.access };
const report = (): WorktreeReport => ({ measuredAt: new Date().toISOString(), totalBytes: 4096, freeBytes: 1024 ** 3, cleanup: worktreeCleanupSchema.parse({}), logs: [], errors: [], entries: [{
  project: "demo", taskId: "T-1", taskStatus: "done", taskUpdatedAt: new Date().toISOString(), path: "/work/demo/T-1", branch: "ai/T-1", head: "a".repeat(40), fingerprint: "b".repeat(64), bytes: 4096, modifiedAt: new Date().toISOString(), dirty: false, merged: true, pushed: true, active: false, error: null,
}] });
const isError = (key: string) => (err: unknown) => err instanceof HiveError && err.key === key;

describe("worktree administration (63f)", () => {
  it("restricts reads and destructive commands to a human machine owner or hub admin, with audit and machine-bound receipts", async () => {
    const hive = new SqliteHive(":memory:");
    try {
      const beat = (input = {}) => hive.call("machines.heartbeat", { machine: "mac", instance: "aaaaaaaa", projects: ["demo"], acceptsRuns: false, worktrees: report(), ...input }, machine);
      await beat();
      const target = report().entries[0]!;
      for (const actor of [machine, { ...admin, source: { via: "mcp" as const } }, { name: "lead", account: "lead", role: "admin" as const, access: owner.access }]) {
        await assert.rejects(hive.call("machines.worktrees", { machineId: machine.name }, actor), isError("errors.worktreeForbidden"));
        await assert.rejects(hive.call("machines.manageWorktrees", { machineId: machine.name, targets: [target] }, actor), isError("errors.worktreeForbidden"));
      }
      const command = await hive.call("machines.manageWorktrees", { machineId: machine.name, targets: [target] }, owner);
      assert.equal((await beat()).worktreeCommands[0]?.id, command.id, "commands work even when hub intake is off");
      assert.equal((await hive.call("admin.audit", { action: "machines.manageWorktrees" }, admin))[0]?.target, machine.name);
      const result = { id: command.id, results: [{ path: target.path, ok: false, error: "changed" }] };
      await hive.call("machines.heartbeat", { machine: "other", instance: "bbbbbbbb", worktreeResults: [result] }, { name: "runner.other@owner", role: "agent" });
      assert.equal((await beat()).worktreeCommands.length, 1);
      assert.equal((await beat({ worktreeResults: [result] })).worktreeCommands.length, 0);
      const access = await hive.call("machines.worktrees", { machineId: machine.name }, admin);
      assert.ok(access.commands[0]?.completedAt);
      assert.deepEqual(access.commands[0]?.results, result.results);
    } finally { hive.close(); }
  });

  it("rejects stale, dirty/unmerged without confirmation, and active worktrees even with force", async () => {
    const hive = new SqliteHive(":memory:");
    try {
      const snapshot = report();
      const entry = snapshot.entries[0]!;
      const beat = () => hive.call("machines.heartbeat", { machine: "mac", instance: "aaaaaaaa", worktrees: snapshot }, machine);
      const remove = (fingerprint = entry.fingerprint, force = false) => hive.call("machines.manageWorktrees", { machineId: machine.name, targets: [{ ...entry, fingerprint }], force }, owner);
      await beat();
      await assert.rejects(remove("0".repeat(64)), isError("errors.worktreeChanged"));
      entry.dirty = true; await beat();
      await assert.rejects(remove(), isError("errors.worktreeConfirm"));
      await remove(entry.fingerprint, true);
      entry.dirty = false; entry.merged = null; await beat();
      await assert.rejects(remove(), isError("errors.worktreeConfirm"));
      entry.active = true; await beat();
      await assert.rejects(remove(entry.fingerprint, true), isError("errors.worktreeActive"));
      const cleanup = await hive.call("machines.manageWorktrees", { machineId: machine.name, cleanup: { enabled: false, retentionDays: 7, minFreeGb: 20 } }, owner);
      assert.equal(cleanup.cleanup?.enabled, false);
      assert.deepEqual(cleanup.targets, []);
    } finally { hive.close(); }
  });

  it("does not expose another service's paths and does not invent support on old machines", async () => {
    const hive = new SqliteHive(":memory:");
    try {
      await hive.call("machines.heartbeat", { machine: "mac", instance: "aaaaaaaa" }, machine);
      assert.equal((await hive.call("machines.worktrees", { machineId: machine.name }, owner)).supported, false);
      await assert.rejects(hive.call("machines.manageWorktrees", { machineId: machine.name, cleanup: {} }, owner), isError("errors.machineAppTooOld"));
      const snapshot = report(); snapshot.entries.push({ ...snapshot.entries[0]!, project: "secret", path: "/private/secret" });
      await hive.call("machines.heartbeat", { machine: "mac", instance: "aaaaaaaa", worktrees: snapshot }, machine);
      const stored = String((hive.db.prepare("SELECT worktrees FROM machines WHERE id = ?").get(machine.name) as { worktrees: string }).worktrees);
      assert.ok(!stored.includes("/private/secret"), "the hub keeps no path of a project outside the machine's grant");
      assert.equal(JSON.parse(stored).totalBytes, 4096);
      const access = await hive.call("machines.worktrees", { machineId: machine.name }, owner);
      assert.equal(access.report?.entries.length, 1);
      assert.equal(access.report?.totalBytes, 4096);
      await assert.rejects(hive.call("machines.manageWorktrees", { machineId: machine.name, targets: [snapshot.entries[1]!] }, owner), isError("errors.worktreeChanged"));
    } finally { hive.close(); }
  });

  it("checks active runs and pending requests before applying the history limit", async () => {
    const hive = new SqliteHive(":memory:");
    try {
      const snapshot = report();
      await hive.call("machines.heartbeat", { machine: "mac", instance: "aaaaaaaa", worktrees: snapshot }, machine);
      const now = new Date().toISOString();
      const insertRun = hive.db.prepare("INSERT INTO run_records(machine_id, run_id, machine, project, task_id, task_title, role, status, created_at, updated_at) VALUES (?, ?, 'mac', 'demo', 'T-1', 'Task', 'implement', ?, ?, ?)");
      const insertRequest = hive.db.prepare("INSERT INTO run_requests(machine_id, machine, project, task_id, task_title, role, status, requested_by, requested_at, updated_at) VALUES (?, 'mac', 'demo', 'T-1', 'Task', 'implement', ?, 'owner', ?, ?)");
      insertRun.run(machine.name, "old-active", "running", "2000-01-01T00:00:00.000Z", now);
      insertRequest.run(machine.name, "pending", now, now);
      for (let i = 0; i < 205; i++) {
        insertRun.run(machine.name, `new-${i}`, "succeeded", now, now);
        insertRequest.run(machine.name, "accepted", now, now);
      }
      assert.equal((await hive.call("runs.list", { project: "demo", taskId: "T-1", limit: 200 }, machine)).some(r => r.status === "running"), false);
      assert.equal((await hive.call("runs.requests", { project: "demo", limit: 200 }, machine)).some(r => r.status === "pending"), false);
      assert.equal((await hive.call("runs.list", { project: "demo", taskId: "T-1", activeOnly: true, limit: 1 }, machine))[0]?.runId, "old-active");
      assert.equal((await hive.call("runs.requests", { project: "demo", taskId: "T-1", pendingOnly: true, limit: 1 }, machine))[0]?.status, "pending");
      const remove = () => hive.call("machines.manageWorktrees", { machineId: machine.name, targets: snapshot.entries, force: true }, owner);
      await assert.rejects(remove(), isError("errors.worktreeActive"));
      hive.db.prepare("UPDATE run_records SET status = 'succeeded' WHERE run_id = 'old-active'").run();
      await assert.rejects(remove(), isError("errors.worktreeActive"));
      hive.db.prepare("UPDATE run_requests SET status = 'accepted' WHERE status = 'pending'").run();
      await remove();
    } finally { hive.close(); }
  });

  it("upgrades the worktree schema without fabricating an inventory", async () => {
    const hive = new SqliteHive(":memory:");
    await hive.call("machines.heartbeat", { machine: "mac", instance: "aaaaaaaa" }, machine);
    const db = hive.db;
    const before = migrationIndex("CREATE TABLE machine_worktree_commands(");
    db.exec(`DROP TABLE machine_worktree_commands; ALTER TABLE machines DROP COLUMN worktrees; PRAGMA user_version = ${before}`);
    // Later migrations already exist in this DB; replay only the worktree step.
    const upgraded = new SqliteHive(db, { migrateTo: before + 1 });
    try { assert.equal((await upgraded.call("machines.worktrees", { machineId: machine.name }, owner)).report, null); }
    finally { upgraded.close(); }
  });
});
