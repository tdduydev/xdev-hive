import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { transferHive, type Actor } from "../src/index.ts";
import { SqliteHive } from "../src/node.ts";

const admin: Actor = { name: "duy", role: "admin" };
const agent: Actor = { name: "claude@duy", role: "agent" };

async function seeded() {
  const hive = new SqliteHive(":memory:");
  await hive.call("memory.write", { project: "app", kind: "gotcha", content: "app: node:sqlite cần Node 24" }, admin);
  await hive.call("memory.write", { project: "web", kind: "decision", content: "web: dùng Tailwind v4" }, admin);
  await hive.call("memory.write", { shared: true, kind: "convention", content: "Commit theo Conventional Commits" }, admin);
  return hive;
}

describe("shared (team-wide) memory", () => {
  it("is seen from every project's search, with project null, unless left out", async () => {
    const hive = await seeded();
    const app = await hive.call("memory.search", { project: "app" }, agent);
    assert.deepEqual(app.map((m) => m.project).sort(), ["app", null].sort());
    const web = await hive.call("memory.search", { project: "web", query: "commit" }, agent);
    assert.deepEqual(web.map((m) => [m.project, m.content]), [[null, "Commit theo Conventional Commits"]]);
    assert.deepEqual((await hive.call("memory.search", { project: "app", includeShared: false }, agent)).map((m) => m.project), ["app"]);
    assert.deepEqual((await hive.call("memory.search", {}, agent)).map((m) => m.project), [null], "no project: shared only");
    assert.deepEqual((await hive.call("memory.search", { anyProject: true, query: "dùng" }, agent)).map((m) => m.project), ["web"]);
    assert.equal((await hive.call("memory.search", { anyProject: true }, agent)).length, 3);
  });

  it("lists everything, one project (optionally with shared), or shared only", async () => {
    const hive = await seeded();
    assert.equal((await hive.call("memory.list", {}, admin)).length, 3);
    assert.deepEqual((await hive.call("memory.list", { project: "app" }, admin)).map((m) => m.project), ["app"]);
    assert.deepEqual((await hive.call("memory.list", { project: "app", includeShared: true }, admin)).map((m) => m.project), [null, "app"]);
    assert.deepEqual((await hive.call("memory.list", { project: null }, admin)).map((m) => m.content), ["Commit theo Conventional Commits"]);
  });

  it("needs either a project or shared: true, not both", async () => {
    const hive = new SqliteHive(":memory:");
    await assert.rejects(hive.call("memory.write", { kind: "gotcha", content: "x" }, agent), /needs a project/);
    await assert.rejects(hive.call("memory.write", { project: "app", shared: true, kind: "gotcha", content: "x" }, agent), /needs a project/);
  });

  it("moves between local and hub as shared", async () => {
    const local = await seeded();
    const hub = new SqliteHive(":memory:");
    const r = await transferHive({ backend: local, actor: admin, label: "máy" }, { backend: hub, actor: admin, label: "hub" });
    assert.equal(r.counts.failed, 0, JSON.stringify(r.items));
    assert.deepEqual((await hub.call("memory.list", { project: null }, admin)).map((m) => m.content), ["Commit theo Conventional Commits"]);
    const again = await transferHive({ backend: local, actor: admin, label: "máy" }, { backend: hub, actor: admin, label: "hub" });
    assert.equal(again.items.filter((i) => i.kind === "memory" && i.result === "unchanged").length, 3);
  });
});
