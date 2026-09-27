import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HiveError, type Actor } from "../src/index.ts";
import { SqliteHive } from "../src/node.ts";

const mbp: Actor = { name: "runner.duy-mbp@duy", role: "agent" };
const imac: Actor = { name: "runner.duy-imac@duy", role: "agent" };
const viewer: Actor = { name: "pm", role: "viewer" };
const admin: Actor = { name: "duy", role: "admin" };

function clock(start = "2026-09-27T08:00:00.000Z") {
  let t = new Date(start).getTime();
  return { now: () => new Date(t), advance: (minutes: number) => (t += minutes * 60_000) };
}

const beat = (hive: SqliteHive, actor: Actor, instance: string, runs: unknown[] = []) =>
  hive.call("machines.heartbeat", { machine: actor.name.split(".")[1]!.split("@")[0]!, instance, version: "0.1.0", runs: runs as never }, actor);

const run = {
  runId: "R-abc123",
  project: "demo",
  taskId: "T-1",
  taskTitle: "Thêm trang cài đặt",
  role: "implement",
  status: "running",
  profileId: "claude-1",
  since: "2026-09-27T07:55:00.000Z",
};

describe("machines", () => {
  it("lists machines with their runs and marks silent ones offline", async () => {
    const c = clock();
    const hive = new SqliteHive(":memory:", { now: c.now });
    await beat(hive, mbp, "aaaaaaaa", [run]);
    await beat(hive, imac, "bbbbbbbb");
    let list = await hive.call("machines.list", {}, viewer);
    assert.deepEqual(list.map((m) => [m.machine, m.online, m.runs.length]), [["duy-mbp", true, 1], ["duy-imac", true, 0]]);
    assert.equal(list[0]!.runs[0]!.taskTitle, "Thêm trang cài đặt");

    c.advance(3);
    await beat(hive, imac, "bbbbbbbb");
    list = await hive.call("machines.list", {}, viewer);
    assert.deepEqual(list.map((m) => [m.machine, m.online]), [["duy-imac", true], ["duy-mbp", false]]);

    assert.deepEqual(await hive.call("machines.remove", { id: mbp.name }, admin), { removed: true });
    assert.equal((await hive.call("machines.list", {}, viewer)).length, 1);
  });

  it("flags two live apps under one machine name, but not a restart", async () => {
    const c = clock();
    const hive = new SqliteHive(":memory:", { now: c.now });
    for (const instance of ["aaaaaaaa", "aaaaaaaa", "bbbbbbbb", "bbbbbbbb"]) {
      assert.equal((await beat(hive, mbp, instance)).duplicate, false, "a restart switches instance once");
      c.advance(0.5);
    }
    assert.equal((await beat(hive, mbp, "aaaaaaaa")).duplicate, true, "the old instance is back: two apps");
    assert.equal((await hive.call("machines.list", {}, viewer))[0]!.duplicate, true);
    c.advance(6);
    assert.equal((await beat(hive, mbp, "aaaaaaaa")).duplicate, false, "clears once only one app is left");
  });

  it("drops machines silent for two weeks", async () => {
    const c = clock();
    const hive = new SqliteHive(":memory:", { now: c.now });
    await beat(hive, mbp, "aaaaaaaa");
    c.advance(15 * 24 * 60);
    await beat(hive, imac, "bbbbbbbb");
    assert.deepEqual((await hive.call("machines.list", {}, viewer)).map((m) => m.machine), ["duy-imac"]);
  });

  it("needs the agent role to report", async () => {
    const hive = new SqliteHive(":memory:");
    const readOnly: Actor = { name: "runner.pm-laptop@pm", role: "viewer" };
    await assert.rejects(beat(hive, readOnly, "aaaaaaaa"), (e: unknown) => e instanceof HiveError && e.code === "forbidden");
  });
});

describe("quota cooldowns", () => {
  it("shares a cooldown per account until it ends, last report wins", async () => {
    const c = clock();
    const hive = new SqliteHive(":memory:", { now: c.now });
    const set = await hive.call("cooldowns.set", { account: "claude-max-duy", until: "2026-09-27T10:13:00.000Z", reason: "usage limit" }, mbp);
    assert.equal(set?.reportedBy, mbp.name);
    await hive.call("cooldowns.set", { account: "claude-max-duy", until: "2026-09-27T09:00:00.000Z", reason: "resets 9am" }, imac);

    const beatReply = await beat(hive, imac, "bbbbbbbb");
    assert.deepEqual(beatReply.cooldowns.map((x) => [x.account, x.until, x.reportedBy]), [["claude-max-duy", "2026-09-27T09:00:00.000Z", imac.name]]);

    c.advance(61);
    assert.deepEqual(await hive.call("cooldowns.list", {}, viewer), [], "expired cooldowns disappear");
  });

  it("clears on request and ignores a reset time already past", async () => {
    const hive = new SqliteHive(":memory:", { now: clock().now });
    await hive.call("cooldowns.set", { account: "codex-plus", until: "2026-09-27T09:00:00.000Z", reason: "429" }, mbp);
    assert.deepEqual(await hive.call("cooldowns.clear", { account: "codex-plus" }, imac), { cleared: true });
    assert.equal(await hive.call("cooldowns.set", { account: "codex-plus", until: "2026-09-27T07:00:00.000Z", reason: "429" }, mbp), null);
    assert.deepEqual(await hive.call("cooldowns.list", {}, viewer), []);
  });

  it("refuses secrets and bad account names", async () => {
    const hive = new SqliteHive(":memory:", { now: clock().now });
    const until = "2026-09-27T09:00:00.000Z";
    await assert.rejects(hive.call("cooldowns.set", { account: "x", until, reason: `key sk-${"a".repeat(30)}` }, mbp), /secret|API key/i);
    await assert.rejects(hive.call("cooldowns.set", { account: "has space", until, reason: "" }, mbp), /account/);
    await assert.rejects(hive.call("cooldowns.set", { account: "ok", until: "tomorrow", reason: "" }, mbp), (e: unknown) => e instanceof HiveError && e.code === "bad_request");
  });
});
