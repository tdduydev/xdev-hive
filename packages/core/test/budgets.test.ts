import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HiveError, periodStart, type Actor, type Budget } from "#core/index.ts";
import { SqliteHive } from "#core/node.ts";

const admin: Actor = { name: "duy", role: "admin" };
// As the hub names a machine whose token is duy's: the account comes in onBehalf (apps/web tokenActor).
const mbp: Actor = { name: "runner.duy-mbp@duy-mbp", role: "agent", onBehalf: "duy" };
const lead: Actor = { name: "lan", role: "member", access: { projects: { app: "manage" } } };
const restrictedAdmin: Actor = { name: "khoa", role: "admin", access: { projects: { app: "manage" } } };

const profile = (id: string) => ({ id, label: id, kind: "claude", enabled: true, account: null, installed: true, cooldownUntil: null, runs: 0, rateLimited: 0 });

/** The hub's clock in its own zone: periods begin at local midnight and on the local 1st. */
async function hub(start = new Date(2026, 9, 31, 23, 0)) {
  const clock = { at: start.getTime() };
  const hive = new SqliteHive(":memory:", { now: () => new Date(clock.at) });
  await hive.call("tasks.create", { id: "T-1", project: "app", title: "Login page" }, admin);
  await hive.call("tasks.create", { id: "S-1", project: "site", title: "Landing" }, admin);
  let n = 0;
  const cost = (at: Date, over: Record<string, unknown> = {}) => ({
    runId: `R-${++n}`,
    project: "app",
    taskId: "T-1",
    profileId: "claude-1",
    account: null,
    costUsd: 1,
    inputTokens: null,
    outputTokens: null,
    finishedAt: at.toISOString(),
    ...over,
  });
  const beat = (costs: unknown[] = [], actor = mbp) =>
    hive.call(
      "machines.heartbeat",
      { machine: "duy-mbp", instance: "a1b2c3d4", profiles: [profile("claude-1")], projects: ["app", "site"], acceptsRuns: true, costs: costs as never },
      actor,
    );
  const later = (minutes: number) => (clock.at += minutes * 60_000);
  return { hive, cost, beat, later };
}

const used = async (hive: SqliteHive) => Object.fromEntries((await hive.call("budgets.list", {}, admin)).map((b) => [b.id, [b.used.usd, b.used.runs]]));

async function refusal(call: Promise<unknown>): Promise<HiveError> {
  try {
    await call;
  } catch (err) {
    assert.ok(err instanceof HiveError, String(err));
    return err;
  }
  assert.fail("expected the call to fail");
}

describe("spending caps (roadmap 27b)", () => {
  it("starts a day at the hub's midnight and a month on its 1st", () => {
    const at = new Date(2026, 9, 31, 23, 30);
    assert.equal(periodStart("day", at).getTime(), new Date(2026, 9, 31).getTime());
    assert.equal(periodStart("month", at).getTime(), new Date(2026, 9, 1).getTime());
  });

  it("counts what each cap's day or month used, and starts again when the day and the month turn", async () => {
    const { hive, cost, beat, later } = await hub();
    const caps: Budget[] = [
      { scope: { kind: "project", project: "app" }, period: "day", limit: { usd: 10 } },
      { scope: { kind: "project", project: "app" }, period: "month", limit: { usd: 100, runs: 50 } },
      { scope: { kind: "hub" }, period: "month", limit: { runs: 50 } },
    ];
    await hive.call("budgets.set", { budgets: caps }, admin);
    await beat([
      cost(new Date(2026, 9, 31, 22, 0), { costUsd: 2 }),
      cost(new Date(2026, 9, 30, 10, 0), { costUsd: 3 }),
      cost(new Date(2026, 8, 30, 12, 0), { costUsd: 40 }), // last month
      cost(new Date(2026, 9, 31, 9, 0), { costUsd: 5, project: "site" }),
    ]);
    assert.deepEqual(await used(hive), {
      "project:app:day": [2, 1],
      "project:app:month": [5, 2],
      "hub:month": [10, 3],
    });

    later(90); // 00:30 on the 1st of November
    assert.deepEqual(await used(hive), { "project:app:day": [0, 0], "project:app:month": [0, 0], "hub:month": [0, 0] });
    await beat([cost(new Date(2026, 10, 1, 0, 15), { costUsd: 1.5 })]);
    assert.deepEqual(await used(hive), { "project:app:day": [1.5, 1], "project:app:month": [1.5, 1], "hub:month": [1.5, 1] });
  });

  it("counts a run for who asked for it, and a Board run for the account of the machine's token", async () => {
    const { hive, cost, beat } = await hub();
    await hive.call(
      "budgets.set",
      {
        budgets: [
          { scope: { kind: "user", user: "lan" }, period: "day", limit: { usd: 5 } },
          { scope: { kind: "user", user: "duy" }, period: "day", limit: { usd: 5 } },
        ],
      },
      admin,
    );
    const today = new Date(2026, 9, 31, 20, 0);
    await beat([cost(today, { costUsd: 2, requestedBy: "lan" }), cost(today, { costUsd: 0.5 }), cost(today, { costUsd: 0.25, requestedBy: null })]);
    // An app older than 27b sends no requestedBy at all: the same as a Board run.
    await beat([{ ...cost(today, { costUsd: 1 }), requestedBy: undefined }]);
    assert.deepEqual(await used(hive), { "user:lan:day": [2, 1], "user:duy:day": [1.75, 3] });
  });

  it("lets only a hub admin set caps, one per scope and period, and shows each reader what they may see", async () => {
    const { hive } = await hub();
    const caps: Budget[] = [
      { scope: { kind: "project", project: "app" }, period: "month", limit: { usd: 100 } },
      { scope: { kind: "project", project: "site" }, period: "month", limit: { usd: 100 } },
      { scope: { kind: "user", user: "lan" }, period: "day", limit: { runs: 10 } },
      { scope: { kind: "user", user: "minh" }, period: "day", limit: { runs: 10 } },
      { scope: { kind: "hub" }, period: "month", limit: { usd: 500 } },
    ];
    assert.equal((await refusal(hive.call("budgets.set", { budgets: caps }, lead))).key, "errors.roleTooLow");
    assert.equal((await refusal(hive.call("budgets.set", { budgets: caps }, restrictedAdmin))).key, "errors.hubAdminOnly");
    assert.equal((await refusal(hive.call("budgets.set", { budgets: [caps[0]!, { ...caps[0]!, limit: { runs: 3 } }] }, admin))).key, "errors.budgetDuplicate");
    await assert.rejects(hive.call("budgets.set", { budgets: [{ scope: { kind: "hub" }, period: "day", limit: {} }] }, admin), /needs a limit/);
    await assert.rejects(hive.call("budgets.set", { budgets: [{ scope: { kind: "hub" }, period: "week" as never, limit: { usd: 1 } }] }, admin));

    const saved = await hive.call("budgets.set", { budgets: caps }, admin);
    assert.equal(saved.length, 5);
    assert.deepEqual(
      (await hive.call("budgets.list", {}, lead)).map((b) => b.id),
      ["project:app:month", "user:lan:day"],
      "their project and their own cap; not the hub's, which sums projects they do not see",
    );
    const [entry] = await hive.call("admin.audit", { action: "budgets.set" }, admin);
    assert.deepEqual([entry!.target, entry!.detailKey, entry!.detailVars], ["budgets", "audit.budgets", { count: 5 }]);
  });

  it("refuses a dispatch once a cap that binds it is reached, saying which and how much", async () => {
    const { hive, cost, beat } = await hub();
    await beat();
    const machineId = mbp.name;
    await hive.call("budgets.set", { budgets: [{ scope: { kind: "project", project: "app" }, period: "day", limit: { usd: 3 } }] }, admin);
    await beat([cost(new Date(2026, 9, 31, 12, 0), { costUsd: 2.5 })]);
    const req = await hive.call("runs.dispatch", { machineId, project: "app", taskId: "T-1" }, admin);
    await hive.call("runs.cancelRequest", { id: req.id }, admin);

    await beat([cost(new Date(2026, 9, 31, 13, 0), { costUsd: 0.5 })]);
    const err = await refusal(hive.call("runs.dispatch", { machineId, project: "app", taskId: "T-1" }, admin));
    assert.deepEqual([err.code, err.key, err.vars], ["conflict", "errors.budgetExceeded", { name: "app", used: "$3.00", limit: "$3.00", from: "2026-10-31", percent: 100 }]);
    assert.ok(await hive.call("runs.dispatch", { machineId, project: "site", taskId: "S-1" }, admin), "another project is not bound");

    // A cap on the person who asks: lan is at the cap, duy is not.
    await hive.call("budgets.set", { budgets: [{ scope: { kind: "user", user: "lan" }, period: "month", limit: { runs: 1 } }] }, admin);
    await beat([cost(new Date(2026, 9, 31, 14, 0), { requestedBy: "lan" })]);
    assert.equal((await refusal(hive.call("runs.dispatch", { machineId, project: "app", taskId: "T-1" }, lead))).key, "errors.budgetExceeded");
    assert.ok(await hive.call("runs.dispatch", { machineId, project: "app", taskId: "T-1" }, admin));
  });

  it("tells every machine in its heartbeat which caps are full, after the costs that beat brought", async () => {
    const { hive, cost, beat } = await hub();
    await hive.call(
      "budgets.set",
      {
        budgets: [
          { scope: { kind: "project", project: "app" }, period: "day", limit: { runs: 1 } },
          { scope: { kind: "project", project: "billing" }, period: "day", limit: { runs: 1 } },
          { scope: { kind: "user", user: "duy" }, period: "day", limit: { runs: 2 } },
          { scope: { kind: "user", user: "lan" }, period: "day", limit: { runs: 1 } },
          { scope: { kind: "hub" }, period: "day", limit: { runs: 3 } },
        ],
      },
      admin,
    );
    assert.deepEqual((await beat()).budgetBlocked, []);
    const today = new Date(2026, 9, 31, 12, 0);
    const res = await beat([cost(today), cost(today, { project: "site" }), cost(today, { project: "billing", requestedBy: "lan" })]);
    assert.deepEqual(
      res.budgetBlocked.map((b) => [b.project ?? b.user ?? "hub", b.self ?? null, b.key]),
      [
        ["app", null, "errors.budgetExceeded"],
        ["duy", true, "errors.budgetExceeded"],
        ["lan", false, "errors.budgetExceeded"],
        ["hub", null, "errors.budgetExceeded"],
      ],
      "billing is full too, but this machine has no repo for it",
    );
    assert.deepEqual(res.budgetBlocked[0]!.vars, { name: "app", used: "1 run", limit: "1 run", from: "2026-10-31", percent: 100 });
  });
});
