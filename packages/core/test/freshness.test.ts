import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HiveError, type Actor } from "#core/index.ts";
import { SqliteHive } from "#core/node.ts";

const admin: Actor = { name: "duy", role: "admin" };
const claude: Actor = { name: "claude@duy", role: "agent" };
const lan: Actor = { name: "lan", role: "member", access: { projects: { app: "contribute" } } };
const code = (c: string) => (e: unknown) => e instanceof HiveError && e.code === c;

function clock(start = "2026-01-01T08:00:00.000Z") {
  let t = new Date(start).getTime();
  return { now: () => new Date(t), advance: (days: number) => (t += days * 86_400_000) };
}

describe("memory freshness", () => {
  it("counts what agents' searches return, not what people browse", async () => {
    const c = clock();
    const hive = new SqliteHive(":memory:", { now: c.now });
    const m = await hive.call("memory.write", { project: "app", kind: "gotcha", content: "Build needs Node 26" }, claude);
    assert.deepEqual([m.useCount, m.lastUsedAt, m.stale], [0, null, false]);

    c.advance(10);
    const [found] = await hive.call("memory.search", { project: "app", query: "node" }, claude);
    assert.deepEqual([found!.useCount, found!.lastUsedAt], [1, c.now().toISOString()]);
    await hive.call("memory.search", { project: "app", query: "node" }, admin);
    assert.equal((await hive.call("memory.list", { project: "app" }, admin))[0]!.useCount, 1, "the web page does not count");
  });

  it("leaves long-unused memory out of agents' searches until someone keeps it", async () => {
    const c = clock();
    const hive = new SqliteHive(":memory:", { now: c.now, memoryStaleDays: 90 });
    const old = await hive.call("memory.write", { project: "app", kind: "decision", content: "Deploy with the old script" }, claude);
    c.advance(60);
    const fresh = await hive.call("memory.write", { project: "app", kind: "decision", content: "Deploy with update.sh" }, claude);
    c.advance(31); // old: 91 days, fresh: 31 days

    assert.deepEqual((await hive.call("memory.search", { project: "app", query: "deploy" }, claude)).map((m) => m.id), [fresh.id]);
    assert.deepEqual((await hive.call("memory.search", { project: "app", query: "deploy", includeStale: true }, admin)).map((m) => m.id).sort(), [old.id, fresh.id].sort());
    assert.deepEqual((await hive.call("memory.list", { project: "app", stale: true }, admin)).map((m) => [m.id, m.stale]), [[old.id, true]]);

    await assert.rejects(hive.call("memory.keep", { id: old.id }, lan), code("forbidden"), "keeping is curation: manage only");
    const kept = await hive.call("memory.keep", { id: old.id }, admin);
    assert.equal(kept.stale, false);
    assert.equal(kept.useCount, 0, "keeping is not a use");
    assert.equal((await hive.call("memory.search", { project: "app", query: "old script" }, claude)).length, 1);
  });

  it("never goes stale with memoryStaleDays 0", async () => {
    const c = clock();
    const hive = new SqliteHive(":memory:", { now: c.now, memoryStaleDays: 0 });
    await hive.call("memory.write", { project: "app", kind: "context", content: "Kept forever" }, claude);
    c.advance(1000);
    assert.equal((await hive.call("memory.search", { project: "app", query: "forever" }, claude)).length, 1);
    assert.deepEqual(await hive.call("memory.list", { project: "app", stale: true }, admin), []);
  });
});
