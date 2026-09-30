import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HiveError, type Actor } from "#core/index.ts";
import { SqliteHive } from "#core/node.ts";

const admin: Actor = { name: "duy", role: "admin" };
const claude: Actor = { name: "claude@duy", role: "agent" };
const lan: Actor = { name: "lan", role: "member", access: { projects: { app: "contribute" } } };
const code = (c: string) => (e: unknown) => e instanceof HiveError && e.code === c;

const write = (hive: SqliteHive, content: string, extra: Record<string, unknown> = {}, actor: Actor = claude) =>
  hive.call("memory.write", { project: "app", kind: "decision", content, ...extra }, actor);
const agentSees = async (hive: SqliteHive) => (await hive.call("memory.search", { project: "app", query: "deploy" }, claude)).map((m) => m.content);

describe("memory that replaces or contradicts other memory", () => {
  it("shows agents only the newest entry of a chain, and people all of it", async () => {
    const hive = new SqliteHive(":memory:");
    const a = await write(hive, "Deploy with deploy-old.sh");
    const b = await write(hive, "Deploy with update.sh", { supersedes: a.id });
    const c = await write(hive, "Deploy with update.sh and HIVE_TUNNEL=1", { supersedes: b.id });
    assert.deepEqual([b.supersedes, c.supersedes], [a.id, b.id]);
    assert.deepEqual(await agentSees(hive), ["Deploy with update.sh and HIVE_TUNNEL=1"]);
    const all = await hive.call("memory.list", { project: "app" }, admin);
    assert.deepEqual(all.map((m) => [m.id, m.supersededBy]), [[c.id, null], [b.id, c.id], [a.id, b.id]]);

    await assert.rejects(write(hive, "Deploy by hand", { supersedes: a.id }), code("conflict"), "a is already replaced: replace the newest");
    await hive.call("memory.remove", { id: c.id }, admin);
    assert.deepEqual(await agentSees(hive), ["Deploy with update.sh"], "removing the replacement brings the one before back");
  });

  it("keeps the old entry visible while its replacement waits for approval", async () => {
    const hive = new SqliteHive(":memory:", { memoryRequiresApproval: true });
    const a = await write(hive, "Deploy with deploy-old.sh", {}, admin);
    const b = await write(hive, "Deploy with update.sh", { supersedes: a.id });
    assert.equal(b.status, "pending");
    assert.deepEqual(await agentSees(hive), ["Deploy with deploy-old.sh"]);
    await hive.call("memory.approve", { id: b.id }, admin);
    assert.deepEqual(await agentSees(hive), ["Deploy with update.sh"]);
  });

  it("links entries of the same owner only", async () => {
    const hive = new SqliteHive(":memory:");
    const shared = await hive.call("memory.write", { shared: true, kind: "convention", content: "Deploy on Fridays is fine" }, admin);
    await assert.rejects(write(hive, "No deploy on Fridays", { supersedes: shared.id }), code("bad_request"));
    const a = await write(hive, "Deploy anytime");
    await assert.rejects(write(hive, "x", { supersedes: a.id, contradicts: a.id }), code("bad_request"));
    await assert.rejects(write(hive, "x", { supersedes: 999 }), code("not_found"));
  });

  it("marks a contradiction for a person to settle, and agents see both until then", async () => {
    const hive = new SqliteHive(":memory:");
    const a = await write(hive, "Deploy needs a manual migration");
    const b = await write(hive, "Deploy runs migrations by itself", { contradicts: a.id });
    assert.deepEqual(b.conflictsWith, [a.id]);
    const seen = await hive.call("memory.search", { project: "app", query: "deploy" }, claude);
    assert.deepEqual(seen.map((m) => [m.id, m.conflictsWith]).sort(), [[a.id, [b.id]], [b.id, [a.id]]].sort());

    await assert.rejects(hive.call("memory.resolve", { id: a.id, other: b.id, keep: "this" }, lan), code("forbidden"), "settling is for managers");
    await assert.rejects(hive.call("memory.resolve", { id: a.id, other: 999, keep: "this" }, admin), code("not_found"));
    const kept = await hive.call("memory.resolve", { id: b.id, other: a.id, keep: "this" }, admin);
    assert.deepEqual([kept.conflictsWith, kept.supersedes], [[], a.id]);
    assert.deepEqual(await agentSees(hive), ["Deploy runs migrations by itself"]);
    await assert.rejects(hive.call("memory.resolve", { id: b.id, other: a.id, keep: "both" }, admin), code("bad_request"), "no conflict left");
  });

  it("drops a contradiction when both turn out true, or when one side is removed", async () => {
    const hive = new SqliteHive(":memory:");
    const a = await write(hive, "Deploy from main");
    const b = await write(hive, "Deploy from a tag", { contradicts: a.id });
    await hive.call("memory.resolve", { id: a.id, other: b.id, keep: "both" }, admin);
    assert.deepEqual((await agentSees(hive)).sort(), ["Deploy from a tag", "Deploy from main"]);
    const c = await write(hive, "Deploy only on weekdays", { contradicts: a.id });
    await hive.call("memory.remove", { id: c.id }, admin);
    const left = (await hive.call("memory.list", { project: "app" }, admin)).find((m) => m.id === a.id)!;
    assert.deepEqual(left.conflictsWith, []);
  });
});
