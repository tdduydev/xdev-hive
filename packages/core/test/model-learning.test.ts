import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_MODEL_ROUTER,
  HiveError,
  isTrialTask,
  learnedTasks,
  learningDue,
  learningStats,
  median,
  proposeTier,
  selectModel,
  type Actor,
  type LearningRun,
  type ModelRouterSettings,
  type RouteInput,
} from "#core/index.ts";
import { SqliteHive } from "#core/node.ts";

// Roadmap 54d: the router learns from finished tasks, proposes the cheapest tier that does, and tries the tier below.

const run = (over: Partial<LearningRun>): LearningRun => ({
  taskId: "T-1",
  taskKind: "feature",
  taskSize: "m",
  role: "implement",
  status: "succeeded",
  verdict: null,
  tier: "standard",
  plan: "claude",
  pipelineFailed: false,
  createdAt: "2026-10-01T00:00:00.000Z",
  tokens: 1000,
  costUsd: 1,
  ...over,
});

describe("model learning, the numbers (roadmap 54d)", () => {
  it("counts a task by its first implement run's tier, every try in its tokens and cost", () => {
    const [task] = learnedTasks([
      run({ createdAt: "2026-10-01T02:00:00.000Z", tier: "strong", costUsd: 3, tokens: 3000 }),
      run({ role: "review", tier: "standard", verdict: "changes", createdAt: "2026-10-01T01:00:00.000Z", costUsd: 0.5, tokens: 500 }),
      run({ createdAt: "2026-10-01T00:00:00.000Z", costUsd: null, tokens: null }),
    ]);
    assert.deepEqual(task, { taskId: "T-1", kind: "feature", size: "m", tier: "standard", plan: "claude", clean: false, tokens: 3500, costUsd: 3.5 });
  });

  it("calls a task clean only without a failure the router counts and without a tier change", () => {
    const clean = (runs: Partial<LearningRun>[]) => learnedTasks(runs.map((r, i) => run({ createdAt: `2026-10-01T0${i}:00:00.000Z`, ...r })))[0]!.clean;
    assert.equal(clean([{}, { role: "review", verdict: "approve" }]), true);
    // Out of quota rotates to another plan at the same tier: not a failure.
    assert.equal(clean([{ status: "rate_limited" }, {}]), true);
    assert.equal(clean([{ status: "failed" }, {}]), false);
    assert.equal(clean([{ pipelineFailed: true }]), false);
    assert.equal(clean([{}, { tier: "strong" }]), false);
    // A failed review says nothing of the implementer.
    assert.equal(clean([{}, { role: "review", status: "failed" }]), true);
    assert.deepEqual(learnedTasks([run({ tier: null })]), [], "no tier: from before the router");
  });

  it("groups by kind × size × tier × kind of plan, with medians per finished task", () => {
    assert.deepEqual([median([3, 1, 2]), median([4, 1, 3, 2]), median([])], [2, 2.5, null]);
    const tasks = learnedTasks([
      run({ taskId: "A", costUsd: 1, tokens: 100 }),
      run({ taskId: "B", costUsd: 3, tokens: 300 }),
      run({ taskId: "C", costUsd: null, tokens: 200, status: "failed" }),
      run({ taskId: "C", createdAt: "2026-10-02T00:00:00.000Z", costUsd: null, tokens: 200 }),
      run({ taskId: "D", plan: "codex", costUsd: null }),
    ]);
    const [claude, codex] = learningStats(tasks);
    assert.deepEqual(claude, { kind: "feature", size: "m", tier: "standard", plan: "claude", tasks: 3, clean: 2, cleanRate: 2 / 3, tokensMedian: 300, costMedian: 2 });
    assert.deepEqual([codex?.plan, codex?.tasks, codex?.costMedian], ["codex", 1, null]);
  });

  it("proposes the cheapest tier finishing ≥ 80% of ≥ 10 tasks, every kind of plan together", () => {
    const tasks = (tier: "light" | "standard", n: number, cleanCount: number, plan = "claude") =>
      Array.from({ length: n }, (_, i) => ({ taskId: `${tier}-${plan}-${i}`, kind: "feature" as const, size: "m" as const, tier, plan, clean: i < cleanCount, tokens: null, costUsd: null }));
    const enough = learningStats([...tasks("light", 6, 5), ...tasks("light", 4, 3, "codex"), ...tasks("standard", 12, 12)]);
    assert.deepEqual(proposeTier(enough, "feature", "m", "standard", "balanced"), { tier: "light", ranAt: "light", tasks: 10, cleanRate: 0.8 });
    assert.equal(proposeTier(enough, "feature", "m", "light", "balanced"), null, "already there");
    // Economy runs one tier below the cell: to run at light, the cell says standard.
    assert.deepEqual(proposeTier(enough, "feature", "m", "strong", "economy")?.tier, "standard");
    const few = learningStats([...tasks("light", 9, 9), ...tasks("standard", 10, 7)]);
    assert.equal(proposeTier(few, "feature", "m", "standard", "balanced"), null, "9 tasks, and 70%");
  });

  it("picks about one task in ten to try, the same one every time", () => {
    const picked = Array.from({ length: 2000 }, (_, i) => isTrialTask("app", `R-${i}`)).filter(Boolean).length;
    assert.ok(picked > 140 && picked < 260, String(picked));
    assert.equal(isTrialTask("app", "R-7"), isTrialTask("app", "R-7"));
  });

  it("runs once a night, or at once after two days without", () => {
    const at = (iso: string) => new Date(iso);
    const night = new Date(2026, 9, 6, 2, 0);
    const day = new Date(2026, 9, 6, 14, 0);
    assert.equal(learningDue(null, day), true);
    assert.equal(learningDue(new Date(2026, 9, 5, 2, 0).toISOString(), night), true);
    assert.equal(learningDue(new Date(2026, 9, 5, 2, 0).toISOString(), day), false);
    assert.equal(learningDue(new Date(2026, 9, 6, 1, 30).toISOString(), night), false, "done tonight");
    assert.equal(learningDue(at("2026-10-01T00:00:00.000Z").toISOString(), day), true);
  });
});

describe("model router trial (roadmap 54d)", () => {
  const settings = (): ModelRouterSettings => structuredClone(DEFAULT_MODEL_ROUTER);
  const task = (over: Partial<RouteInput> = {}): RouteInput => ({ kind: "feature", size: "m", risk: "normal", role: "implement", trial: true, ...over });

  it("tries one tier below on a first, normal-risk implement run", () => {
    const tried = selectModel(settings(), "app", task())!;
    assert.deepEqual([tried.tier, tried.trial, tried.reason], ["light", true, "feature/m, balanced, trial"]);
    assert.equal(selectModel(settings(), "app", task({ risk: "high" }))!.tier, "strong", "not with high risk");
    const retry = selectModel(settings(), "app", task({ failures: 1 }))!;
    assert.deepEqual([retry.tier, retry.trial], ["standard", undefined], "a failure ends the trial");
    assert.equal(selectModel(settings(), "app", task({ role: "review" }))!.tier, "standard");
    const floor = selectModel(settings(), "app", task({ kind: "docs", size: "s" }))!;
    assert.deepEqual([floor.tier, floor.trial, floor.reason], ["light", undefined, "docs/s, balanced"], "nothing below light");
  });
});

describe("model learning on the hub", () => {
  const admin: Actor = { name: "duy", role: "admin" };
  const lead: Actor = { name: "lan", role: "member", access: { projects: { app: "lead" } } };
  const viewer: Actor = { name: "vy", role: "member", access: { projects: { app: "viewer" } } };
  const machine: Actor = { name: "runner.duy-mbp@duy-mbp", role: "agent" };
  // 2 at night, so the nightly check is the clock's, not the test's.
  const clock = () => new Date("2026-10-06T02:00:00.000Z");

  async function hub() {
    const hive = new SqliteHive(":memory:", { now: clock });
    let n = 0;
    /** A done task and its runs, straight into the tables the machines fill. */
    const finished = async (kind: string, size: string, tier: string, opts: { clean?: boolean; risk?: string; status?: string; plan?: string } = {}) => {
      const id = `L-${++n}`;
      await hive.call("tasks.create", { id, project: "app", title: `Task ${n}` }, admin);
      await hive.call("tasks.classify", { id, kind: kind as never, size: size as never, risk: (opts.risk ?? "normal") as never }, admin);
      hive.db.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(opts.status ?? "done", id);
      const insert = (runId: string, role: string, status: string, verdict: string | null, at: string) => {
        hive.db
          .prepare(
            `INSERT INTO run_records(machine_id, run_id, machine, project, task_id, task_title, role, status, verdict, tier, kind, created_at, finished_at, updated_at)
             VALUES ('m', ?, 'duy-mbp', 'app', ?, 'x', ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(runId, id, role, status, verdict, tier, opts.plan ?? "claude", at, at, at);
        hive.db
          .prepare(
            `INSERT INTO run_costs(machine_id, run_id, machine, project, task_id, profile_id, cost_usd, input_tokens, output_tokens, finished_at, priced)
             VALUES ('m', ?, 'duy-mbp', 'app', ?, 'claude-1', 2, 1000, 100, ?, 1)`,
          )
          .run(runId, id, at);
      };
      insert(`${id}-1`, "implement", "succeeded", null, "2026-10-01T00:00:00.000Z");
      insert(`${id}-2`, "review", "succeeded", opts.clean === false ? "changes" : "approve", "2026-10-01T01:00:00.000Z");
      return id;
    };
    return { hive, finished };
  }

  it("applies each proposal to an unlocked cell at night, logs it, and leaves locked cells and other tasks alone", async () => {
    const { hive, finished } = await hub();
    for (let i = 0; i < 10; i++) await finished("feature", "m", "light", { clean: i < 9 });
    // Not counted: high risk starts a tier up, and a task not done is no finished task.
    await finished("feature", "m", "light", { clean: false, risk: "high" });
    await finished("feature", "m", "light", { clean: false, status: "doing" });
    for (let i = 0; i < 10; i++) await finished("ui", "m", "light");
    for (let i = 0; i < 10; i++) await finished("refactor", "m", "standard", { clean: i < 7 });
    await hive.call("modelLearning.set", { project: "app", lock: { kind: "ui", size: "m", locked: true } }, lead);

    const before = await hive.call("modelLearning.get", { project: "app" }, viewer);
    const stat = before.stats.find((s) => s.kind === "feature" && s.size === "m")!;
    assert.deepEqual([stat.tier, stat.plan, stat.tasks, stat.clean, stat.costMedian, stat.tokensMedian], ["light", "claude", 10, 9, 4, 2200]);
    const cell = (view: typeof before, kind: string, size: string) => view.cells.find((c) => c.kind === kind && c.size === size)!;
    assert.deepEqual(cell(before, "feature", "m").proposal, { tier: "light", ranAt: "light", tasks: 10, cleanRate: 0.9 });
    assert.equal(cell(before, "refactor", "m").proposal, null, "70% is not enough");
    assert.equal(before.cells.some((c) => c.kind === "review"), false, "the review row routes every review run");

    assert.equal(hive.learnModels(), 1, "only feature/m: ui/m is locked");
    assert.equal(hive.learnModels(), 0, "once a night");
    const router = await hive.call("modelRouter.get", {}, admin);
    assert.equal(router.projects.app?.cells.feature?.m, "light");
    assert.equal(router.projects.app?.cells.ui?.m, undefined);
    const after = await hive.call("modelLearning.get", { project: "app" }, viewer);
    assert.equal(after.learnedAt, "2026-10-06T02:00:00.000Z");
    assert.equal(cell(after, "feature", "m").current, "light");
    assert.deepEqual(
      after.log.map((e) => [e.change, e.kind, e.size, e.fromTier, e.toTier, e.tasks, e.cleanRate, e.by]),
      [
        ["auto", "feature", "m", "standard", "light", 10, 0.9, "hub"],
        ["lock", "ui", "m", null, null, null, null, lead.name],
      ],
    );

    // A person may apply a locked cell's proposal; the lock stays.
    const applied = await hive.call("modelLearning.set", { project: "app", apply: { kind: "ui", size: "m" } }, lead);
    assert.deepEqual([cell(applied, "ui", "m").current, cell(applied, "ui", "m").locked, applied.log[0]?.change], ["light", true, "apply"]);
    await assert.rejects(hive.call("modelLearning.set", { project: "app", apply: { kind: "refactor", size: "m" } }, lead), (err) => err instanceof HiveError && err.key === "errors.noModelProposal");
    hive.close();
  });

  it("leaves the cells alone while learning or routing is off", async () => {
    const { hive, finished } = await hub();
    for (let i = 0; i < 10; i++) await finished("feature", "m", "light");
    const off = await hive.call("modelLearning.set", { project: "app", enabled: false }, lead);
    assert.deepEqual([off.enabled, off.log[0]?.change], [false, "off"]);
    assert.ok(off.cells.find((c) => c.kind === "feature" && c.size === "m")?.proposal, "the proposal still shows");
    assert.equal(hive.learnModels(true), 0);
    await hive.call("modelLearning.set", { project: "app", enabled: true }, lead);
    await hive.call("modelRouter.set", { project: "app", setting: { enabled: false, profile: "balanced", cells: {} } }, lead);
    assert.equal(hive.learnModels(true), 0);
    hive.close();
  });

  it("lets the project's settings right change it, and its readers read it", async () => {
    const { hive } = await hub();
    await assert.rejects(hive.call("modelLearning.set", { project: "app", enabled: false }, viewer), (err) => err instanceof HiveError && err.code === "forbidden");
    const stranger: Actor = { name: "x", role: "member", access: { projects: { site: "lead" } } };
    await assert.rejects(hive.call("modelLearning.get", { project: "app" }, stranger), HiveError);
    assert.equal((await hive.call("modelLearning.get", { project: "app" }, viewer)).enabled, true, "on by default");
    hive.close();
  });

  it("sends a picked task one tier below, unless its cell is locked or learning is off", async () => {
    const hive = new SqliteHive(":memory:", { now: clock });
    await hive.call(
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
    const ids = Array.from({ length: 300 }, (_, i) => `R-${i}`);
    const [first, second, third] = ids.filter((id) => isTrialTask("app", id));
    const plain = ids.find((id) => !isTrialTask("app", id))!;
    const dispatch = async (id: string) => {
      await hive.call("tasks.create", { id, project: "app", title: "Add a page" }, admin);
      await hive.call("tasks.classify", { id, kind: "feature", size: "m", risk: "normal" }, admin);
      return (await hive.call("runs.dispatch", { machineId: machine.name, project: "app", taskId: id }, lead)).selection!;
    };
    const tried = await dispatch(first!);
    assert.deepEqual([tried.tier, tried.trial, tried.review?.tier], ["light", true, "standard"]);
    assert.equal((await dispatch(plain)).tier, "standard");
    await hive.call("modelLearning.set", { project: "app", lock: { kind: "feature", size: "m", locked: true } }, lead);
    assert.equal((await dispatch(second!)).tier, "standard", "locked: kept by hand");
    await hive.call("modelLearning.set", { project: "app", lock: { kind: "feature", size: "m", locked: false }, enabled: false }, lead);
    assert.equal((await dispatch(third!)).tier, "standard", "learning off");
    hive.close();
  });
});
