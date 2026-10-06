import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_MODEL_ROUTER, selectModel } from "#core/index.ts";

const config = () => structuredClone(DEFAULT_MODEL_ROUTER);
describe("model router", () => {
  it("maps kind and size, then applies profile and risk within bounds", () => {
    const r = config();
    assert.equal(selectModel(r, "app", "docs", "s", "normal")?.tier, "light");
    assert.equal(selectModel(r, "app", "feature", "l", "normal")?.models.claude?.model, "opusplan");
    r.projects.app = { enabled: true, profile: "quality", cells: {} };
    assert.equal(selectModel(r, "app", "docs", "s", "normal")?.tier, "light");
    assert.equal(selectModel(r, "app", "feature", "l", "high")?.tier, "max");
    r.projects.app.profile = "economy";
    assert.equal(selectModel(r, "app", "debug", "m", "normal")?.tier, "standard");
    r.projects.app.enabled = false;
    assert.equal(selectModel(r, "app", "debug", "m", "normal"), null);
  });
  it("raises a tier after the effort step and uses hub-edited rows", () => {
    const r = config();
    r.tiers.strong.claude = { model: "custom-opus", effort: "high" };
    assert.equal(selectModel(r, "app", "feature", "m", "normal", 1)?.tier, "standard");
    assert.deepEqual(selectModel(r, "app", "feature", "m", "normal", 2)?.models.claude, { model: "custom-opus", effort: "high" });
  });
});

it("sends the hub choice on a dispatched run and honors project off", async () => {
  const { SqliteHive } = await import("#core/node.ts");
  const admin = { name: "admin", role: "admin" as const };
  const machine = { name: "runner.test", role: "agent" as const };
  const hive = new SqliteHive(":memory:");
  await hive.call("machines.heartbeat", { machine: "runner", instance: "a1b2c3d4", profiles: [{ id: "claude-1", label: "Claude", kind: "claude", enabled: true, account: null, installed: true, loggedIn: true, cooldownUntil: null, runs: 0, rateLimited: 0 }], projects: ["app"], acceptsRuns: true }, machine);
  await hive.call("tasks.create", { id: "T-1", project: "app", title: "Update docs" }, admin);
  await hive.call("tasks.classify", { id: "T-1", size: "s" }, admin);
  const first = await hive.call("runs.dispatch", { machineId: machine.name, project: "app", taskId: "T-1" }, admin);
  assert.deepEqual([first.selection?.tier, first.selection?.models.claude?.model], ["light", "sonnet"]);
  await hive.call("modelRouter.set", { project: "app", setting: { enabled: false, profile: "balanced", cells: {} } }, admin);
  const settings = await hive.call("modelRouter.get", {}, admin);
  assert.equal(settings.projects.app?.enabled, false);
  hive.close();
});
