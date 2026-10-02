import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HiveError, type Actor } from "#core/index.ts";
import { SqliteHive } from "#core/node.ts";

const admin: Actor = { name: "duy", role: "admin" };
const mbp: Actor = { name: "runner.duy-mbp@duy-mbp", role: "agent" };
// Lan leads app. Hoa may chat and confirm the leader's actions but not create tasks. Minh only chats.
const lan: Actor = { name: "lan", role: "member", account: "lan", access: { projects: { app: "lead" } }, source: { via: "web" } };
const hoa: Actor = { name: "hoa", role: "member", account: "hoa", access: { projects: { app: { permissions: ["view", "chatUse", "chatApprove"] } } }, source: { via: "web" } };
const minh: Actor = { name: "minh", role: "member", account: "minh", access: { projects: { app: { permissions: ["view", "chatUse", "taskManage"] } } }, source: { via: "web" } };

const profile = (id: string) => ({ id, label: id, kind: "claude", enabled: true, account: null, installed: true, loggedIn: true, cooldownUntil: null, runs: 0, rateLimited: 0 });

async function setup() {
  const hive = new SqliteHive(":memory:");
  await hive.call("machines.heartbeat", { machine: "duy-mbp", instance: "a1b2c3d4", profiles: [profile("claude-1")], projects: ["app"], acceptsRuns: true }, mbp);
  await hive.call("tasks.create", { id: "T-1", project: "app", title: "Sign in" }, admin);
  /** The leader of a reply to `who`'s message, with what the hub would cut its token to. */
  const leaderFor = async (who: Actor) => {
    const sent = await hive.call("chat.send", { project: "app", machineId: mbp.name, text: "Plan it" }, who);
    await hive.call("chat.progress", { replyId: sent.reply.id, text: "…" }, mbp);
    const leader: Actor = { name: "claude-1.duy-mbp@chat", role: "agent", access: { projects: { app: "member" } }, agent: "claude-1.duy-mbp", chatReply: sent.reply.id, source: { via: "mcp" } };
    return leader;
  };
  const propose = (leader: Actor, action: Record<string, unknown>) => hive.call("chat.propose", { action: action as never, reason: "Asked in the chat" }, leader);
  return { hive, leaderFor, propose };
}
const fails = (key: string) => (e: unknown) => e instanceof HiveError && e.key === key;

describe("leader runs what the project lets it (roadmap 29c)", () => {
  it("is set per project by someone with Project settings, never for the kinds that loosen the leader's limits", async () => {
    const { hive } = await setup();
    assert.deepEqual((await hive.call("chat.defaults", { project: "app" }, lan)).autoKinds, [], "none by default");
    await assert.rejects(hive.call("chat.setAutonomy", { project: "app", kinds: ["task.create"] }, minh), fails("errors.need.projectSettings"));
    await assert.rejects(hive.call("chat.setAutonomy", { project: "app", kinds: ["task.create", "agent.policy"] }, lan), fails("errors.chatAutoNever"));
    await assert.rejects(hive.call("chat.setAutonomy", { project: "app", kinds: ["agents.resume"] }, lan), fails("errors.chatAutoNever"));
    assert.deepEqual((await hive.call("chat.setAutonomy", { project: "app", kinds: ["task.create", "run.dispatch"] }, lan)).autoKinds, ["task.create", "run.dispatch"]);
  });

  it("runs an allowed kind at once as the sender, logs the leader acting for them, and leaves the rest to a person", async () => {
    const { hive, leaderFor, propose } = await setup();
    await hive.call("chat.setAutonomy", { project: "app", kinds: ["task.create", "run.dispatch"] }, lan);
    const leader = await leaderFor(lan);
    const made = await propose(leader, { kind: "task.create", id: "T-2", title: "Reset page", dependsOn: [] });
    assert.deepEqual([made.status, made.auto, made.decidedBy], ["done", true, "lan"]);
    assert.equal((await hive.call("tasks.list", { project: "app" }, admin)).some((t) => t.id === "T-2"), true);
    const entry = (await hive.call("admin.audit", { limit: 20 }, admin)).find((e) => e.action === "tasks.create" && e.target === "T-2")!;
    assert.deepEqual([entry.agent, entry.onBehalf], ["claude-1.duy-mbp", "lan"], "the leader, for Lan");
    const run = await propose(leader, { kind: "run.dispatch", taskId: "T-2" });
    assert.deepEqual([run.status, run.auto], ["done", true]);
    assert.equal(typeof run.result?.requestId, "number");
    // Not allowed: waits.
    const move = await propose(leader, { kind: "task.update", id: "T-1", status: "blocked" });
    assert.deepEqual([move.status, move.auto], ["proposed", false]);
    // The project's stop is not loosened by the leader either way; its policy always waits too.
    const policy = await propose(leader, { kind: "agent.policy", policy: { autonomy: "full" } });
    assert.equal(policy.status, "proposed");
  });

  it("waits for a task this reply only proposes to create", async () => {
    const { hive, leaderFor, propose } = await setup();
    await hive.call("chat.setAutonomy", { project: "app", kinds: ["run.dispatch"] }, lan);
    const leader = await leaderFor(lan);
    await propose(leader, { kind: "task.create", id: "T-3", title: "Later", dependsOn: [] });
    const run = await propose(leader, { kind: "run.dispatch", taskId: "T-3" });
    assert.equal(run.status, "proposed");
    // Confirming all now creates it, then queues the run, as before.
    const all = await hive.call("chat.decideAll", { replyId: leader.chatReply!, accept: true }, lan);
    assert.deepEqual(all.map((a) => [a.kind, a.status, a.auto]), [["task.create", "done", false], ["run.dispatch", "done", false]]);
  });

  it("never runs past the sender: one who could not confirm it, or lacks the action's own right, leaves it waiting", async () => {
    const { hive, leaderFor, propose } = await setup();
    await hive.call("chat.setAutonomy", { project: "app", kinds: ["task.create"] }, lan);
    // Minh may create tasks but not confirm the leader's actions.
    const forMinh = await propose(await leaderFor(minh), { kind: "task.create", id: "T-4", title: "x", dependsOn: [] });
    assert.deepEqual([forMinh.status, forMinh.auto], ["proposed", false]);
    // Hoa may confirm but not create tasks: it waits for someone who may, not failed.
    const forHoa = await propose(await leaderFor(hoa), { kind: "task.create", id: "T-5", title: "y", dependsOn: [] });
    assert.deepEqual([forHoa.status, forHoa.auto, forHoa.error], ["proposed", false, null]);
    assert.equal((await hive.call("tasks.list", { project: "app" }, admin)).some((t) => t.id === "T-4" || t.id === "T-5"), false);
    assert.equal((await hive.call("chat.decide", { actionId: forHoa.id, accept: true }, lan)).status, "done");
  });
});
