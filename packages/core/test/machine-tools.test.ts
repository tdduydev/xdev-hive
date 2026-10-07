import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HiveError, toolHash, type Actor, type MachineToolState } from "#core/index.ts";
import { SqliteHive, migrationIndex } from "#core/node.ts";

const admin: Actor = { name: "admin", role: "admin" };
const owner: Actor = { name: "owner", account: "owner", role: "viewer", access: { projects: { app: "viewer" } } };
const machine: Actor = { name: "runner.hidden@owner", account: "owner", role: "agent", access: owner.access };
const other: Actor = { name: "member", account: "member", role: "member", access: { projects: { app: "lead" } } };

async function fixture() {
  const hive = new SqliteHive(":memory:");
  const original = (await hive.call("tools.list", {}, admin)).find((e) => e.id === "rtk")!;
  const entry = { ...original, enabledByDefault: true };
  await hive.call("tools.save", { entry, baseVersion: original.version }, admin);
  const states: MachineToolState[] = [{ id: entry.id, hash: toolHash(entry), trust: "new" }];
  const beat = (input = {}) => hive.call("machines.heartbeat", { machine: "hidden", instance: "aaaaaaaa", projects: ["app"], acceptsRuns: false, toolStates: states, ...input }, machine);
  await beat();
  const request = { machineId: machine.name, toolId: entry.id, hash: toolHash(entry) };
  return { hive, entry, states, beat, request };
}

const error = (key: string) => (e: unknown) => e instanceof HiveError && e.key === key;

describe("web tool approvals (58b)", () => {
  it("allows a human hub admin or owner, denies project managers, members and agents, and audits the decision", async () => {
    const { hive, request, beat } = await fixture();
    try {
      for (const actor of [other, { ...other, role: "admin" as const }, machine, { ...admin, source: { via: "mcp" as const } }, { ...admin, role: "agent" as const }]) {
        assert.equal((await hive.call("machines.tools", { machineId: machine.name }, actor)).canApprove, false);
        await assert.rejects(hive.call("machines.approveTool", request, actor), error("errors.machineToolForbidden"));
      }
      const approval = await hive.call("machines.approveTool", request, owner);
      assert.equal(approval.approvedBy, "owner");
      assert.ok(approval.approvedAt);
      assert.deepEqual(await hive.call("machines.approveTool", request, admin), approval);
      assert.equal((await beat()).toolApprovals[0]?.id, approval.id, "headless machine receives it even without accepting runs");
      const audit = await hive.call("admin.audit", { action: "machines.approveTool" }, admin);
      assert.equal(audit[0]?.detailKey, "audit.toolApproved");
      assert.equal(audit[0]?.target, `${machine.name}/rtk`);
      // Another machine cannot acknowledge this decision.
      await hive.call("machines.heartbeat", { machine: "other", instance: "bbbbbbbb", appliedToolApprovals: [approval.id] }, { name: "runner.other@owner", role: "agent" });
      assert.equal((await beat()).toolApprovals.length, 1);
      assert.equal((await beat({ appliedToolApprovals: [approval.id] })).toolApprovals.length, 0);
      const status = await hive.call("machines.tools", { machineId: machine.name }, other);
      assert.ok(status.tools[0]?.approval?.appliedAt);
    } finally { hive.close(); }
  });

  it("rejects stale hashes and removed or unknown entries; command and package changes require another approval", async () => {
    const { hive, entry, request, beat } = await fixture();
    try {
      await hive.call("machines.approveTool", request, admin);
      const changed = { ...entry, check: ["rtk", "--help"] };
      const saved = await hive.call("tools.save", { entry: changed, baseVersion: 2 }, admin);
      assert.equal((await beat()).toolApprovals.length, 0);
      await assert.rejects(hive.call("machines.approveTool", request, owner), error("errors.machineToolChanged"));
      let status = (await hive.call("machines.tools", { machineId: machine.name }, other)).tools[0]!;
      assert.equal(status.trust, "changed");
      assert.equal(status.approval, null);
      await hive.call("machines.approveTool", { ...request, hash: status.hash }, owner);
      const bumped = { ...changed, package: { ...changed.package!, version: "0.99.0" } };
      await hive.call("tools.save", { entry: bumped, baseVersion: saved.version }, admin);
      assert.equal((await beat()).toolApprovals.length, 0);
      status = (await hive.call("machines.tools", { machineId: machine.name }, owner)).tools[0]!;
      await hive.call("machines.approveTool", { ...request, hash: status.hash }, owner);
      await hive.call("tools.remove", { id: "rtk" }, admin);
      assert.deepEqual((await beat()).toolApprovals, []);
      await assert.rejects(hive.call("machines.approveTool", request, owner), error("errors.toolNotFound"));
      await assert.rejects(hive.call("machines.approveTool", { ...request, toolId: "unknown" }, owner), error("errors.toolNotFound"));
    } finally { hive.close(); }
  });

  it("keeps approvals for metadata edits, exposes old apps read-only, and gives unknown machines a clear error", async () => {
    const { hive, entry, request, beat } = await fixture();
    try {
      const approval = await hive.call("machines.approveTool", request, admin);
      await hive.call("tools.save", { entry: { ...entry, name: "RTK renamed" }, baseVersion: 2 }, admin);
      assert.equal((await beat()).toolApprovals[0]?.id, approval.id);
      const old = { name: "runner.old@owner", account: "owner", role: "agent" as const };
      await hive.call("machines.heartbeat", { machine: "old", instance: "cccccccc" }, old);
      assert.equal((await hive.call("machines.tools", { machineId: old.name }, owner)).supported, false);
      await assert.rejects(hive.call("machines.approveTool", { ...request, machineId: old.name }, owner), error("errors.machineAppTooOld"));
      await assert.rejects(hive.call("machines.tools", { machineId: "unknown" }, admin), error("errors.machineNotFound"));
    } finally { hive.close(); }
  });

  it("migrates existing machines without inventing approval or support", async () => {
    const hive = new SqliteHive(":memory:");
    await hive.call("machines.heartbeat", { machine: "hidden", instance: "aaaaaaaa" }, machine);
    const db = hive.db;
    // Build the complete DB first, then return only this migration's schema to its old state. No new handler runs
    // until the next constructor has finished all migrations.
    db.exec(`DROP TABLE machine_tool_approvals; ALTER TABLE machines DROP COLUMN tool_states; PRAGMA user_version = ${migrationIndex("CREATE TABLE machine_tool_approvals(")}`);
    // Only this migration runs again: later ones already shaped the DB.
    const upgraded = new SqliteHive(db, { migrateTo: migrationIndex("CREATE TABLE machine_tool_approvals(") + 1 });
    try {
      assert.equal((await upgraded.call("machines.list", {}, admin))[0]?.machine, "hidden");
      assert.deepEqual(await upgraded.call("machines.tools", { machineId: machine.name }, owner), { supported: false, canApprove: true, tools: [] });
      assert.equal(db.prepare("SELECT count(*) AS n FROM machine_tool_approvals").get()?.n, 0);
    } finally { upgraded.close(); }
  });
});
