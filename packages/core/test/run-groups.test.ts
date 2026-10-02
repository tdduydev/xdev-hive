import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HiveError, type Actor, type RunGroup } from "#core/index.ts";
import { SqliteHive } from "#core/node.ts";

// Roadmap 31a: run groups. Several tasks at once, on machines picked or left to the hub, at most N at a time.

const admin: Actor = { name: "duy", role: "admin" };
const mbp: Actor = { name: "runner.duy-mbp@duy-mbp", role: "agent" };
const mini: Actor = { name: "runner.lan-mini@lan-mini", role: "agent" };
const lead: Actor = { name: "lan", role: "member", access: { projects: { app: "manage" } } };
const dev: Actor = { name: "minh", role: "member", access: { projects: { app: "contribute" } } };

const profile = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  label: id,
  kind: id.split("-")[0]!,
  enabled: true,
  account: null,
  installed: true,
  cooldownUntil: null,
  runs: 0,
  rateLimited: 0,
  ...over,
});

async function hub() {
  const clock = { at: Date.parse("2026-10-02T08:00:00.000Z") };
  const hive = new SqliteHive(":memory:", { now: () => new Date(clock.at) });
  for (const n of [1, 2, 3, 4]) await hive.call("tasks.create", { id: `T-${n}`, project: "app", title: `Task ${n}` }, admin);
  await hive.call("tasks.create", { id: "T-5", project: "app", title: "After T-1", dependsOn: ["T-1"] }, admin);
  await hive.call("tasks.create", { id: "S-1", project: "site", title: "Landing" }, admin);
  const beat = (actor: Actor, over: Record<string, unknown> = {}) =>
    hive.call(
      "machines.heartbeat",
      { machine: actor.name.split("@")[1]!, instance: "a1b2c3d4", profiles: [profile("claude-1")], projects: ["app"], acceptsRuns: true, ...over },
      actor,
    );
  const push = (actor: Actor, runId: string, taskId: string, status: string) =>
    hive.call(
      "runs.push",
      {
        machine: actor.name.split("@")[1]!,
        runs: [{ runId, project: "app", taskId, taskTitle: taskId, role: "implement", status: status as never, profileId: "claude-1", createdAt: "2026-10-02T08:00:00.000Z" }],
      },
      actor,
    );
  /** The machine takes what it was sent, as runs R-<task>. */
  const take = async (actor: Actor, sent: Array<{ id: number; taskId: string }>) => {
    for (const r of sent) await hive.call("runs.requestResult", { id: r.id, status: "accepted", runId: `R-${r.taskId}` }, actor);
  };
  const later = (minutes: number) => (clock.at += minutes * 60_000);
  return { hive, beat, push, take, later };
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

const states = (g: RunGroup) => g.items.map((i) => `${i.taskId}:${i.status}${i.request ? `/${i.request.status}` : ""}`);

describe("run groups (roadmap 31a)", () => {
  it("sends at most maxParallel at a time and the next when a run ends", async () => {
    const { hive, beat, push, take } = await hub();
    await beat(mbp);
    const group = await hive.call(
      "runs.dispatchMany",
      {
        project: "app",
        title: "Sprint 4",
        items: ["T-1", "T-2", "T-3"].map((taskId) => ({ taskId, machineId: mbp.name })),
        maxParallel: 2,
        reviewAfter: true,
        instructions: "Keep the API stable.",
      },
      lead,
    );
    assert.deepEqual([group.kind, group.title, group.maxParallel, group.createdBy], ["batch", "Sprint 4", 2, "lan"]);
    assert.deepEqual(states(group), ["T-1:sent/pending", "T-2:sent/pending", "T-3:held"]);
    const sent = (await beat(mbp)).runRequests;
    assert.deepEqual(
      sent.map((r) => [r.taskId, r.reviewAfter, r.instructions, r.requestedBy]),
      [
        ["T-1", true, "Keep the API stable.", "lan"],
        ["T-2", true, "Keep the API stable.", "lan"],
      ],
    );
    await take(mbp, sent);
    await push(mbp, "R-T-1", "T-1", "running");
    await push(mbp, "R-T-2", "T-2", "running");
    assert.deepEqual((await beat(mbp)).runRequests, [], "both places are taken");

    await push(mbp, "R-T-1", "T-1", "succeeded");
    const next = (await beat(mbp)).runRequests;
    assert.deepEqual(
      next.map((r) => r.taskId),
      ["T-3"],
      "a run ended: the next item goes out in the same answer",
    );
    await take(mbp, next);
    await push(mbp, "R-T-2", "T-2", "failed");
    await push(mbp, "R-T-3", "T-3", "succeeded");
    await beat(mbp);
    const [done] = await hive.call("runs.groups", { project: "app" }, lead);
    assert.ok(done!.closedAt, "nothing left to send or going: the group is over");
    assert.deepEqual(
      done!.items.map((i) => [i.taskId, i.run?.status, i.active]),
      [
        ["T-1", "succeeded", false],
        ["T-2", "failed", false],
        ["T-3", "succeeded", false],
      ],
    );

    const [entry] = await hive.call("admin.audit", { action: "runs.dispatchMany" }, admin);
    assert.deepEqual([entry!.actor, entry!.target, entry!.detailKey], ["lan", "app", "audit.runGroup"]);
  });

  it("gives an item left to the hub to the machine with the most free places", async () => {
    const { hive, beat } = await hub();
    // mbp: one place, busy. mini: two Claude accounts of 2 places, one resting.
    await beat(mbp, { runs: [{ runId: "R-x", project: "app", taskId: "T-9", taskTitle: "x", role: "implement", status: "running", profileId: "claude-1", since: "2026-10-02T07:00:00.000Z" }] });
    await beat(mini, { profiles: [profile("claude-1", { maxConcurrent: 2 }), profile("claude-2", { maxConcurrent: 2, cooldownUntil: "2026-10-02T09:00:00.000Z" })] });
    const group = await hive.call("runs.dispatchMany", { project: "app", items: [{ taskId: "T-1" }, { taskId: "T-2" }, { taskId: "T-3" }] }, admin);
    assert.deepEqual(
      group.items.map((i) => [i.taskId, i.status, i.machineId]),
      [
        ["T-1", "sent", mini.name],
        ["T-2", "sent", mini.name],
        ["T-3", "held", null],
      ],
      "mini has 2 places (claude-2 rests), mbp none: the third waits",
    );
    await beat(mbp, { runs: [] });
    const [g] = await hive.call("runs.groups", {}, admin);
    assert.deepEqual(g!.items[2]!.machineId, mbp.name, "mbp's run ended: the third goes there");
  });

  it("waits for what may change and fails what will not", async () => {
    const { hive, beat, later } = await hub();
    await beat(mbp);
    await beat(mini, { acceptsRuns: false });
    const group = await hive.call(
      "runs.dispatchMany",
      { project: "app", items: [{ taskId: "T-5", machineId: mbp.name }, { taskId: "T-2", machineId: mini.name }, { taskId: "T-3", machineId: mbp.name }] },
      admin,
    );
    assert.deepEqual(states(group), ["T-5:held", "T-2:held", "T-3:sent/pending"], "T-5 waits for T-1; mini does not take runs now");
    await hive.call("tasks.update", { id: "T-1", status: "done" }, admin);
    await hive.call("tasks.update", { id: "T-2", status: "done" }, admin);
    await beat(mini);
    const [g] = await hive.call("runs.groups", {}, admin);
    assert.deepEqual(states(g!).slice(0, 2), ["T-5:sent/pending", "T-2:failed"]);
    assert.equal(g!.items[1]!.error?.key, "errors.taskDone");
    // Requests no machine takes expire like any other; the group ends with them.
    later(16);
    await beat(mbp, { acceptsRuns: false });
    const [over] = await hive.call("runs.groups", {}, admin);
    assert.ok(over!.closedAt);
  });

  it("checks at once what does not change while items wait, and makes nothing then", async () => {
    const { hive, beat } = await hub();
    await beat(mbp, { projects: ["site"] });
    const ask = (items: Array<{ taskId: string; machineId?: string; profileId?: string }>, over: Record<string, unknown> = {}) =>
      refusal(hive.call("runs.dispatchMany", { project: "app", items, ...over }, admin));
    assert.equal(await ask([{ taskId: "T-1" }, { taskId: "T-1" }]), "errors.taskTwiceInGroup");
    assert.equal(await ask([{ taskId: "S-1" }]), "errors.taskNotInProject");
    assert.equal(await ask([{ taskId: "T-1", machineId: mbp.name }]), "errors.machineNoRepo");
    await beat(mbp);
    assert.equal(await ask([{ taskId: "T-1", machineId: mbp.name, profileId: "codex-9" }]), "errors.profileNotOnMachine");
    assert.equal(await ask([{ taskId: "T-1" }], { instructions: `use ghp_${"a".repeat(36)}` }), "errors.secret");
    assert.deepEqual(await hive.call("runs.groups", {}, admin), []);

    await hive.call("runs.dispatchMany", { project: "app", items: [{ taskId: "T-1" }, { taskId: "T-2" }], maxParallel: 1 }, admin);
    assert.equal(await ask([{ taskId: "T-2" }]), "errors.taskInGroup", "a task is in one open group at a time");
    assert.equal(await refusal(hive.call("runs.dispatch", { machineId: mbp.name, project: "app", taskId: "T-2" }, admin)), "errors.taskInGroup");
  });

  it("cancels what the group has not started, and only a manager may", async () => {
    const { hive, beat } = await hub();
    await beat(mbp);
    const group = await hive.call("runs.dispatchMany", { project: "app", items: [{ taskId: "T-1" }, { taskId: "T-2" }], maxParallel: 1 }, lead);
    assert.equal(await refusal(hive.call("runs.cancelGroup", { id: group.id }, dev)), "errors.need.runDispatch");
    assert.equal(await refusal(hive.call("runs.dispatchMany", { project: "app", items: [{ taskId: "T-3" }] }, dev)), "errors.need.runDispatch");
    const cancelled = await hive.call("runs.cancelGroup", { id: group.id }, lead);
    assert.deepEqual(states(cancelled), ["T-1:sent/cancelled", "T-2:cancelled"]);
    assert.ok(cancelled.closedAt);
    assert.deepEqual((await beat(mbp)).runRequests, []);
    assert.equal(await refusal(hive.call("runs.cancelGroup", { id: group.id }, lead)), "errors.runGroupClosed");
    // The tasks are free again.
    assert.equal((await hive.call("runs.dispatch", { machineId: mbp.name, project: "app", taskId: "T-2" }, lead)).status, "pending");
  });

  it("shows a group only to readers of its project", async () => {
    const { hive, beat } = await hub();
    await beat(mbp);
    await hive.call("runs.dispatchMany", { project: "app", items: [{ taskId: "T-1" }] }, admin);
    const outsider: Actor = { name: "khoa", role: "member", access: { projects: { site: "manage" } } };
    assert.deepEqual(await hive.call("runs.groups", {}, outsider), []);
    assert.equal((await hive.call("runs.groups", {}, dev)).length, 1);
  });
});

describe("one prompt for several agents (roadmap 31e)", () => {
  it("makes P-<n> and a task per agent, runs them side by side, and keeps the one picked", async () => {
    const { hive, beat, push, take } = await hub();
    await beat(mbp, { profiles: [profile("claude-1"), profile("codex-1")] });
    await beat(mini);
    const prompt = "Make the login page load under 1 s.\nMeasure before and after.";
    const g = await hive.call(
      "runs.fanout",
      {
        project: "app",
        prompt,
        targets: [
          { machineId: mbp.name, profileId: "claude-1" },
          { machineId: mbp.name, profileId: "codex-1" },
          { machineId: null, profileId: null },
        ],
        reviewAfter: true,
      },
      lead,
    );
    assert.deepEqual([g.kind, g.parentTask, g.title, g.maxParallel], ["fanout", "P-1", "Make the login page load under 1 s.", null]);
    assert.deepEqual(
      g.items.map((i) => [i.taskId, i.status, i.machineId]),
      [
        ["P-1-a", "sent", mbp.name],
        ["P-1-b", "sent", mbp.name],
        ["P-1-c", "sent", mini.name],
      ],
      "all at once; the third goes to the machine with room",
    );
    const tasks = await hive.call("tasks.list", { project: "app" }, admin);
    const parent = tasks.find((t) => t.id === "P-1")!;
    assert.deepEqual([parent.note, parent.waitingOn], [prompt, ["P-1-a", "P-1-b", "P-1-c"]], "nobody runs the prompt's own task");
    assert.equal(tasks.find((t) => t.id === "P-1-b")!.title, `Make the login page load under 1 s. · duy-mbp/codex-1`);
    assert.equal(tasks.find((t) => t.id === "P-1-c")!.title, `Make the login page load under 1 s. · */*`);
    const sent = (await beat(mbp)).runRequests;
    assert.deepEqual(
      sent.map((r) => [r.taskId, r.profileId, r.instructions, r.reviewAfter]),
      [
        ["P-1-a", "claude-1", "", true],
        ["P-1-b", "codex-1", "", true],
      ],
      "each agent reads the prompt as its task's note",
    );

    await take(mbp, sent);
    await push(mbp, "R-P-1-a", "P-1-a", "running");
    assert.equal(await refusal(hive.call("runs.pickWinner", { groupId: g.id, taskId: "P-1-a" }, lead)), "errors.fanoutRunning");
    await push(mbp, "R-P-1-a", "P-1-a", "succeeded");
    await push(mbp, "R-P-1-b", "P-1-b", "failed");
    const third = (await beat(mini)).runRequests;
    await take(mini, third);
    await push(mini, "R-P-1-c", "P-1-c", "succeeded");
    assert.equal(await refusal(hive.call("runs.pickWinner", { groupId: g.id, taskId: "P-1-a" }, dev)), "errors.need.taskManage");
    assert.equal(await refusal(hive.call("runs.pickWinner", { groupId: g.id, taskId: "T-1" }, lead)), "errors.notInGroup");

    const kept = await hive.call("runs.pickWinner", { groupId: g.id, taskId: "P-1-c" }, lead);
    assert.equal(kept.winnerTask, "P-1-c");
    assert.ok(kept.closedAt);
    const after = await hive.call("tasks.list", { project: "app" }, admin);
    const state = (id: string) => after.find((t) => t.id === id)!;
    assert.deepEqual([state("P-1-a").status, state("P-1-a").note], ["done", "Không chọn trong P-1 (chọn P-1-c)."]);
    assert.equal(state("P-1-b").status, "done");
    assert.equal(state("P-1").status, "done");
    assert.notEqual(state("P-1-c").status, "done", "the kept one goes on as it was");
    assert.equal(await refusal(hive.call("runs.pickWinner", { groupId: g.id, taskId: "P-1-a" }, lead)), "errors.winnerPicked");
    // Over: its task may be run again by hand (a fix, a review).
    assert.equal((await hive.call("runs.dispatch", { machineId: mini.name, project: "app", taskId: "P-1-c" }, lead)).status, "pending");

    const [entry] = await hive.call("admin.audit", { action: "runs.pickWinner" }, admin);
    assert.deepEqual([entry!.target, entry!.detailKey], ["app/P-1-c", "audit.runPick"]);
  });

  it("checks the targets and the prompt first, and makes nothing then", async () => {
    const { hive, beat } = await hub();
    await beat(mbp, { projects: ["site"] });
    const ask = (over: Record<string, unknown>) =>
      refusal(hive.call("runs.fanout", { project: "app", prompt: "Go", targets: [{ machineId: null }, { machineId: null }], ...over }, admin));
    assert.equal(await ask({ targets: [{ machineId: mbp.name }, { machineId: null }] }), "errors.machineNoRepo");
    assert.equal(await ask({ prompt: `deploy with ghp_${"a".repeat(36)}` }), "errors.secret");
    assert.equal(await ask({ targets: [{ machineId: null }] }), "bad_request", "two agents at least");
    assert.equal(await refusal(hive.call("runs.fanout", { project: "app", prompt: "Go", targets: [{}, {}] }, dev)), "errors.need.taskManage");
    assert.deepEqual((await hive.call("tasks.list", { project: "app" }, admin)).filter((t) => t.id.startsWith("P-")), []);
  });
});

describe("a task whose run in a group is over (roadmap 31a fix)", () => {
  it("may be run again by hand while the rest of its group goes on", async () => {
    const { hive, beat, push, take } = await hub();
    await beat(mbp);
    await hive.call("runs.dispatchMany", { project: "app", items: [{ taskId: "T-1", machineId: mbp.name }, { taskId: "T-2", machineId: mbp.name }], maxParallel: 1 }, admin);
    const [first] = (await beat(mbp)).runRequests;
    await take(mbp, [first!]);
    await push(mbp, "R-T-1", "T-1", "running");
    assert.equal(await refusal(hive.call("runs.dispatch", { machineId: mbp.name, project: "app", taskId: "T-1" }, admin)), "errors.taskInGroup", "its run is going");
    await push(mbp, "R-T-1", "T-1", "succeeded");
    await beat(mbp);
    // A fix after its review, say: the group still runs T-2.
    assert.equal((await hive.call("runs.dispatch", { machineId: mbp.name, project: "app", taskId: "T-1" }, admin)).status, "pending");
  });
});
