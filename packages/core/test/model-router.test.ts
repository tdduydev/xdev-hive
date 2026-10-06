import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_MODEL_ROUTER, HiveError, selectModel, type Actor, type ModelRouterSettings, type RouteInput } from "#core/index.ts";
import { SqliteHive } from "#core/node.ts";

const settings = (): ModelRouterSettings => structuredClone(DEFAULT_MODEL_ROUTER);
const task = (over: Partial<RouteInput> = {}): RouteInput => ({ kind: "feature", size: "m", risk: "normal", role: "implement", ...over });

describe("model router (roadmap 54c)", () => {
  it("starts from the kind × size cell, with the tier's model for each kind of plan", () => {
    const docs = selectModel(settings(), "app", task({ kind: "docs", size: "s" }))!;
    assert.equal(docs.tier, "light");
    assert.deepEqual(docs.models, { claude: { model: "sonnet", effort: "low" }, codex: { model: "gpt-6-luna", effort: "medium" }, antigravity: { model: "gemini-3.8-flash", effort: "low" } });
    assert.equal(docs.reason, "docs/s, balanced");
    assert.equal(selectModel(settings(), "app", task({ kind: "debug", size: "s" }))!.tier, "strong");
    // Unclassified: feature/m, as 54b's default.
    assert.equal(selectModel(settings(), "app", task({ kind: null, size: null }))!.reason, "feature/m, balanced");
  });

  it("takes the nearest tier's model when a kind has none at the tier", () => {
    const strong = selectModel(settings(), "app", task({ kind: "debug" }))!;
    assert.deepEqual(strong.models.antigravity, { model: "gemini-3.8-pro", effort: "medium" });
  });

  it("raises one tier for high risk, and plans with Opus for a big feature or refactor", () => {
    assert.equal(selectModel(settings(), "app", task({ risk: "high" }))!.tier, "strong");
    const big = selectModel(settings(), "app", task({ size: "l" }))!;
    assert.deepEqual([big.tier, big.models.claude], ["strong", { model: "opusplan", effort: "medium" }]);
    assert.equal(selectModel(settings(), "app", task({ kind: "debug", size: "l" }))!.models.claude?.model, "opus", "not for debugging");
    assert.equal(selectModel(settings(), "app", task({ size: "l", risk: "high" }))!.models.claude?.model, "opus", "max stays on opus high");
  });

  it("moves with the project's profile, within light and max, never above max effort", () => {
    const r = settings();
    r.projects.app = { enabled: true, profile: "economy", cells: {} };
    assert.equal(selectModel(r, "app", task({ kind: "docs", size: "s" }))!.tier, "light", "no lower than light");
    assert.equal(selectModel(r, "app", task({ kind: "debug" }))!.tier, "standard");
    r.projects.app.profile = "quality";
    assert.equal(selectModel(r, "app", task({ kind: "docs", size: "s" }))!.tier, "light", "docs and tests stay");
    const top = selectModel(r, "app", task({ size: "l", risk: "high" }))!;
    assert.deepEqual([top.tier, top.models.claude], ["max", { model: "opus", effort: "high" }]);
  });

  it("uses the project's own cells over the hub's, and the hub's edited table", () => {
    const r = settings();
    r.cells.docs.s = "standard";
    r.tiers.standard.claude = { model: "claude-sonnet-5-5", effort: "medium" };
    assert.equal(selectModel(r, "app", task({ kind: "docs", size: "s" }))!.models.claude?.model, "claude-sonnet-5-5");
    r.projects.app = { enabled: true, profile: "balanced", cells: { docs: { s: "light" } } };
    assert.equal(selectModel(r, "app", task({ kind: "docs", size: "s" }))!.tier, "light");
  });

  it("raises the effort after a failure, then the tier, twice at most, for the implementer only", () => {
    const once = selectModel(settings(), "app", task({ failures: 1 }))!;
    assert.deepEqual([once.tier, once.models.claude?.effort, once.models.codex?.effort, once.reason], ["standard", "high", "medium", "feature/m, balanced, failure 1"]);
    const twice = selectModel(settings(), "app", task({ failures: 2 }))!;
    assert.deepEqual([twice.tier, twice.models.claude?.effort], ["strong", "medium"]);
    assert.deepEqual(selectModel(settings(), "app", task({ failures: 5 })), twice);
    // agy's --effort stops at high.
    const r = settings();
    r.tiers.standard.antigravity = { model: "gemini-3.8-pro", effort: "high" };
    assert.equal(selectModel(r, "app", task({ failures: 1 }))!.models.antigravity?.effort, "high");
    assert.equal(selectModel(settings(), "app", task({ role: "review", failures: 2 }))!.tier, "standard", "a review does not escalate");
  });

  it("routes a review by the review row, and nothing for classify or a project that turned it off", () => {
    assert.equal(selectModel(settings(), "app", task({ kind: "debug", role: "review" }))!.reason, "review/m, balanced");
    assert.equal(selectModel(settings(), "app", task({ role: "classify" })), null);
    const r = settings();
    r.projects.app = { enabled: false, profile: "balanced", cells: {} };
    assert.equal(selectModel(r, "app", task()), null);
  });
});

describe("model router on the hub", () => {
  const admin: Actor = { name: "duy", role: "admin" };
  const lead: Actor = { name: "lan", role: "member", access: { projects: { app: "manage" } } };
  const machine: Actor = { name: "runner.duy-mbp@duy-mbp", role: "agent" };

  async function hub() {
    const hive = new SqliteHive(":memory:");
    const beat = () =>
      hive.call(
        "machines.heartbeat",
        {
          machine: "duy-mbp",
          instance: "a1b2c3d4",
          profiles: [{ id: "claude-1", label: "Claude", kind: "claude", enabled: true, account: null, installed: true, cooldownUntil: null, runs: 0, rateLimited: 0 }],
          projects: ["app"],
          acceptsRuns: true,
        },
        machine,
      );
    await beat();
    await hive.call("tasks.create", { id: "T-1", project: "app", title: "Update the guide" }, admin);
    await hive.call("tasks.classify", { id: "T-1", kind: "docs", size: "s", risk: "normal" }, admin);
    return { hive, beat };
  }

  async function refusal(call: Promise<unknown>): Promise<string | undefined> {
    try {
      await call;
    } catch (err) {
      assert.ok(err instanceof HiveError, String(err));
      return err.key ?? err.code;
    }
    assert.fail("expected the call to fail");
  }

  it("sends its choice with the request, also at the next heartbeat, and the review's beside it", async () => {
    const { hive, beat } = await hub();
    const req = await hive.call("runs.dispatch", { machineId: machine.name, project: "app", taskId: "T-1", reviewAfter: true }, lead);
    assert.deepEqual([req.selection?.tier, req.selection?.models.claude?.model, req.selection?.reason], ["light", "sonnet", "docs/s, balanced"]);
    assert.equal(req.selection?.review?.reason, "review/s, balanced");
    const [sent] = (await beat()).runRequests;
    assert.deepEqual(sent!.selection, req.selection, "fixed at the request, not worked out again");
    hive.close();
  });

  it("returns the original request reason in run lists and details even after settings change", async () => {
    const { hive } = await hub();
    const req = await hive.call("runs.dispatch", { machineId: machine.name, project: "app", taskId: "T-1", reviewAfter: true }, lead);
    await hive.call("runs.requestResult", { id: req.id, status: "accepted", runId: "R-model1" }, machine);
    const run = { runId: "R-model1", project: "app", taskId: "T-1", taskTitle: "Guide", role: "implement" as const, status: "running" as const, profileId: "claude-1", createdAt: new Date().toISOString(), kind: "claude" as const, model: "opus", effort: "high", tier: "light" };
    await hive.call("runs.push", { machine: "duy-mbp", runs: [run, { ...run, runId: "R-review1", role: "review", parentRun: "R-model1" }, { ...run, runId: "R-local1" }] }, machine);
    await hive.call("modelRouter.set", { project: "app", setting: { enabled: false, profile: "quality", cells: {} } }, lead);
    const rows = await hive.call("runs.list", { project: "app" }, lead);
    assert.deepEqual(rows.find((r) => r.runId === "R-model1")?.selection, req.selection);
    assert.deepEqual(rows.find((r) => r.runId === "R-review1")?.selection, req.selection?.review);
    assert.equal(rows.find((r) => r.runId === "R-local1")?.selection, null);
    const detail = await hive.call("runs.get", { machineId: machine.name, runId: "R-model1" }, lead);
    assert.equal(detail?.model, "opus", "actual args can override the routed model");
    assert.equal(detail?.selection?.reason, "docs/s, balanced", "never recompute from current settings");
    hive.close();
  });

  it("keeps runs as before for a project that turned it off; the tiers are a hub admin's", async () => {
    const { hive } = await hub();
    await hive.call("modelRouter.set", { project: "app", setting: { enabled: false, profile: "balanced", cells: {} } }, lead);
    assert.equal((await hive.call("modelRouter.get", {}, admin)).projects.app?.enabled, false);
    const req = await hive.call("runs.dispatch", { machineId: machine.name, project: "app", taskId: "T-1" }, lead);
    assert.equal(req.selection, null);
    const { tiers, cells } = DEFAULT_MODEL_ROUTER;
    assert.equal(await refusal(hive.call("modelRouter.set", { project: null, tiers, cells }, lead)), "errors.hubAdminOnly");
    const edited = { ...tiers, light: { ...tiers.light, claude: { model: "haiku", effort: "low" as const } } };
    assert.equal((await hive.call("modelRouter.set", { project: null, tiers: edited, cells }, admin)).tiers.light.claude?.model, "haiku");
    assert.equal(await refusal(hive.call("modelRouter.set", { project: null, tiers: { ...tiers, max: { ...tiers.max, claude: { model: "opus", effort: "max" } } }, cells } as never, admin)), "bad_request", "no max effort");
    hive.close();
  });
});
