import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HiveError, transferHive, type Actor } from "#core/index.ts";
import { SqliteHive } from "#core/node.ts";

const admin: Actor = { name: "duy", role: "admin" };
const claude: Actor = { name: "claude@duy", role: "agent" };
const codex: Actor = { name: "codex@duy", role: "agent" };
const lan: Actor = { name: "lan", role: "member", access: { projects: { app: "contribute" } } };
const key = (k: string) => (e: unknown) => e instanceof HiveError && e.key === k;

async function board() {
  const hive = new SqliteHive(":memory:");
  const create = (id: string, dependsOn: string[] = [], project = "app") => hive.call("tasks.create", { id, project, title: `Task ${id}`, dependsOn }, admin);
  await create("T-1");
  await create("T-2", ["T-1"]);
  await create("T-3", ["T-1", "T-2"]);
  await create("T-4");
  const get = async (id: string) => (await hive.call("tasks.list", { project: "app" }, admin)).find((t) => t.id === id)!;
  return { hive, create, get };
}

describe("task dependencies", () => {
  it("keeps a task waiting until what it depends on is done, then unlocks it", async () => {
    const { hive, get } = await board();
    assert.deepEqual([(await get("T-3")).dependsOn, (await get("T-3")).waitingOn], [["T-1", "T-2"], ["T-1", "T-2"]]);
    await assert.rejects(hive.call("tasks.claim", { id: "T-2" }, claude), key("errors.taskWaiting"));

    await hive.call("tasks.claim", { id: "T-1" }, claude);
    await hive.call("tasks.update", { id: "T-1", status: "review" }, claude);
    assert.deepEqual((await get("T-2")).waitingOn, ["T-1"], "review is not done");
    await hive.call("tasks.update", { id: "T-1", status: "done" }, admin);
    assert.deepEqual((await get("T-2")).waitingOn, []);
    assert.deepEqual((await get("T-3")).waitingOn, ["T-2"]);
    assert.equal((await hive.call("tasks.claim", { id: "T-2" }, codex)).claimed, true);

    // Reopening a dependency does not take the task from whoever holds it: they can renew.
    await hive.call("tasks.update", { id: "T-1", status: "todo" }, admin);
    assert.equal((await hive.call("tasks.claim", { id: "T-2" }, codex)).claimed, true);
    await assert.rejects(hive.call("tasks.claim", { id: "T-3" }, codex), key("errors.taskWaiting"));
  });

  it("suggests the ready tasks, the one that unlocks the most first", async () => {
    const { hive, create } = await board();
    await create("T-5", ["T-4"]);
    await create("T-6", ["T-4"]);
    await create("T-7", ["T-4"]);
    const next = async () => (await hive.call("tasks.next", { project: "app" }, admin)).map((t) => t.id);
    assert.deepEqual(await next(), ["T-4", "T-1"], "T-4 unlocks three, T-1 two");

    await hive.call("tasks.claim", { id: "T-4" }, claude);
    assert.deepEqual(await next(), ["T-1"], "a held task is not suggested");
    await hive.call("tasks.update", { id: "T-4", status: "done" }, claude);
    await hive.call("tasks.update", { id: "T-1", status: "done" }, admin);
    assert.deepEqual(await next(), ["T-2", "T-5", "T-6", "T-7"], "T-2 unlocks T-3; the rest in the order they were made");
    assert.deepEqual((await hive.call("tasks.next", { project: "app", limit: 1 }, admin)).map((t) => t.id), ["T-2"]);
    assert.deepEqual(await hive.call("tasks.next", { project: "other" }, admin), []);
  });

  it("refuses itself, other projects, missing tasks and cycles", async () => {
    const { hive, create } = await board();
    await create("X-1", [], "other");
    await assert.rejects(create("T-9", ["T-9"]), key("errors.taskDepSelf"));
    await assert.rejects(create("T-9", ["X-1"]), key("errors.taskDepProject"));
    await assert.rejects(create("T-9", ["T-404"]), key("errors.taskNotFound"));
    assert.equal((await hive.call("tasks.list", { project: "app" }, admin)).some((t) => t.id === "T-9"), false, "nothing half-created");

    await assert.rejects(hive.call("tasks.setDeps", { id: "T-1", dependsOn: ["T-3"] }, admin), key("errors.taskDepCycle"));
    const t4 = await hive.call("tasks.setDeps", { id: "T-4", dependsOn: ["T-3", "T-3"] }, admin);
    assert.deepEqual(t4.dependsOn, ["T-3"]);
    assert.deepEqual((await hive.call("tasks.setDeps", { id: "T-4", dependsOn: [] }, admin)).dependsOn, []);
  });

  it("lets only managers change dependencies, and records it", async () => {
    const { hive } = await board();
    await assert.rejects(hive.call("tasks.setDeps", { id: "T-4", dependsOn: ["T-1"] }, lan), (e: unknown) => e instanceof HiveError && e.code === "forbidden");
    await hive.call("tasks.setDeps", { id: "T-4", dependsOn: ["T-1"] }, admin);
    const [entry] = await hive.call("admin.audit", { limit: 1 }, admin);
    assert.deepEqual([entry!.action, entry!.target, entry!.detail], ["tasks.setDeps", "T-4", "← T-1"]);
  });

  it("copies dependencies when moving tasks between machine and hub", async () => {
    const { hive: local } = await board();
    const hub = new SqliteHive(":memory:");
    const r = await transferHive({ backend: local, actor: admin, label: "máy" }, { backend: hub, actor: admin, label: "hub" });
    assert.equal(r.counts.failed, 0);
    const tasks = Object.fromEntries((await hub.call("tasks.list", { project: "app" }, admin)).map((t) => [t.id, t.dependsOn]));
    assert.deepEqual(tasks, { "T-1": [], "T-2": ["T-1"], "T-3": ["T-1", "T-2"], "T-4": [] });
  });
});
