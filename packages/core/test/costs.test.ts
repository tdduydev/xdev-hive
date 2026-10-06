import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Actor } from "#core/index.ts";
import { SqliteHive } from "#core/node.ts";

const mbp: Actor = { name: "runner.duy-mbp@duy", role: "agent" };
const imac: Actor = { name: "runner.lan-imac@lan", role: "agent" };
const admin: Actor = { name: "duy", role: "admin" };

function clock(start = "2026-09-28T08:00:00.000Z") {
  let t = new Date(start).getTime();
  return { now: () => new Date(t), ago: (days: number) => new Date(t - days * 86_400_000).toISOString(), advance: (days: number) => (t += days * 86_400_000) };
}

const cost = (runId: string, finishedAt: string, extra: Record<string, unknown> = {}) => ({
  runId,
  project: "app",
  taskId: "T-1",
  profileId: "claude-1",
  account: "claude-max-duy",
  costUsd: 1,
  inputTokens: 1000,
  outputTokens: 100,
  finishedAt,
  ...extra,
});

const beat = (hive: SqliteHive, actor: Actor, costs: unknown[]) =>
  hive.call("machines.heartbeat", { machine: actor.name.split(".")[1]!.split("@")[0]!, instance: "aaaaaaaa", costs: costs as never }, actor);

describe("run costs on the hub", () => {
  it("sums what machines report over 24 hours, 7 days and 30 days, per project and per subscription", async () => {
    const c = clock();
    const hive = new SqliteHive(":memory:", { now: c.now });
    await beat(hive, mbp, [
      cost("R-1", c.ago(0.1), { costUsd: 0.5 }),
      cost("R-2", c.ago(3), { costUsd: 2 }),
      cost("R-3", c.ago(20), { costUsd: 4, project: "billing" }),
      cost("R-4", c.ago(40), { costUsd: 100 }),
    ]);
    await beat(hive, imac, [cost("R-1", c.ago(0.2), { costUsd: 0.25, profileId: "claude-2", account: null })]);
    await beat(hive, mbp, [cost("R-1", c.ago(0.1), { costUsd: 99 })]); // resent after a lost reply: kept as first reported

    const s = await hive.call("costs.summary", {}, admin);
    // Reports from apps before 28c: output tokens, input as one number, nothing about the cache.
    assert.deepEqual(
      s.total,
      { usd1: 0.75, usd7: 2.75, usd30: 6.75, runs30: 4, tokens30: { inputTokens: null, cacheWriteTokens: null, cacheReadTokens: null, outputTokens: 400 } },
      "the 40-day-old run is outside the window",
    );
    assert.deepEqual(
      s.projects.map((p) => [p.project, p.usd1, p.usd7, p.usd30, p.runs30]),
      [
        ["billing", 0, 0, 4, 1],
        ["app", 0.75, 2.75, 2.75, 3],
      ],
    );
    assert.deepEqual(
      s.profiles.map((p) => [p.machine, p.profileId, p.account, p.usd30]),
      [
        ["duy-mbp", "claude-1", "claude-max-duy", 6.5],
        ["lan-imac", "claude-2", null, 0.25],
      ],
    );
  });

  it("shows each reader only the projects they can see, and forgets runs after 90 days", async () => {
    const c = clock();
    const hive = new SqliteHive(":memory:", { now: c.now });
    await beat(hive, mbp, [cost("R-1", c.ago(1)), cost("R-2", c.ago(1), { project: "billing", costUsd: 5 })]);
    const lan: Actor = { name: "lan", role: "member", access: { projects: { app: "view" } } };
    const s = await hive.call("costs.summary", {}, lan);
    assert.deepEqual(s.projects.map((p) => p.project), ["app"]);
    assert.equal(s.total.usd30, 1);

    c.advance(91);
    await beat(hive, mbp, []);
    assert.equal((await hive.call("costs.summary", {}, admin)).total.runs30, 0);
    c.advance(-91);
    assert.equal((await hive.call("costs.summary", {}, admin)).total.runs30, 0, "deleted, not just outside the window");
  });

  it("refuses a cost report that does not look like one", async () => {
    const hive = new SqliteHive(":memory:");
    await assert.rejects(beat(hive, mbp, [cost("R-1", "yesterday")]));
    await assert.rejects(beat(hive, mbp, [cost("R-1", new Date().toISOString(), { costUsd: -1 })]));
    await assert.rejects(beat(hive, mbp, [cost("../etc", new Date().toISOString())]));
  });
});

describe("runs with RTK and without (roadmap 28d)", () => {
  const record = (runId: string, extra: Record<string, unknown> = {}) => ({
    runId,
    project: "app",
    taskId: "T-1",
    taskTitle: "Login page",
    role: "implement" as const,
    status: "succeeded" as const,
    profileId: "claude-1",
    createdAt: "2026-09-27T08:00:00.000Z",
    finishedAt: "2026-09-27T09:00:00.000Z",
    ...extra,
  });
  const gain = { tool: "rtk", commands: 42, input: 50_000, output: 8_000, saved: 42_000 };

  it("keeps a run's compression, and what it had when a push leaves it out", async () => {
    const hive = new SqliteHive(":memory:");
    await hive.call("runs.push", { machine: "duy-mbp", runs: [record("R-1", { compression: gain }), record("R-2")] }, mbp);
    const get = async (id: string) => (await hive.call("runs.list", {}, admin)).find((r) => r.runId === id)!;
    assert.deepEqual((await get("R-1")).compression, gain);
    assert.equal((await get("R-2")).compression, null);
    await hive.call("runs.push", { machine: "duy-mbp", runs: [record("R-1", { summary: "done" })] }, mbp);
    assert.deepEqual((await get("R-1")).compression, gain, "an older app's push keeps it");
    await hive.call("runs.push", { machine: "duy-mbp", runs: [record("R-1", { compression: null })] }, mbp);
    assert.equal((await get("R-1")).compression, null);
  });

  it("compares priced runs of 30 days by project and role, two columns", async () => {
    const c = clock();
    const hive = new SqliteHive(":memory:", { now: c.now });
    await hive.call(
      "runs.push",
      {
        machine: "duy-mbp",
        runs: [
          record("R-1", { compression: gain }),
          record("R-2", { compression: gain, status: "failed" }),
          record("R-3"),
          record("R-4", { role: "review" }),
          record("R-5"),
          record("R-6", { compression: gain }),
          record("R-7", { compression: gain, project: "web" }),
        ],
      },
      mbp,
    );
    await beat(hive, mbp, [
      cost("R-1", c.ago(1), { inputTokens: 100, cacheWriteTokens: 100, cacheReadTokens: 800, outputTokens: 50, costUsd: 0.5 }),
      cost("R-2", c.ago(2), { inputTokens: 300, cacheWriteTokens: 100, cacheReadTokens: 600, outputTokens: 150, costUsd: 1.5 }),
      cost("R-3", c.ago(1), { inputTokens: 1000, cacheWriteTokens: 500, cacheReadTokens: 2500, outputTokens: 300, costUsd: 3 }),
      cost("R-4", c.ago(1), { inputTokens: 10, outputTokens: 10 }),
      // Codex (no price) never counts as a run without RTK; one older than 30 days neither.
      cost("R-5", c.ago(1), { costUsd: null, inputTokens: 9999, outputTokens: 9999 }),
      cost("R-6", c.ago(40), { inputTokens: 9999, outputTokens: 9999 }),
      cost("R-7", c.ago(1), { project: "web" }),
    ]);
    const s = await hive.call("costs.summary", {}, admin);
    assert.deepEqual(s.compression, [
      {
        project: "app",
        role: "implement",
        rtk: { runs: 2, failed: 1, inputAvg: 1000, outputAvg: 100, cacheShare: 0.7, costAvg: 1 },
        plain: { runs: 1, failed: 0, inputAvg: 4000, outputAvg: 300, cacheShare: 0.625, costAvg: 3 },
      },
      {
        project: "web",
        role: "implement",
        rtk: { runs: 1, failed: 0, inputAvg: 1000, outputAvg: 100, cacheShare: null, costAvg: 1 },
        plain: { runs: 0, failed: 0, inputAvg: null, outputAvg: null, cacheShare: null, costAvg: null },
      },
    ], "a project and role with no RTK run is left out");
    const lead: Actor = { name: "lan", role: "member", access: { projects: { web: "lead" } } };
    assert.deepEqual((await hive.call("costs.summary", {}, lead)).compression?.map((r) => r.project), ["web"]);
  });
});
