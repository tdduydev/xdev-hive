import assert from "node:assert/strict";
import { it } from "node:test";
import { SqliteHive } from "#core/node.ts";
import type { Actor } from "#core/index.ts";

it("sends service allowed kinds with unpinned requests", async () => {
  const hive = new SqliteHive(":memory:");
  const admin: Actor = { name: "lead", role: "admin" };
  const machine: Actor = { name: "runner.test", role: "agent" };
  const beat = () => hive.call("machines.heartbeat", {
    machine: "test", instance: "a1b2c3d4", projects: ["app"], acceptsRuns: true,
    profiles: [{ id: "claude-1", label: "Claude", kind: "claude", installed: true, enabled: true, account: null, cooldownUntil: null, runs: 0, rateLimited: 0 }],
  }, machine);
  await beat();
  await hive.call("sdlc.setProject", { project: "app", settings: { gates: {}, allowedAgentKinds: ["claude", "codex"] } }, admin);
  await hive.call("tasks.create", { id: "A-1", project: "app", title: "Build", kind: "feature", size: "s" }, admin);
  const req = await hive.call("runs.dispatch", { project: "app", taskId: "A-1", machineId: machine.name }, admin);
  assert.deepEqual(req.allowedAgentKinds, ["claude", "codex"]);
  assert.deepEqual((await beat()).runRequests[0]?.allowedAgentKinds, ["claude", "codex"]);
  hive.close();
});
