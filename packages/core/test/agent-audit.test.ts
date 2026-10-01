import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HiveError, isAgentActor, MR_WATCHER, principalOf, type Actor } from "#core/index.ts";
import { SqliteHive } from "#core/node.ts";

const admin: Actor = { name: "duy", role: "admin" };
/** People of a hub (role member), each with a grant on web: a lead may approve everything there, a reviewer too. */
const lan: Actor = { name: "lan", role: "member", access: { projects: { web: "lead" } } };
const rv: Actor = { name: "rv", role: "member", access: { projects: { web: "reviewer" } } };
/** What the hub makes of an agent on a person's token (app.ts tokenActor): its label, the account, the run. */
const agentOf = (person: Actor, label: string, run: string): Actor => ({
  name: `${label}@${person.name}-mbp`,
  role: "agent",
  ...(person.access ? { access: person.access } : {}),
  source: { via: "mcp", machine: `${person.name}-mbp`, run, task: "web-1" },
  agent: label,
  onBehalf: person.name,
  run,
});
/** A machine's runner on a person's token (role member, as a desktop sign-in gives). */
const runnerOf = (person: Actor): Actor => ({
  name: `runner.${person.name}-mbp@${person.name}-mbp`,
  role: person.role === "admin" ? "admin" : "member",
  ...(person.access ? { access: person.access } : {}),
  agent: `runner.${person.name}-mbp`,
  onBehalf: person.name,
});

async function hub() {
  const hive = new SqliteHive(":memory:");
  await hive.call("tasks.create", { id: "web-1", project: "web", title: "Trang chủ" }, admin);
  await hive.call("docs.save", { key: "project/web/huong-dan", content: "v1", title: "Hướng dẫn" }, admin);
  return hive;
}

/** A run on web-1 the machine started from its Board, pushed as the runner does. */
const push = (hive: SqliteHive, runner: Actor, runId = "R-board1") =>
  hive.call(
    "runs.push",
    {
      machine: runner.name.split("@")[1]!,
      runs: [{ runId, project: "web", taskId: "web-1", taskTitle: "Trang chủ", role: "implement", status: "succeeded", profileId: "claude-1", createdAt: "2026-10-01T08:00:00.000Z" }],
    },
    runner,
  );

const key = async (call: Promise<unknown>): Promise<string | undefined> => {
  try {
    await call;
  } catch (err) {
    assert.ok(err instanceof HiveError, String(err));
    return err.key ?? err.code;
  }
  return "ok";
};

describe("agent audit log (roadmap 27c)", () => {
  it("tells agents from people", () => {
    assert.equal(isAgentActor(agentOf(lan, "claude-1", "R-1")), true);
    assert.equal(isAgentActor({ name: "runner.m@m", role: "agent", agent: "runner.m", source: { via: "api" } }), true);
    assert.equal(isAgentActor({ name: "desktop@lan-mbp", role: "member", agent: "desktop", source: { via: "desktop" } }), false, "the desktop window labels itself too");
    assert.equal(isAgentActor(lan), false);
    assert.equal(principalOf(agentOf(lan, "claude-1", "R-1")), "lan");
    assert.equal(principalOf(lan), "lan");
  });

  it("logs what an agent writes with its label, the account it acts for and its run", async () => {
    const hive = await hub();
    const claude = agentOf(lan, "claude-1.lan-mbp", "R-abc123");
    await hive.call("tasks.claim", { id: "web-1" }, claude);
    await hive.call("memory.write", { project: "web", kind: "gotcha", content: "Build cần Node 26" }, claude);
    await hive.call("proposals.create", { docKey: "project/web/huong-dan", baseVersion: 1, content: "v2", reason: "sửa" }, claude);
    await hive.call("tasks.update", { id: "web-1", status: "review", note: "xong" }, claude);
    // A person's own writes outside AUDITED stay out, as before.
    await hive.call("memory.write", { project: "web", kind: "context", content: "Lan ghi" }, lan);

    const log = await hive.call("admin.audit", {}, admin);
    const agents = log.filter((e) => e.agent !== null);
    assert.deepEqual(
      agents.map((e) => [e.action, e.agent, e.onBehalf, e.run]),
      [
        ["tasks.update", "claude-1.lan-mbp", "lan", "R-abc123"],
        ["proposals.create", "claude-1.lan-mbp", "lan", "R-abc123"],
        ["memory.write", "claude-1.lan-mbp", "lan", "R-abc123"],
        ["tasks.claim", "claude-1.lan-mbp", "lan", "R-abc123"],
      ],
    );
    assert.equal(agents[0]!.actor, claude.name);
    assert.equal(agents[0]!.detailKey, "audit.taskStatus");
    assert.equal(log.filter((e) => e.action === "memory.write").length, 1, "Lan's own memory is not an agent's");
    // A person's admin action keeps empty agent columns.
    const save = log.find((e) => e.action === "docs.save")!;
    assert.deepEqual([save.agent, save.onBehalf, save.run], [null, null, null]);
  });

  it("filters admin.audit by agent, person and run", async () => {
    const hive = await hub();
    const claude = agentOf(lan, "claude-1.lan-mbp", "R-1");
    const codex = agentOf(rv, "codex-1.rv-mini", "R-2");
    await hive.call("memory.write", { project: "web", kind: "gotcha", content: "A" }, claude);
    await hive.call("memory.write", { project: "web", kind: "gotcha", content: "B" }, codex);
    await hive.call("tasks.create", { id: "web-2", project: "web", title: "Việc của Lan" }, lan);

    const targets = async (input: Record<string, string>) => (await hive.call("admin.audit", input, admin)).map((e) => `${e.action} ${e.agent ?? e.actor}`);
    assert.deepEqual(await targets({ agent: "claude-1" }), ["memory.write claude-1.lan-mbp"], "a short label finds it on any machine");
    assert.deepEqual(await targets({ agent: "claude-1.lan-mbp" }), ["memory.write claude-1.lan-mbp"]);
    assert.deepEqual(await targets({ agent: "claude" }), [], "only whole parts of the label");
    assert.deepEqual(await targets({ user: "lan" }), ["tasks.create lan", "memory.write claude-1.lan-mbp"], "a person's own rows and their agents'");
    assert.deepEqual(await targets({ run: "R-2" }), ["memory.write codex-1.rv-mini"]);
    assert.deepEqual(await targets({ user: "lan", run: "R-2" }), []);
    await assert.rejects(hive.call("admin.audit", { run: "R-1" }, lan), (e: unknown) => e instanceof HiveError && e.code === "forbidden");
  });
});

describe("no approving your own work (roadmap 27c)", () => {
  it("refuses a lead and a reviewer their own proposal, memory, and task whose run they asked for", async () => {
    for (const person of [lan, rv]) {
      const hive = await hub();
      const agent = agentOf(person, "claude-1", "R-1");
      // Written by their agent: counts as theirs.
      const p = await hive.call("proposals.create", { docKey: "project/web/huong-dan", baseVersion: 1, content: "v2", reason: "sửa" }, agent);
      assert.equal(await key(hive.call("proposals.approve", { id: p.id }, person)), "errors.selfApprove", person.name);
      assert.equal(await key(hive.call("proposals.reject", { id: p.id }, person)), "ok", "taking your own back is fine");
      const own = await hive.call("proposals.create", { docKey: "project/web/huong-dan", baseVersion: 1, content: "v3", reason: "tự viết" }, person);
      assert.equal(await key(hive.call("proposals.approve", { id: own.id }, person)), "errors.selfApprove");
      assert.equal((await hive.call("proposals.approve", { id: own.id }, admin)).status, "approved", "someone else approves it");

      const m = await hive.call("memory.write", { project: "web", kind: "gotcha", content: "x" }, agent);
      assert.equal(await key(hive.call("memory.approve", { id: m.id }, person)), "errors.selfApprove");

      await push(hive, runnerOf(person));
      await hive.call("tasks.update", { id: "web-1", status: "review" }, agent);
      assert.equal(await key(hive.call("tasks.update", { id: "web-1", status: "done" }, person)), "errors.selfApprove");
      assert.equal((await hive.call("tasks.update", { id: "web-1", status: "done" }, admin)).status, "done");
    }
  });

  it("counts a run asked for from the web as the asker's, not the machine owner's", async () => {
    const hive = await hub();
    const runner = runnerOf(rv);
    await hive.call("machines.heartbeat", { machine: "rv-mbp", instance: "a1b2c3d4", projects: ["web"], acceptsRuns: true }, runner);
    const req = await hive.call("runs.dispatch", { machineId: runner.name, project: "web", taskId: "web-1" }, lan);
    await hive.call("runs.requestResult", { id: req.id, status: "accepted", runId: "R-web1" }, runner);
    await push(hive, runner, "R-web1");
    await hive.call("tasks.update", { id: "web-1", status: "review" }, runner);
    assert.equal(await key(hive.call("tasks.update", { id: "web-1", status: "done" }, lan)), "errors.selfApprove", "Lan asked for the run");
    assert.equal((await hive.call("tasks.update", { id: "web-1", status: "done" }, rv)).status, "done", "the machine's owner did not");
  });

  it("lets a hub admin approve their own while selfApproval is admins, the default, and nobody when it is nobody", async () => {
    const hive = await hub();
    assert.equal((await hive.call("policy.get", {}, admin)).selfApproval, "admins");
    const agent = agentOf(admin, "claude-1", "R-1");
    const p1 = await hive.call("proposals.create", { docKey: "project/web/huong-dan", baseVersion: 1, content: "v2", reason: "a" }, agent);
    assert.equal((await hive.call("proposals.approve", { id: p1.id }, admin)).status, "approved");

    await hive.call("policy.set", { selfApproval: "nobody" }, admin);
    // Saved from an app older than 27c (no selfApproval): the rule stays.
    await hive.call("policy.set", { requiredClis: ["claude"] }, admin);
    assert.equal((await hive.call("policy.get", {}, admin)).selfApproval, "nobody");

    const p2 = await hive.call("proposals.create", { docKey: "project/web/huong-dan", baseVersion: 2, content: "v3", reason: "b" }, agent);
    assert.equal(await key(hive.call("proposals.approve", { id: p2.id }, admin)), "errors.selfApprove");
    const m = await hive.call("memory.write", { project: "web", kind: "gotcha", content: "x" }, agent);
    assert.equal(await key(hive.call("memory.approve", { id: m.id }, admin)), "errors.selfApprove");
    await push(hive, runnerOf(admin));
    assert.equal(await key(hive.call("tasks.update", { id: "web-1", status: "done" }, admin)), "errors.selfApprove");
    assert.equal((await hive.call("tasks.update", { id: "web-1", status: "done" }, rv)).status, "done");
  });

  it("lets the MR watcher move a merged MR's task to done", async () => {
    const hive = await hub();
    await hive.call("policy.set", { selfApproval: "nobody" }, admin);
    const runner = runnerOf(rv);
    await push(hive, runner);
    // The watcher runs on the same machine, on the same person's token (mr.ts mrActor; the hub reads its label).
    const watcher: Actor = { ...runner, name: `${MR_WATCHER}@rv-mbp`, agent: MR_WATCHER, source: { via: "api" } };
    assert.equal(await key(hive.call("tasks.update", { id: "web-1", status: "done" }, { ...runner, agent: "claude-1" })), "errors.selfApprove");
    assert.equal((await hive.call("tasks.update", { id: "web-1", status: "done", note: "MR !7 merged." }, watcher)).status, "done");
    const [row] = await hive.call("admin.audit", { agent: MR_WATCHER }, admin);
    assert.deepEqual([row!.action, row!.onBehalf], ["tasks.update", "rv"], "logged as an agent's write");
  });
});
