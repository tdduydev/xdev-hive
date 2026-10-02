import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HiveError, type Actor } from "#core/index.ts";
import { SqliteHive } from "#core/node.ts";

// The shop system: api and web. Lan leads both, Minh works on web only, Khoa leads crm (no system with them).
const admin: Actor = { name: "duy", role: "admin" };
const mbp: Actor = { name: "runner.duy-mbp@duy-mbp", role: "agent" };
const lan: Actor = { name: "lan", role: "member", account: "lan", access: { projects: { api: "lead", web: "lead", crm: "lead" } } };
const minh: Actor = { name: "minh", role: "member", account: "minh", access: { projects: { web: "lead" } } };

const profile = (id: string) => ({ id, label: id, kind: "claude", enabled: true, account: null, installed: true, loggedIn: true, cooldownUntil: null, runs: 0, rateLimited: 0 });

async function setup() {
  const hive = new SqliteHive(":memory:");
  await hive.call("systems.save", { name: "shop", projects: ["api", "web"] }, admin);
  await hive.call("tasks.create", { id: "API-1", project: "api", title: "Orders API" }, admin);
  await hive.call("tasks.create", { id: "CRM-1", project: "crm", title: "Contacts" }, admin);
  return hive;
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

describe("tasks across the services of a system (roadmap 19d)", () => {
  it("lets a service's task wait for another service's, and holds it until that one is done", async () => {
    const hive = await setup();
    const web = await hive.call("tasks.create", { id: "WEB-1", project: "web", title: "Orders page", dependsOn: ["API-1"] }, lan);
    assert.deepEqual([web.dependsOn, web.waitingOn, web.depProjects], [["API-1"], ["API-1"], { "API-1": "api" }]);
    assert.deepEqual((await hive.call("tasks.next", { project: "web" }, admin)).map((t) => t.id), [], "waits for the API");
    assert.equal(await refusal(hive.call("tasks.claim", { id: "WEB-1" }, { name: "claude-1.duy-mbp@duy", role: "agent" })), "errors.taskWaiting");
    await hive.call("tasks.update", { id: "API-1", status: "done" }, admin);
    assert.deepEqual((await hive.call("tasks.next", { project: "web" }, admin)).map((t) => t.id), ["WEB-1"]);
  });

  it("refuses a dependency on a project in no system with it", async () => {
    const hive = await setup();
    assert.equal(await refusal(hive.call("tasks.create", { id: "WEB-2", project: "web", title: "x", dependsOn: ["CRM-1"] }, lan)), "errors.taskDepProject");
    await hive.call("tasks.create", { id: "WEB-3", project: "web", title: "y" }, lan);
    assert.equal(await refusal(hive.call("tasks.setDeps", { id: "WEB-3", dependsOn: ["CRM-1"] }, lan)), "errors.taskDepProject");
  });

  it("shows a reader who cannot see the other service how many it waits for, not which, and keeps them on save", async () => {
    const hive = await setup();
    await hive.call("tasks.create", { id: "WEB-1", project: "web", title: "Orders page", dependsOn: ["API-1"] }, lan);
    await hive.call("tasks.create", { id: "WEB-0", project: "web", title: "Layout" }, minh);
    const seen = (await hive.call("tasks.list", { project: "web" }, minh)).find((t) => t.id === "WEB-1")!;
    assert.deepEqual([seen.dependsOn, seen.waitingOn, seen.waitingHidden, seen.depProjects], [[], [], 1, undefined]);
    // A dependency in a project Minh does not see is not there for him.
    assert.equal(await refusal(hive.call("tasks.setDeps", { id: "WEB-1", dependsOn: ["API-1"] }, minh)), "errors.taskNotFound");
    // Saving what he sees keeps what he does not.
    const saved = await hive.call("tasks.setDeps", { id: "WEB-1", dependsOn: ["WEB-0"] }, minh);
    assert.deepEqual((await hive.call("tasks.list", { project: "web" }, admin)).find((t) => t.id === "WEB-1")!.dependsOn, ["API-1", "WEB-0"]);
    assert.ok(saved);
  });

  it("lets a leader of one service propose a task for another service of its system, waiting on its own", async () => {
    const hive = await setup();
    await hive.call("machines.heartbeat", { machine: "duy-mbp", instance: "a1b2c3d4", profiles: [profile("claude-1")], projects: ["api", "web"], acceptsRuns: true }, mbp);
    const sent = await hive.call("chat.send", { project: "api", machineId: mbp.name, text: "Plan orders across the shop" }, lan);
    // The machine hears the project's systems with the request, for the leader's brief.
    const beat = await hive.call("machines.heartbeat", { machine: "duy-mbp", instance: "a1b2c3d4", projects: ["api", "web"], acceptsRuns: true }, mbp);
    assert.deepEqual(beat.chatRequests[0]?.systems, [{ name: "shop", projects: ["api", "web"] }]);
    await hive.call("chat.progress", { replyId: sent.reply.id, text: "Planning" }, mbp);
    const leader: Actor = { name: "claude-1.duy-mbp@chat-lan", role: "agent", access: lan.access, chatReply: sent.reply.id };
    await hive.call("chat.propose", { action: { kind: "task.create", id: "API-2", title: "Refund API" }, reason: "API first" }, leader);
    const web = await hive.call("chat.propose", { action: { kind: "task.create", id: "WEB-9", project: "web", title: "Refund page", dependsOn: ["API-2"] }, reason: "Then the page" }, leader);
    assert.equal((web.input as { project: string }).project, "web");
    await hive.call("chat.propose", { action: { kind: "task.create", id: "WEB-8", project: "web", title: "Order list" }, reason: "Needs nothing new" }, leader);
    // WEB-9 waits for API-2, so a run of it now would be refused; WEB-8 can start at once.
    const run = await hive.call("chat.propose", { action: { kind: "run.dispatch", taskId: "WEB-8" }, reason: "Build it" }, leader);
    assert.equal((run.input as { project: string }).project, "web", "the run goes to the task's service");
    assert.equal(
      await refusal(hive.call("chat.propose", { action: { kind: "task.create", id: "CRM-9", project: "crm", title: "x" }, reason: "r" }, leader)),
      "errors.chatProjectOutside",
    );
    const done = await hive.call("chat.decideAll", { replyId: sent.reply.id, accept: true }, lan);
    assert.deepEqual(done.map((a) => a.status), ["done", "done", "done", "done"]);
    const created = (await hive.call("tasks.list", { project: "web" }, admin)).find((t) => t.id === "WEB-9")!;
    assert.deepEqual([created.project, created.dependsOn], ["web", ["API-2"]]);
  });
});
