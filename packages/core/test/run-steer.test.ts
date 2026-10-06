import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { HiveError, type Actor } from "#core/index.ts";
import { SqliteHive, migrationIndex } from "#core/node.ts";

const admin: Actor = { name: "duy", role: "admin" };
const machine: Actor = { name: "runner.mac@mac", role: "agent" };
const other: Actor = { name: "runner.other@other", role: "agent" };
const lead: Actor = { name: "lan", role: "member", access: { projects: { demo: "manage" } } };
const viewer: Actor = { name: "hoa", role: "member", access: { projects: { demo: "view" } } };
const run = { runId: "R-1", project: "demo", taskId: "T-1", taskTitle: "Page", role: "implement" as const, status: "running" as const, profileId: "p1", createdAt: "2026-10-06T00:00:00Z" };
const fails = (key: string) => (e: unknown) => e instanceof HiveError && e.key === key;
const beat = (hive: SqliteHive, actor = machine, extra = {}) => hive.call("machines.heartbeat", { machine: "mac", instance: "abcdef01", acceptsRuns: true, projects: ["demo"], ...extra }, actor);
const send = (hive: SqliteHive, actor = lead, text = "Kiểm tra mobile\nGiữ màu hiện có") => hive.call("runs.steer", { machineId: machine.name, runId: "R-1", text }, actor);
async function setup() {
  const hive = new SqliteHive(":memory:");
  await beat(hive);
  await hive.call("runs.push", { machine: "mac", runs: [run] }, machine);
  return hive;
}

describe("run steering", () => {
  it("repeats ordered messages until acknowledged by the owning machine; history survives completion", async () => {
    const hive = await setup();
    const first = await send(hive);
    const second = await send(hive, lead, "Không push");
    assert.equal(first.deliveredAt, null);
    assert.deepEqual((await beat(hive)).runMessages, [first, second]);
    assert.deepEqual((await beat(hive)).runMessages, [first, second]);
    assert.deepEqual((await beat(hive, other, { deliveredMessages: [first.id] })).runMessages, []);
    assert.deepEqual((await beat(hive)).runMessages, [first, second]);
    assert.deepEqual((await beat(hive, machine, { deliveredMessages: [first.id] })).runMessages, [second]);
    const get = () => hive.call("runs.get", { machineId: machine.name, runId: "R-1" }, lead);
    const at = (await get())!.messages![0]!.deliveredAt;
    assert.ok(at);
    await beat(hive, machine, { deliveredMessages: [first.id, second.id] });
    assert.equal((await get())!.messages![0]!.deliveredAt, at);
    await hive.call("runs.push", { machine: "mac", runs: [{ ...run, status: "succeeded" }] }, machine);
    assert.equal((await get())!.messages!.length, 2);
    assert.equal((await hive.call("runs.list", {}, lead))[0]!.messages, undefined);
    hive.close();
  });

  it("requires runDispatch, visibility, a running run, and machine consent; rejects unsafe or empty text", async () => {
    const hive = await setup();
    await assert.rejects(send(hive, viewer), fails("errors.need.runDispatch"));
    const hidden: Actor = { ...lead, access: { projects: { elsewhere: "manage" } } };
    await assert.rejects(send(hive, hidden), fails("errors.notFound"));
    assert.equal(await hive.call("runs.get", { machineId: machine.name, runId: "R-1" }, hidden), null);
    await beat(hive, machine, { acceptsRuns: false });
    await assert.rejects(send(hive), fails("errors.machineNoHubRuns"));
    await beat(hive);
    await assert.rejects(send(hive, lead, "   "));
    await assert.rejects(send(hive, lead, "x".repeat(8001)));
    await assert.rejects(send(hive, lead, `glpat-${"x".repeat(24)}`));
    await assert.rejects(send(hive, lead, "a\u202eb"));
    for (const status of ["queued", "succeeded", "cancelled", "failed"] as const) {
      await hive.call("runs.push", { machine: "mac", runs: [{ ...run, status }] }, machine);
      await assert.rejects(send(hive), fails("errors.runNotRunning"));
    }
    hive.close();
  });

  it("withholds pending messages after consent is revoked, permissions removed, or a run ends", async () => {
    const hive = await setup();
    await send(hive);
    assert.deepEqual((await beat(hive, machine, { acceptsRuns: false })).runMessages, []);
    const restricted = { ...machine, access: { projects: { elsewhere: "contribute" as const } } };
    assert.deepEqual((await beat(hive, restricted)).runMessages, []);
    await hive.call("runs.push", { machine: "mac", runs: [{ ...run, status: "succeeded" }] }, machine);
    assert.deepEqual((await beat(hive)).runMessages, []);
    hive.close();
  });

  it("keeps archived runs readable but refuses new instructions", async () => {
    const hive = await setup();
    await send(hive);
    await hive.call("projects.archive", { project: "demo" }, admin);
    await assert.rejects(send(hive, admin), fails("errors.projectArchived"));
    assert.deepEqual((await beat(hive)).runMessages, []);
    hive.close();
  });

  it("does not reuse delivery ids after a run is deleted", async () => {
    const hive = await setup();
    const first = await send(hive);
    hive.db.prepare("DELETE FROM run_records WHERE run_id = ?").run("R-1");
    assert.equal(hive.db.prepare("SELECT id FROM run_messages").get(), undefined);
    await hive.call("runs.push", { machine: "mac", runs: [run] }, machine);
    assert.ok((await send(hive)).id > first.id);
    hive.close();
  });

  it("adds the migration to an existing database without losing runs or assuming it is last", async (t) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hive-steer-migrate-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "hub.db");
    const before = migrationIndex("CREATE TABLE run_messages");
    const hive = new SqliteHive(file, { migrateTo: before });
    assert.equal(hive.db.prepare("SELECT name FROM sqlite_master WHERE name = 'run_messages'").get(), undefined);
    await hive.call("runs.push", { machine: "mac", runs: [run] }, machine);
    hive.close();
    const current = new SqliteHive(file, { migrateTo: before + 1 });
    assert.ok(current.db.prepare("SELECT name FROM sqlite_master WHERE name = 'run_messages'").get());
    assert.equal((await current.call("runs.get", { machineId: machine.name, runId: "R-1" }, admin))?.status, "running");
    await beat(current);
    assert.equal((await send(current)).runId, "R-1");
    current.close();
  });
});
