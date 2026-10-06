import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { SqliteHive, migrationIndex } from "#core/node.ts";
import { needsPlanApproval, type Actor, type PlanApprovalMode, type RunRequest } from "#core/index.ts";

const admin: Actor = { name: "lead", role: "admin" };
const machine: Actor = { name: "runner.test", role: "agent" };
const reader: Actor = { name: "reader", role: "viewer", access: { projects: { app: "viewer" } } };
async function setup(mode: PlanApprovalMode = "all", timeoutMinutes: number | null = null, supported = true) {
  let at = Date.parse("2026-10-06T08:00:00Z");
  const hive = new SqliteHive(":memory:", { now: () => new Date(at) });
  const beat = () => hive.call("machines.heartbeat", { machine: "test", instance: "a1b2c3d4", projects: ["app"], acceptsRuns: true, profiles: [{ id: "claude-1", label: "Claude", kind: "claude", installed: true, enabled: true, account: null, cooldownUntil: null, runs: 0, rateLimited: 0, planApproval: supported }] }, machine);
  await beat();
  await hive.call("sdlc.setProject", { project: "app", settings: { gates: {}, planApproval: { mode, timeoutMinutes } } }, admin);
  const create = (id: string, size: "s" | "m" | "l" = "m") => hive.call("tasks.create", { id, project: "app", title: `Build ${id}`, kind: "feature", size }, admin);
  const dispatch = (taskId: string) => hive.call("runs.dispatch", { project: "app", taskId, machineId: machine.name }, admin);
  const finish = async (req: RunRequest, runId: string, text: string | null = "## Work\nChange app.ts\n## Verify\nnpm test\n## Risks\nNone", status: "succeeded" | "failed" | "rate_limited" = "succeeded") => {
    await hive.call("runs.requestResult", { id: req.id, status: "accepted", runId }, machine);
    const push = () => hive.call("runs.push", { machine: "test", runs: [{ runId, project: req.project, taskId: req.taskId, taskTitle: req.taskTitle, role: "implement", status, profileId: "claude-1", planText: text, summary: "finished", createdAt: new Date(at).toISOString(), finishedAt: new Date(at).toISOString() }] }, machine);
    await push();
    return push;
  };
  const plans = () => hive.call("runs.plans", { project: "app" }, admin);
  return { hive, beat, create, dispatch, finish, plans, later: (n: number) => { at += n * 60000; } };
}

describe("implementation plan approval", () => {
  it("defaults off and gates medium/large including unknown sizes", () => {
    assert.equal(needsPlanApproval(undefined, "l"), false);
    for (const size of ["m", "l", null] as const) assert.equal(needsPlanApproval({ mode: "medium-large", timeoutMinutes: null }, size), true);
    assert.equal(needsPlanApproval({ mode: "medium-large", timeoutMinutes: null }, "s"), false);
  });
  it("upgrades existing databases without changing project settings", async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "hive-plan-")), "hive.db");
    const before = new SqliteHive(file, { migrateTo: migrationIndex("CREATE TABLE implementation_plans(") });
    await before.call("sdlc.setProject", { project: "app", settings: { gates: { review: "ai" } } }, admin);
    before.close();
    const after = new SqliteHive(file);
    const policy = (await after.call("sdlc.get", {}, admin)).projects.app!;
    assert.equal(policy.gates.review, "ai");
    assert.equal(policy.planApproval?.mode, "off");
    after.close();
  });
  it("waits without review or duplicate dispatch; revises, then approves exactly once with full text", async () => {
    const s = await setup();
    await s.create("T-1");
    const first = await s.dispatch("T-1");
    assert.equal(first.plan?.phase, "plan");
    const replay = await s.finish(first, "plan-1");
    await replay();
    let plan = (await s.plans())[0]!;
    assert.equal(plan.status, "waiting");
    assert.equal((await s.hive.call("runs.get", { machineId: machine.name, runId: "plan-1" }, admin))?.plan?.text, plan.text);
    assert.equal((await s.beat()).runRequests.length, 0);
    await assert.rejects(s.dispatch("T-1"));
    await assert.rejects(s.hive.call("runs.decidePlan", { id: plan.id, revision: 1, decision: "approve" }, reader));
    await assert.rejects(s.hive.call("runs.decidePlan", { id: plan.id, revision: 1, decision: "changes" }, admin));
    await s.hive.call("runs.decidePlan", { id: plan.id, revision: 1, decision: "changes", note: "Add regression tests" }, admin);
    const second = (await s.beat()).runRequests[0]!;
    assert.equal(second.plan?.phase, "plan");
    assert.equal(second.plan?.note, "Add regression tests");
    assert.equal(second.plan?.text, plan.text);
    await s.finish(second, "plan-2", "Revised plan with regression tests");
    plan = (await s.plans())[0]!;
    assert.equal(plan.revision, 2);
    await s.hive.call("runs.decidePlan", { id: plan.id, revision: 2, decision: "approve" }, admin);
    await assert.rejects(s.hive.call("runs.decidePlan", { id: plan.id, revision: 2, decision: "approve" }, admin));
    const build = (await s.beat()).runRequests[0]!;
    assert.equal(build.plan?.phase, "implement");
    assert.equal(build.plan?.text, "Revised plan with regression tests");
    assert.equal((await s.hive.call("tasks.list", { project: "app" }, admin))[0]!.status, "todo");
    const hidden: Actor = { name: "other", role: "viewer", access: { projects: { other: "viewer" } } };
    assert.deepEqual(await s.hive.call("runs.plans", {}, hidden), []);
    s.hive.close();
  });
  it("lets a desktop runner prepare a plan with taskWork, but never approve its own work", async () => {
    const s = await setup(); await s.create("LOCAL-1");
    await assert.rejects(s.hive.call("runs.dispatch", { project: "app", taskId: "LOCAL-1", machineId: machine.name }, machine));
    const req = await s.hive.call("runs.preparePlan", { project: "app", taskId: "LOCAL-1" }, machine);
    assert.equal(req.machineId, machine.name); assert.equal(req.plan?.phase, "plan");
    await s.finish(req, "local-plan"); s.later(180);
    assert.equal((await s.beat()).runRequests.length, 0, "no timeout means waiting indefinitely");
    const plan = (await s.plans())[0]!;
    await assert.rejects(s.hive.call("runs.decidePlan", { id: plan.id, revision: 1, decision: "approve" }, machine));
    await s.hive.call("runs.decidePlan", { id: plan.id, revision: 1, decision: "approve" }, admin);
    assert.equal((await s.beat()).runRequests[0]?.plan?.phase, "implement"); s.hive.close();
  });
  it("timeout starts at readiness, pauses with project and defaults to indefinite wait", async () => {
    const s = await setup("all", 120);
    await s.create("T-1"); const req = await s.dispatch("T-1");
    s.later(10); await s.finish(req, "plan-1"); s.later(119);
    assert.equal((await s.beat()).runRequests.length, 0);
    await s.hive.call("agents.stop", { project: "app" }, admin);
    s.later(1); assert.equal((await s.beat()).runRequests.length, 0);
    await s.hive.call("agents.resume", { project: "app" }, admin);
    assert.equal((await s.beat()).runRequests[0]?.plan?.phase, "implement");
    assert.equal((await s.plans())[0]?.decidedBy, "auto");
    s.hive.close();
  });
  it("keeps a serial group blocked until the implementation, rewiring its request", async () => {
    const s = await setup(); await s.create("T-1"); await s.create("T-2");
    const group = await s.hive.call("runs.dispatchMany", { project: "app", items: ["T-1", "T-2"].map((taskId) => ({ taskId, machineId: machine.name })), maxParallel: 1 }, admin);
    const req = (await s.beat()).runRequests[0]!; await s.finish(req, "plan-1");
    const waiting = (await s.hive.call("runs.groups", {}, admin)).find((g) => g.id === group.id)!;
    assert.equal(waiting.items[0]?.active, true); assert.equal(waiting.items[1]?.status, "held");
    const plan = (await s.plans())[0]!;
    await s.hive.call("runs.decidePlan", { id: plan.id, revision: 1, decision: "approve" }, admin);
    const build = (await s.beat()).runRequests[0]!;
    assert.equal(build.plan?.phase, "implement");
    assert.equal((await s.hive.call("runs.groups", {}, admin))[0]?.items[0]?.request?.id, build.id);
    s.hive.close();
  });
  it("keeps errors out of SDLC review and cancelled groups out of automatic approval", async () => {
    const s = await setup("all", 1);
    await s.hive.call("sdlc.setProject", { project: "app", settings: { gates: {}, fastLaneKinds: ["docs"], planApproval: { mode: "all", timeoutMinutes: 1 } } }, admin);
    await s.hive.call("tasks.create", { id: "F-1", project: "app", title: "Update docs", kind: "docs", size: "m" }, admin);
    const failed = await s.dispatch("F-1"); const replay = await s.finish(failed, "empty-fast", ""); await replay();
    assert.equal((await s.hive.call("sdlc.flowTasks", { project: "app" }, admin))[0]?.stage, "stopped");
    assert.equal((await s.hive.call("runs.get", { machineId: machine.name, runId: "empty-fast" }, admin))?.status, "failed");
    await s.create("T-group");
    const group = await s.hive.call("runs.dispatchMany", { project: "app", items: [{ taskId: "T-group", machineId: machine.name }] }, admin);
    const req = (await s.beat()).runRequests.find((r) => r.taskId === "T-group")!;
    await s.finish(req, "plan-group"); await s.hive.call("runs.cancelGroup", { id: group.id }, admin);
    s.later(2); assert.equal((await s.beat()).runRequests.length, 0);
    assert.equal((await s.plans())[0]?.status, "cancelled"); s.hive.close();
  });
  it("cancels an assigned plan without automatically dispatching it again", async () => {
    const s = await setup("all", 1); await s.create("ASSIGNED-1");
    await s.hive.call("tasks.assign", { id: "ASSIGNED-1", machineId: machine.name }, admin);
    const req = (await s.beat()).runRequests[0]!; await s.finish(req, "assigned-plan");
    const plan = (await s.plans())[0]!;
    await s.hive.call("runs.decidePlan", { id: plan.id, revision: 1, decision: "cancel" }, admin);
    s.later(2); assert.equal((await s.beat()).runRequests.length, 0);
    assert.equal((await s.hive.call("tasks.list", { project: "app" }, admin))[0]?.agent?.hold?.key, "errors.agentRunCancelled");
    assert.equal((await s.plans())[0]?.status, "cancelled"); s.hive.close();
  });
  it("fails closed on unsupported runners, empty/failed plans, and preserves off/small behavior", async () => {
    const old = await setup("all", null, false); await old.create("T-1"); await assert.rejects(old.dispatch("T-1"));
    assert.equal((await old.hive.call("runs.requests", {}, admin)).length, 0); old.hive.close();
    const s = await setup("medium-large"); await s.create("T-s", "s"); assert.equal((await s.dispatch("T-s")).plan, null);
    await s.create("T-empty"); const req = await s.dispatch("T-empty"); await s.finish(req, "empty", "");
    assert.equal((await s.plans())[0]?.status, "failed"); assert.equal((await s.beat()).runRequests.filter((r) => r.taskId === "T-empty").length, 0);
    s.hive.close();
  });
});
