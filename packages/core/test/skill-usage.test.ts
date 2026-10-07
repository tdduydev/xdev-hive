import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteHive, migrationIndex } from "#core/node.ts";
import type { Actor } from "#core/index.ts";
const admin: Actor = { name: "admin", role: "admin" };
const viewer: Actor = { name: "reader", role: "member", access: { projects: { app: "view" } } };
const machine: Actor = { name: "runner.machine", role: "agent" };
const now = "2026-10-06T12:00:00.000Z";
const run = (runId: string, project: string, at: string, skills?: string[]) => ({ runId, project, taskId: "T-1", taskTitle: "x", role: "implement" as const, status: "succeeded" as const, profileId: null, createdAt: at, startedAt: at, finishedAt: at, skills });

it("counts distinct runs, 30-day boundaries and UTC weeks without exposing hidden projects", async (t) => {
  const h = new SqliteHive(":memory:", { now: () => new Date(now) }); t.after(() => h.close());
  for (const key of ["org/skills/review", "project/app/skills/review", "org/skills/unused", "org/skills/shared"]) {
    const name = key.split("/").at(-1)!;
    await h.call("docs.save", { key, content: `---\nname: ${name}\ndescription: Test skill\n---\nSteps` }, admin);
  }
  const records = [run("recent", "app", now, ["review", "review", "shared"]), run("edge", "app", "2026-09-06T12:00:00.000Z", ["review"]), run("old", "app", "2026-09-06T11:59:59.999Z", ["review"]), run("secret", "private", now, ["review", "shared"]), run("future", "app", "2026-10-07T00:00:00.000Z", ["shared"]), run("legacy", "app", now)];
  await h.call("runs.push", { machine: "machine", runs: records }, machine);
  await h.call("runs.push", { machine: "machine", runs: [records[0]!] }, machine);
  await h.call("runs.push", { machine: "machine", runs: [run("recent", "app", now)] }, machine);
  assert.deepEqual((await h.call("runs.get", { machineId: machine.name, runId: "recent" }, admin))?.skills, ["review", "shared"]);
  const list = await h.call("skills.list", {}, viewer);
  const own = list.find((s) => s.project === "app")!.usage!;
  assert.equal(own.runs30d, 2); assert.equal(own.lastUsedAt, now);
  assert.equal(own.weeks.length, 8); assert.equal(own.weeks.at(-1)?.start, "2026-10-05T00:00:00.000Z");
  assert.equal(own.weeks.at(-1)?.runs, 1); assert.equal(own.weeks.reduce((n, w) => n + w.runs, 0), 3);
  assert.equal(list.find((s) => s.key === "org/skills/review")?.usage?.lastUsedAt, null, "project override does not count towards shared skill");
  assert.equal(list.find((s) => s.name === "shared")?.usage?.runs30d, 1, "shared stats cannot leak private runs");
  assert.equal(list.find((s) => s.name === "unused")?.usage?.lastUsedAt, null);
  assert.equal((await h.call("skills.list", {}, admin)).find((s) => s.name === "shared")?.usage?.runs30d, 2);
  assert.equal((await h.call("skills.list", { project: "app" }, admin)).find((s) => s.name === "shared")?.usage?.runs30d, 1);
});

it("adds skills to an existing hub without losing old records", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "skill-migration-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "hub.db");
  const before = new SqliteHive(file);
  await before.call("runs.push", { machine: "machine", runs: [run("old", "app", now)] }, machine);
  // Current handlers need later columns; roll back only the schema step being tested.
  const index = migrationIndex("ALTER TABLE run_records ADD COLUMN skills");
  before.db.exec(`ALTER TABLE run_records DROP COLUMN skills; PRAGMA user_version = ${index}`);
  before.close();
  const after = new SqliteHive(file, { migrateTo: index + 1 }); t.after(() => after.close());
  assert.deepEqual((await after.call("runs.get", { machineId: machine.name, runId: "old" }, admin))?.skills, []);
});
