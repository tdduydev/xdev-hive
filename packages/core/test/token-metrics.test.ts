import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cacheReadShare, OPEN_POLICY, tighten, type Actor } from "#core/index.ts";
import { SqliteHive } from "#core/node.ts";

const admin: Actor = { name: "duy", role: "admin" };
const machine: Actor = { name: "runner.duy-mbp@duy-mbp", role: "agent" };

const cost = (runId: string, over: Record<string, unknown> = {}) => ({
  runId,
  project: "app",
  taskId: "T-1",
  profileId: "claude-1",
  account: null,
  costUsd: 0.5,
  inputTokens: 1000,
  cacheWriteTokens: 1000,
  cacheReadTokens: 8000,
  outputTokens: 400,
  finishedAt: "2026-10-02T03:00:00.000Z",
  ...over,
});

describe("token counts apart (roadmap 28c)", () => {
  it("reads the share of input that came from the cache", () => {
    assert.equal(cacheReadShare({ inputTokens: 1000, cacheWriteTokens: 1000, cacheReadTokens: 8000 }), 0.8);
    assert.equal(cacheReadShare({ inputTokens: 6000, cacheWriteTokens: null, cacheReadTokens: null }), null, "a run from before says nothing");
    assert.equal(cacheReadShare({ inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 }), null);
  });

  it("keeps the four counts of each run, a Codex run without a price too, and adds them up per project and subscription", async () => {
    const hive = new SqliteHive(":memory:", { now: () => new Date("2026-10-02T04:00:00.000Z") });
    await hive.call("runs.push", { machine: "duy-mbp", runs: [{ runId: "R-c1", project: "app", taskId: "T-1", taskTitle: "x", role: "implement", status: "succeeded", profileId: "claude-1", createdAt: "2026-10-02T02:00:00.000Z" }] }, machine);
    await hive.call(
      "machines.heartbeat",
      {
        machine: "duy-mbp",
        instance: "a1b2c3d4",
        costs: [
          cost("R-c1"),
          // Codex: no price, its cached input counted.
          cost("R-x1", { profileId: "codex-1", costUsd: null, inputTokens: 1000, cacheWriteTokens: 0, cacheReadTokens: 3000, outputTokens: 200 }),
          // An app from before 28c: input as one number, nothing about the cache.
          { ...cost("R-old", { inputTokens: 6000, outputTokens: 100 }), cacheWriteTokens: undefined, cacheReadTokens: undefined },
        ] as never,
      },
      machine,
    );
    const s = await hive.call("costs.summary", {}, admin);
    assert.equal(s.total.runs30, 3);
    assert.equal(s.total.usd30, 1, "Codex adds no money");
    assert.deepEqual(s.total.tokens30, { inputTokens: 2000, cacheWriteTokens: 1000, cacheReadTokens: 11000, outputTokens: 700 }, "the old run's input stays out of the split");
    const codex = s.profiles.find((p) => p.profileId === "codex-1")!;
    assert.equal(cacheReadShare(codex.tokens30), 0.75);
    const run = (await hive.call("runs.list", { project: "app" }, admin)).find((r) => r.runId === "R-c1")!;
    assert.deepEqual(run.tokens, { inputTokens: 1000, cacheWriteTokens: 1000, cacheReadTokens: 8000, outputTokens: 400 });
    assert.deepEqual((await hive.call("runs.get", { machineId: machine.name, runId: "R-c1" }, admin))?.tokens, run.tokens);
  });

  it("lets a project only lower the hub's output limits", () => {
    const hub = { ...OPEN_POLICY, limits: { mcpOutputTokens: 20_000, bashOutputChars: null } };
    assert.deepEqual(tighten(hub, { limits: { mcpOutputTokens: 50_000, bashOutputChars: 30_000 } }).limits, { mcpOutputTokens: 20_000, bashOutputChars: 30_000 });
    assert.deepEqual(tighten(hub, { limits: { mcpOutputTokens: 5000, bashOutputChars: null } }).limits, { mcpOutputTokens: 5000, bashOutputChars: null });
    assert.equal(tighten(OPEN_POLICY, {}).limits, undefined, "none set: none sent");
  });

  it("keeps a project's limits with its agent policy", async () => {
    const hive = new SqliteHive(":memory:");
    await hive.call("agentPolicy.set", { project: "app", policy: { limits: { mcpOutputTokens: 10_000, bashOutputChars: 20_000 } } }, admin);
    const view = await hive.call("agentPolicy.get", {}, admin);
    assert.deepEqual(view.effective.app?.limits, { mcpOutputTokens: 10_000, bashOutputChars: 20_000 });
    await assert.rejects(hive.call("agentPolicy.set", { project: "app", policy: { limits: { mcpOutputTokens: 10, bashOutputChars: null } } }, admin));
  });
});
