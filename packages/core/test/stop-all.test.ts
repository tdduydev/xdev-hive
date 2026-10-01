import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HiveError, type Actor, type HiveEvent } from "#core/index.ts";
import { SqliteHive } from "#core/node.ts";

// Stop-all (roadmap 27d, docs/specs/27bcd-governance.md).
const admin: Actor = { name: "duy", role: "admin" };
const mbp: Actor = { name: "runner.duy-mbp@duy-mbp", role: "agent" };
const lead: Actor = { name: "lan", role: "member", access: { projects: { app: "lead" } } };
const dev: Actor = { name: "minh", role: "member", access: { projects: { app: "member" } } };
const agent: Actor = { name: "claude-1.duy-mbp@duy", role: "agent" };

const profile = (id: string) => ({ id, label: id, kind: "claude", enabled: true, account: null, installed: true, cooldownUntil: null, runs: 0, rateLimited: 0 });

async function hub() {
  const events: HiveEvent[] = [];
  const hive = new SqliteHive(":memory:", { now: () => new Date("2026-10-01T08:00:00.000Z"), onEvent: (e) => events.push(e) });
  for (const [id, project] of [["T-1", "app"], ["T-2", "app"], ["S-1", "site"]] as const) await hive.call("tasks.create", { id, project, title: id }, admin);
  const beat = (actor: Actor = mbp, over: Record<string, unknown> = {}) =>
    hive.call(
      "machines.heartbeat",
      { machine: actor.name.split("@")[1]!, instance: "a1b2c3d4", profiles: [profile("claude-1")], projects: ["app", "site"], acceptsRuns: true, ...over },
      actor,
    );
  const push = (runId: string, status: "queued" | "running", project = "app", taskId = "T-1") =>
    hive.call(
      "runs.push",
      {
        machine: "duy-mbp",
        runs: [{ runId, project, taskId, taskTitle: taskId, role: "implement", status, profileId: "claude-1", createdAt: "2026-10-01T07:00:00.000Z" }],
      },
      mbp,
    );
  return { hive, beat, push, events };
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

describe("stop all agents", () => {
  it("cancels the scope's waiting requests, asks the machine to stop its running runs and pauses the scope", async () => {
    const { hive, beat, push, events } = await hub();
    await beat();
    const app = await hive.call("runs.dispatch", { machineId: mbp.name, project: "app", taskId: "T-1" }, admin);
    const site = await hive.call("runs.dispatch", { machineId: mbp.name, project: "site", taskId: "S-1" }, admin);
    await push("R-aaaaaa", "running");
    await push("R-bbbbbb", "queued", "app", "T-2");
    await push("R-cccccc", "running", "site", "S-1");

    const stop = await hive.call("agents.stop", { project: "app" }, lead);
    assert.deepEqual([stop.project, stop.requests, stop.runs, stop.chats], ["app", 1, 1, 0]);
    assert.deepEqual(stop.paused, { hub: false, projects: ["app"], by: { app: { name: "lan", at: "2026-10-01T08:00:00.000Z" } } });

    const requests = await hive.call("runs.requests", {}, admin);
    assert.equal(requests.find((r) => r.id === app.id)!.status, "cancelled");
    assert.equal(requests.find((r) => r.id === site.id)!.status, "pending", "another project's request stays");
    const res = await beat();
    // Only the running one: a queued run waits in the machine's queue until the pause is lifted.
    assert.deepEqual(res.cancelRuns, [{ runId: "R-aaaaaa", requestedBy: "lan" }]);
    assert.deepEqual(res.paused.projects, ["app"]);
    assert.equal(res.paused.hub, false);
    assert.deepEqual(res.runRequests.map((r) => r.id), [site.id]);
    assert.deepEqual((await hive.call("agents.paused", {}, dev)).projects, ["app"]);

    // Audited, and heard by the webhooks.
    const [entry] = await hive.call("admin.audit", { action: "agents.stop" }, admin);
    assert.deepEqual([entry!.actor, entry!.target, entry!.detailKey, entry!.detailVars], ["lan", "app", "audit.agentsStop", { requests: 1, runs: 1, chats: 0 }]);
    const stopped = events.find((e) => e.type === "agents.stopped");
    assert.ok(stopped && stopped.type === "agents.stopped");
    assert.deepEqual([stopped.project, stopped.by, stopped.stop.runs], ["app", "lan", 1]);
  });

  it("refuses runs and the leader's chat while paused, and lets them again once resumed", async () => {
    const { hive, beat, events } = await hub();
    await beat();
    await hive.call("agents.stop", { project: "app" }, lead);
    assert.equal(await refusal(hive.call("runs.dispatch", { machineId: mbp.name, project: "app", taskId: "T-1" }, admin)), "errors.agentsPaused");
    assert.equal(await refusal(hive.call("chat.send", { project: "app", machineId: mbp.name, text: "hi" }, admin)), "errors.agentsPaused");
    // Another project goes on.
    await hive.call("runs.dispatch", { machineId: mbp.name, project: "site", taskId: "S-1" }, admin);

    const resumed = await hive.call("agents.resume", { project: "app" }, lead);
    assert.deepEqual(resumed, { hub: false, projects: [], by: {} });
    assert.deepEqual((await beat()).paused, { hub: false, projects: [], by: {} });
    await hive.call("runs.dispatch", { machineId: mbp.name, project: "app", taskId: "T-1" }, admin);
    const [entry] = await hive.call("admin.audit", { action: "agents.resume" }, admin);
    assert.deepEqual([entry!.actor, entry!.target], ["lan", "app"]);
    assert.ok(events.some((e) => e.type === "agents.resumed" && e.project === "app" && e.by === "lan"));
  });

  it("pauses every project for the whole hub, apart from a project's own pause", async () => {
    const { hive, beat, push } = await hub();
    await beat();
    await push("R-aaaaaa", "running");
    await push("R-cccccc", "running", "site", "S-1");
    const stop = await hive.call("agents.stop", { project: null }, admin);
    assert.deepEqual([stop.project, stop.runs, stop.paused.hub], [null, 2, true]);
    assert.deepEqual((await beat()).cancelRuns.map((c) => c.runId).sort(), ["R-aaaaaa", "R-cccccc"]);
    assert.equal(await refusal(hive.call("runs.dispatch", { machineId: mbp.name, project: "site", taskId: "S-1" }, admin)), "errors.agentsPaused");
    const [entry] = await hive.call("admin.audit", { action: "agents.stop" }, admin);
    assert.equal(entry!.target, "hub");

    await hive.call("agents.stop", { project: "app" }, lead);
    await hive.call("agents.resume", { project: null }, admin);
    const paused = await hive.call("agents.paused", {}, admin);
    assert.deepEqual([paused.hub, paused.projects, Object.keys(paused.by)], [false, ["app"], ["app"]], "the project's pause stays");
    await hive.call("runs.dispatch", { machineId: mbp.name, project: "site", taskId: "S-1" }, admin);
  });

  it("lets a project's lead stop that project only, never the whole hub; members and agents not at all", async () => {
    const { hive, beat } = await hub();
    await beat();
    assert.equal(await refusal(hive.call("agents.stop", { project: null }, lead)), "errors.hubAdminOnly");
    assert.equal(await refusal(hive.call("agents.resume", { project: null }, lead)), "errors.hubAdminOnly");
    assert.equal(await refusal(hive.call("agents.stop", { project: "site" }, lead)), "errors.notFound", "a project it cannot see");
    assert.equal(await refusal(hive.call("agents.stop", { project: "app" }, dev)), "errors.need.runDispatch");
    assert.equal(await refusal(hive.call("agents.stop", { project: "app" }, agent)), "errors.need.runDispatch");
    assert.equal(await refusal(hive.call("agents.stop", { project: null }, agent)), "errors.hubAdminOnly");
    await hive.call("agents.stop", { project: "app" }, lead);
    assert.equal(await refusal(hive.call("agents.resume", { project: "app" }, dev)), "errors.need.runDispatch");
    assert.deepEqual((await hive.call("agents.paused", {}, admin)).projects, ["app"]);
  });

  it("tells a machine only of the paused projects its token sees", async () => {
    const { hive, beat } = await hub();
    const appOnly: Actor = { name: "runner.lan-mini@lan-mini", role: "agent", access: { projects: { app: "member" } } };
    await beat(appOnly);
    await hive.call("agents.stop", { project: "site" }, admin);
    await hive.call("agents.stop", { project: "app" }, admin);
    const res = await beat(appOnly);
    assert.deepEqual([res.paused.projects, Object.keys(res.paused.by)], [["app"], ["app"]]);
    assert.deepEqual((await hive.call("agents.paused", {}, lead)).projects, ["app"]);
  });

  it("cancels the scope's chat replies still waiting", async () => {
    const { hive, beat } = await hub();
    await beat();
    const sent = await hive.call("chat.send", { project: "app", machineId: mbp.name, text: "hi" }, admin);
    const stop = await hive.call("agents.stop", { project: "app" }, admin);
    assert.equal(stop.chats, 1);
    const thread = await hive.call("chat.get", { threadId: sent.thread.id }, admin);
    assert.equal(thread!.messages.find((m) => m.id === sent.reply.id)!.status, "cancelled");
  });
});
