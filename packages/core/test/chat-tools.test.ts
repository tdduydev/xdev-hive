import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HiveError, toolSetupItems, type Actor, type SetupReport } from "#core/index.ts";
import { SqliteHive } from "#core/node.ts";

const admin: Actor = { name: "duy", role: "admin" };
const mbp: Actor = { name: "runner.duy-mbp@duy-mbp", role: "agent" };
// Lan leads app. Hoa may chat and confirm the leader's actions but not change the project's settings.
const lan: Actor = { name: "lan", role: "member", account: "lan", access: { projects: { app: "lead" } }, source: { via: "web" } };
const hoa: Actor = { name: "hoa", role: "member", account: "hoa", access: { projects: { app: { permissions: ["view", "chatUse", "chatApprove"] } } }, source: { via: "web" } };

const profile = (id: string) => ({ id, label: id, kind: "claude", enabled: true, account: null, installed: true, loggedIn: true, cooldownUntil: null, runs: 0, rateLimited: 0 });

async function setup() {
  const hive = new SqliteHive(":memory:");
  await hive.call("machines.heartbeat", { machine: "duy-mbp", instance: "a1b2c3d4", profiles: [profile("claude-1")], projects: ["app"], acceptsRuns: true }, mbp);
  await hive.call("tasks.create", { id: "T-1", project: "app", title: "Sign in" }, admin);
  /** The leader of a reply to `who`'s message, with what the hub would cut its token to. */
  const leaderFor = async (who: Actor) => {
    const sent = await hive.call("chat.send", { project: "app", machineId: mbp.name, text: "Turn codegraph on" }, who);
    await hive.call("chat.progress", { replyId: sent.reply.id, text: "…" }, mbp);
    const leader: Actor = { name: "claude-1.duy-mbp@chat", role: "agent", access: { projects: { app: "member" } }, agent: "claude-1.duy-mbp", chatReply: sent.reply.id, source: { via: "mcp" } };
    return leader;
  };
  const propose = (leader: Actor, action: Record<string, unknown>) => hive.call("chat.propose", { action: action as never, reason: "Asked in the chat" }, leader);
  const setting = async (id: string) => (await hive.call("tools.list", { project: "app" }, admin)).find((t) => t.id === id)!.projects[0]!;
  return { hive, leaderFor, propose, setting };
}
const fails = (key: string) => (e: unknown) => e instanceof HiveError && e.key === key;

describe("the leader proposes a project's tools (roadmap 28e)", () => {
  it("keeps the setting before, and runs as tools.setProject with the confirmer's Project settings right", async () => {
    const { hive, leaderFor, propose, setting } = await setup();
    const leader = await leaderFor(lan);
    const on = await propose(leader, { kind: "tool.enable", id: "codegraph", enabled: true });
    assert.equal(on.status, "proposed");
    assert.deepEqual(on.input, { id: "codegraph", project: "app", enabled: true, required: false, name: "Codegraph", before: { enabled: null, required: false, effective: false } });
    await assert.rejects(propose(leader, { kind: "tool.enable", id: "nope", enabled: true }), fails("errors.toolNotFound"));

    // Hoa may confirm the leader's actions, but turning a tool on is the project's settings.
    const byHoa = await hive.call("chat.decide", { actionId: on.id, accept: true }, hoa);
    assert.deepEqual([byHoa.status, byHoa.error?.key], ["failed", "errors.need.projectSettings"]);
    assert.equal((await setting("codegraph")).effective, false);

    const again = await propose(leader, { kind: "tool.enable", id: "codegraph", enabled: true });
    assert.equal((await hive.call("chat.decide", { actionId: again.id, accept: true }, lan)).status, "done");
    assert.deepEqual(await setting("codegraph"), { project: "app", enabled: true, required: false, effective: true });
    const entry = (await hive.call("admin.audit", { limit: 10 }, admin)).find((e) => e.action === "tools.setProject")!;
    assert.deepEqual([entry.actor, entry.target], ["lan", "app/codegraph"]);
  });

  it("keeps a requirement the project set when the proposal leaves required out", async () => {
    const { hive, leaderFor, propose, setting } = await setup();
    await hive.call("tools.setProject", { id: "speckit", project: "app", enabled: true, required: true }, lan);
    const leader = await leaderFor(lan);
    const off = await propose(leader, { kind: "tool.enable", id: "speckit", enabled: false });
    assert.deepEqual([off.input.required, off.input.before], [true, { enabled: true, required: true, effective: true }]);
    const back = await propose(leader, { kind: "tool.enable", id: "speckit", enabled: null, required: false });
    await hive.call("chat.decideAll", { replyId: leader.chatReply!, accept: true }, lan);
    assert.deepEqual(await setting("speckit"), { project: "app", enabled: null, required: false, effective: false }, "the last one confirmed: back to the default");
    assert.equal(back.input.required, false);
  });

  it("runs alone when the project lets its leader, as the sender, and never past the sender's rights", async () => {
    const { hive, leaderFor, propose, setting } = await setup();
    await hive.call("chat.setAutonomy", { project: "app", kinds: ["tool.enable"] }, lan);
    const forHoa = await propose(await leaderFor(hoa), { kind: "tool.enable", id: "superpowers", enabled: true });
    assert.deepEqual([forHoa.status, forHoa.auto, forHoa.error], ["proposed", false, null], "Hoa lacks Project settings: it waits for someone who has it");
    const forLan = await propose(await leaderFor(lan), { kind: "tool.enable", id: "superpowers", enabled: true });
    assert.deepEqual([forLan.status, forLan.auto, forLan.decidedBy], ["done", true, "lan"]);
    assert.equal((await setting("superpowers")).effective, true);
  });

  it("confirms all with the tool turned on before the runs that use it", async () => {
    const { hive, leaderFor, propose } = await setup();
    const leader = await leaderFor(lan);
    await propose(leader, { kind: "run.dispatch", taskId: "T-1" });
    await propose(leader, { kind: "tool.enable", id: "codegraph", enabled: true });
    const all = await hive.call("chat.decideAll", { replyId: leader.chatReply!, accept: true }, lan);
    assert.deepEqual(all.map((a) => [a.kind, a.status]), [["run.dispatch", "done"], ["tool.enable", "done"]], "listed as proposed");
    // The audit log is newest first: the run was queued after the tool was on.
    const ran = (await hive.call("admin.audit", { limit: 10 }, admin)).map((e) => e.action).filter((a) => a === "tools.setProject" || a === "runs.dispatch");
    assert.deepEqual(ran, ["runs.dispatch", "tools.setProject"]);
  });
});

describe("tools.status (roadmap 28e)", () => {
  const item = (id: string, state: "installed" | "missing", detail = "") => ({ id, label: id, state, detail, action: state === "missing" ? "Cài" : null });

  it("shows each tool's items on the project's machines as they reported them, no paths, for the project's readers only", async () => {
    const hive = new SqliteHive(":memory:");
    const report: SetupReport = {
      machine: [item("cli:specify", "installed", "1.0.14 /Users/duy/.local/bin/specify"), item("cli:codex", "missing")],
      projects: [
        { project: "app", repo: "/Users/duy/app", items: [item("app:codegraph-mcp", "installed"), item("app:codegraph-index", "missing"), item("app:speckit", "missing")] },
        { project: "site", repo: "/Users/duy/site", items: [item("site:speckit", "installed")] },
      ],
    };
    await hive.call("machines.heartbeat", { machine: "duy-mbp", instance: "a1b2c3d4", projects: ["app", "site"], setup: { checkedAt: "2026-10-02T04:00:00.000Z", report } }, mbp);
    // A machine that has not reported its setup is left out; one without the project too.
    await hive.call("machines.heartbeat", { machine: "lan-pc", instance: "bbbbbbbb", projects: ["app"] }, { name: "runner.lan-pc@lan", role: "agent" });
    await hive.call("tools.setProject", { id: "codegraph", project: "app", enabled: true, required: true }, admin);

    const status = await hive.call("tools.status", { project: "app" }, hoa);
    const byId = Object.fromEntries(status.map((s) => [s.id, s]));
    assert.deepEqual(Object.keys(byId).sort(), ["codegraph", "speckit", "superpowers"]);
    assert.deepEqual([byId.codegraph!.effective, byId.codegraph!.required, byId.codegraph!.items], [true, true, ["app:codegraph-mcp", "app:codegraph-index"]]);
    assert.deepEqual(
      byId.codegraph!.machines.map((m) => [m.machine, m.items.map((i) => [i.id, i.state])]),
      [["duy-mbp", [["app:codegraph-mcp", "installed"], ["app:codegraph-index", "missing"]]]],
    );
    assert.deepEqual(
      byId.speckit!.machines[0]!.items.map((i) => [i.id, i.state]),
      [["cli:specify", "installed"], ["app:speckit", "missing"]],
      "the machine's CLI and this project's part, not site's",
    );
    assert.deepEqual(byId.superpowers!.machines[0]!.items, [], "nothing reported for it");
    assert.equal(JSON.stringify(status).includes("/Users/duy"), false, "no home path");
    for (const i of byId.speckit!.machines[0]!.items) assert.equal("action" in i, false);

    const siteOnly: Actor = { name: "minh", role: "member", access: { projects: { site: "view" } } };
    await assert.rejects(hive.call("tools.status", { project: "app" }, siteOnly), (e: unknown) => e instanceof HiveError && e.code === "not_found");
  });

  it("names a seed's items as the app checks them, and any other tool by tool:<id>", () => {
    assert.deepEqual(toolSetupItems({ id: "codegraph", handler: "codegraph" }, "app"), ["app:codegraph-mcp", "app:codegraph-index"]);
    assert.deepEqual(toolSetupItems({ id: "speckit", handler: "speckit" }, "app"), ["cli:specify", "app:speckit"]);
    assert.deepEqual(toolSetupItems({ id: "rtk", handler: null }, "app"), ["tool:rtk"]);
  });
});
