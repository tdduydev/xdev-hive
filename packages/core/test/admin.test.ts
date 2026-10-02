import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AGENT_TEMPLATES, EMPTY_POLICY, HiveError, missingRequired, requiredItemIds, type Actor, type SetupReport } from "#core/index.ts";
import { SqliteHive } from "#core/node.ts";

const admin: Actor = { name: "duy", role: "admin" };
const mbp: Actor = { name: "runner.duy-mbp@duy", role: "agent" };
const imac: Actor = { name: "runner.duy-imac@duy", role: "agent" };
const viewer: Actor = { name: "pm", role: "viewer" };
const code = (code: string) => (e: unknown) => e instanceof HiveError && e.code === code;

function clock(start = "2026-09-27T08:00:00.000Z") {
  let t = new Date(start).getTime();
  return { now: () => new Date(t), advance: (minutes: number) => (t += minutes * 60_000) };
}

const report: SetupReport = {
  machine: [
    { id: "cli:claude", label: "Claude Code", state: "installed", detail: "2.1.283 · /usr/local/bin/claude", action: null },
    { id: "cli:codex", label: "Codex CLI", state: "missing", detail: "Chưa cài", action: "Cài bằng npm" },
    { id: "shim", label: "Lệnh hive-mcp", state: "manual", detail: "không có trong PATH", action: null },
  ],
  projects: [
    {
      project: "app",
      repo: "/Users/duy/app",
      items: [{ id: "app:codegraph-index", label: "Index codegraph", state: "missing", detail: "Chưa tạo", action: "Tạo index" }],
    },
  ],
};

const profile = { id: "claude-1", label: "Claude", kind: "claude", enabled: true, account: "claude-max-duy", installed: true, cooldownUntil: null, runs: 3, rateLimited: 1 };

async function beat(hive: SqliteHive, actor = mbp, extra: Record<string, unknown> = {}) {
  return hive.call("machines.heartbeat", { machine: actor.name.split(".")[1]!.split("@")[0]!, instance: "aaaaaaaa", ...extra } as never, actor);
}

describe("admin portal", () => {
  it("keeps what each machine reported about its setup and profiles, for admins only", async () => {
    const hive = new SqliteHive(":memory:");
    await beat(hive, mbp, { setup: { checkedAt: "2026-09-27T07:59:00.000Z", report }, profiles: [profile] });
    await beat(hive, mbp); // a heartbeat without a report keeps the last one
    const [m] = await hive.call("admin.machines", {}, admin);
    assert.equal(m!.setupAt, "2026-09-27T07:59:00.000Z");
    assert.equal(m!.setup?.machine[1]!.id, "cli:codex");
    assert.deepEqual(
      m!.profiles,
      [{ ...profile, loggedIn: null, sessionPercent: null, weekPercent: null, weekResets: null, overLimit: false }],
      "an older app sends neither sign-in nor plan usage",
    );
    await assert.rejects(hive.call("admin.machines", {}, viewer), code("forbidden"));
    await assert.rejects(hive.call("admin.machines", {}, mbp), code("forbidden"));
  });

  it("shows everyone which machine has a subscription signed out or resting", async () => {
    const hive = new SqliteHive(":memory:");
    const signedOut = { ...profile, id: "claude-2", loggedIn: false };
    await beat(hive, mbp, { profiles: [{ ...profile, loggedIn: true }, signedOut] });
    const [m] = await hive.call("machines.list", {}, viewer);
    assert.deepEqual(
      m!.profiles.map((p) => [p.id, p.loggedIn]),
      [
        ["claude-1", true],
        ["claude-2", false],
      ],
    );
  });

  it("sends an admin's install request to that machine only, and tracks it to the end", async () => {
    const c = clock();
    const hive = new SqliteHive(":memory:", { now: c.now });
    await beat(hive, mbp, { setup: { checkedAt: c.now().toISOString(), report } });
    await beat(hive, imac);

    await assert.rejects(hive.call("admin.commandCreate", { machineId: mbp.name, itemId: "cli:claude" }, admin), /nothing the app can install/);
    await assert.rejects(hive.call("admin.commandCreate", { machineId: mbp.name, itemId: "cli:gemini" }, admin), /has not reported/);
    await assert.rejects(hive.call("admin.commandCreate", { machineId: mbp.name, itemId: "rm -rf /" }, admin), code("bad_request"));

    const cmd = await hive.call("admin.commandCreate", { machineId: mbp.name, itemId: "cli:codex" }, admin);
    assert.equal(cmd.status, "pending");
    assert.equal(cmd.label, "Cài bằng npm: Codex CLI");
    await assert.rejects(hive.call("admin.commandCreate", { machineId: mbp.name, itemId: "cli:codex" }, admin), code("conflict"));

    assert.deepEqual((await beat(hive, imac)).commands, [], "another machine never sees it");
    const reply = await beat(hive, mbp);
    assert.deepEqual(reply.commands.map((x) => x.id), [cmd.id]);

    await assert.rejects(hive.call("machines.commandResult", { id: cmd.id, status: "running" }, imac), code("forbidden"));
    await hive.call("machines.commandResult", { id: cmd.id, status: "running" }, mbp);
    const done = await hive.call("machines.commandResult", { id: cmd.id, status: "done", output: "added 1 package" }, mbp);
    assert.equal(done.output, "added 1 package");
    await assert.rejects(hive.call("machines.commandResult", { id: cmd.id, status: "failed" }, mbp), code("conflict"));
    assert.deepEqual((await beat(hive, mbp)).commands, [], "done commands are not sent again");
    assert.equal((await hive.call("admin.machines", {}, admin)).find((m) => m.id === mbp.name)!.commands[0]!.status, "done");
  });

  it("lets an admin cancel a pending request, and expires one nobody answered in a day", async () => {
    const c = clock();
    const hive = new SqliteHive(":memory:", { now: c.now });
    await beat(hive, mbp, { setup: { checkedAt: c.now().toISOString(), report } });
    const a = await hive.call("admin.commandCreate", { machineId: mbp.name, itemId: "cli:codex" }, admin);
    assert.equal((await hive.call("admin.commandCancel", { id: a.id }, admin)).status, "cancelled");
    const b = await hive.call("admin.commandCreate", { machineId: mbp.name, itemId: "app:codegraph-index" }, admin);
    c.advance(25 * 60);
    assert.deepEqual((await beat(hive, mbp)).commands, []);
    assert.equal((await hive.call("admin.machines", {}, admin))[0]!.commands.find((x) => x.id === b.id)!.status, "expired");
    await assert.rejects(hive.call("machines.commandResult", { id: b.id, status: "running" }, mbp), code("conflict"));
  });

  it("lets an admin ask a machine to install Spec Kit in a repo", async () => {
    const hive = new SqliteHive(":memory:");
    const speckit = { id: "app:speckit", label: "Spec Kit", state: "missing" as const, detail: "Chưa cài", action: "Cài Spec Kit" };
    const withSpeckit: SetupReport = { ...report, projects: [{ ...report.projects[0]!, items: [...report.projects[0]!.items, speckit] }] };
    await beat(hive, mbp, { setup: { checkedAt: "2026-10-02T07:59:00.000Z", report: withSpeckit } });
    const cmd = await hive.call("admin.commandCreate", { machineId: mbp.name, itemId: "app:speckit" }, admin);
    assert.equal(cmd.status, "pending");
  });

  it("stores the team policy, sends it with every heartbeat, and refuses templates with env", async () => {
    const hive = new SqliteHive(":memory:");
    assert.deepEqual((await hive.call("policy.get", {}, viewer)).requiredClis, []);
    const template = { ...AGENT_TEMPLATES.claude, id: "claude-team", account: "claude-team" };
    const policy = await hive.call("policy.set", { requiredClis: ["claude"], requireShim: true, projects: { app: ["agents", "codegraph-index"] }, profileTemplates: [template] }, admin);
    assert.equal(policy.updatedBy, "duy");
    assert.deepEqual((await beat(hive)).policy.projects, { app: ["agents", "codegraph-index"] });
    await assert.rejects(
      hive.call("policy.set", { profileTemplates: [{ ...template, env: { CLAUDE_CONFIG_DIR: "~/.claude-2" } }] }, admin),
      /cannot carry env/,
    );
    await assert.rejects(hive.call("policy.set", {}, mbp), code("forbidden"));

    assert.deepEqual([...requiredItemIds(policy, ["app", "other"])].sort(), ["app:agents", "app:codegraph-index", "cli:claude", "shim"]);
    assert.deepEqual(missingRequired(policy, report).map((i) => i.id), ["shim", "app:codegraph-index"]);

    // Spec Kit is a repo part like the others: the policy can require it.
    const speckit = await hive.call("policy.set", { requiredClis: [], requireShim: false, projects: { app: ["speckit"] } }, admin);
    assert.deepEqual([...requiredItemIds(speckit, ["app"])], ["app:speckit"]);
  });

  it("counts the tools the catalog marks required for a project as required items (roadmap 28b-2)", () => {
    const tool = (id: string, handler: "codegraph" | "superpowers" | "speckit" | null, required: string[]) => ({
      id,
      handler,
      projects: [...required.map((project) => ({ project, required: true })), { project: "web", required: false }],
    });
    const tools = [tool("codegraph", "codegraph", ["app"]), tool("superpowers", "superpowers", ["app"]), tool("speckit", "speckit", ["app"]), tool("rtk", null, ["app"]), tool("lint-mcp", null, ["web-only"])];
    // codegraph stands for its .mcp.json entry: runs build the index in their own worktree.
    assert.deepEqual([...requiredItemIds(EMPTY_POLICY, ["app"], tools)].sort(), ["app:codegraph-mcp", "app:speckit", "app:superpowers", "cli:specify", "tool:rtk"]);
    assert.deepEqual([...requiredItemIds(EMPTY_POLICY, ["web"], tools)], [], "on but not required, or required for a project the machine lacks");
    assert.deepEqual([...requiredItemIds(EMPTY_POLICY, ["app"])], [], "no catalog (an older hub): the policy alone");

    const withTool: SetupReport = {
      machine: [...report.machine, { id: "tool:rtk", label: "RTK", state: "manual", detail: "Chưa được cho phép", action: null }],
      projects: report.projects,
    };
    assert.ok(missingRequired(EMPTY_POLICY, withTool, tools).some((i) => i.id === "tool:rtk"));
    assert.deepEqual(missingRequired(EMPTY_POLICY, withTool), []);
  });

  it("takes an install request for a machine's hub tool, as a tool:<id> item", async () => {
    const hive = new SqliteHive(":memory:");
    const rtk = { id: "tool:rtk", label: "RTK", state: "missing" as const, detail: "Chưa cài", action: "Cài" };
    await beat(hive, mbp, { setup: { checkedAt: "2026-10-02T07:59:00.000Z", report: { ...report, machine: [...report.machine, rtk] } } });
    const cmd = await hive.call("admin.commandCreate", { machineId: mbp.name, itemId: "tool:rtk" }, admin);
    assert.equal(cmd.itemId, "tool:rtk");
    assert.equal(cmd.status, "pending");
    for (const itemId of ["tool:", "tool:Rtk", "tool:../x", `tool:${"a".repeat(41)}`]) {
      await assert.rejects(hive.call("admin.commandCreate", { machineId: mbp.name, itemId }, admin), code("bad_request"), itemId);
    }
  });

  it("logs admin actions with who did them, and never reads", async () => {
    const c = clock();
    const hive = new SqliteHive(":memory:", { now: c.now });
    await hive.call("docs.save", { key: "org/style", content: "Tabs", note: "khởi tạo" }, admin);
    await hive.call("docs.list", {}, admin);
    await hive.call("tasks.create", { id: "T-1", project: "app", title: "Việc A" }, admin);
    await beat(hive, mbp, { setup: { checkedAt: c.now().toISOString(), report } });
    const cmd = await hive.call("admin.commandCreate", { machineId: mbp.name, itemId: "cli:codex" }, admin);
    await hive.call("machines.commandResult", { id: cmd.id, status: "rejected" }, mbp);
    hive.audit(admin, "tokens.create", "ci-runner", "agent");

    const log = await hive.call("admin.audit", {}, admin);
    assert.deepEqual(
      log.map((e) => [e.actor, e.action, e.target]),
      [
        ["duy", "tokens.create", "ci-runner"],
        [mbp.name, "machines.commandResult", mbp.name],
        ["duy", "admin.commandCreate", mbp.name],
        ["duy", "tasks.create", "T-1"],
        ["duy", "docs.save", "org/style"],
      ],
    );
    assert.equal(log.at(-1)!.detail, "v1 · khởi tạo");
    // Details with a message key read in each admin's language; the stored text stays for older clients.
    const request = log.find((e) => e.action === "admin.commandCreate")!;
    assert.equal(request.detailKey, "audit.commandCreate");
    assert.deepEqual(request.detailVars, { label: cmd.label, item: "cli:codex", id: cmd.id });
    assert.equal(log.at(-1)!.detailKey, undefined);
    assert.deepEqual((await hive.call("admin.audit", { action: "tasks.create" }, admin)).map((e) => e.target), ["T-1"]);
    await assert.rejects(hive.call("admin.audit", {}, viewer), code("forbidden"));
  });

  it("tells a project's readers what its machines still lack, without the install actions or local paths", async () => {
    const hive = new SqliteHive(":memory:");
    const withPath: SetupReport = {
      ...report,
      machine: report.machine.map((i) => (i.id === "shim" ? { ...i, detail: "không có trong /Users/duy/.local/bin" } : i)),
      projects: [...report.projects, { project: "site", repo: "/Users/duy/site", items: [{ id: "site:agents", label: "AGENTS.md", state: "missing", detail: "Chưa có", action: "Tạo" }] }],
    };
    await beat(hive, mbp, { projects: ["app", "site"], setup: { checkedAt: "2026-09-27T07:59:00.000Z", report: withPath } });
    const allInstalled: SetupReport = { machine: [report.machine[0]!], projects: [] };
    await beat(hive, imac, { projects: ["app"], setup: { checkedAt: "2026-09-27T07:59:00.000Z", report: allInstalled } });
    await hive.call("machines.heartbeat", { machine: "lan-pc", instance: "bbbbbbbb", projects: ["app"] }, { name: "runner.lan-pc@lan", role: "agent" });
    await beat(hive, { name: "runner.hoa-mbp@hoa", role: "agent" }, { projects: ["site"], setup: { checkedAt: "2026-09-27T07:59:00.000Z", report } });

    const missing = await hive.call("machines.setupMissing", { project: "app" }, viewer);
    assert.deepEqual(
      missing.map((m) => [m.machineId, m.machine, m.items.map((i) => [i.id, i.state])]),
      [[mbp.name, "duy-mbp", [["cli:codex", "missing"], ["shim", "manual"], ["app:codegraph-index", "missing"]]]],
      "only machines with the project and something left; the other project's items stay out",
    );
    for (const item of missing[0]!.items) assert.equal("action" in item, false);
    assert.equal(missing[0]!.items.find((i) => i.id === "shim")!.detail, "không có trong …/bin");
    assert.equal(JSON.stringify(missing).includes("/Users/duy"), false, "no repo or home path");

    const siteOnly: Actor = { name: "lan", role: "member", access: { projects: { site: "view" } } };
    assert.deepEqual((await hive.call("machines.setupMissing", { project: "site" }, siteOnly)).map((m) => m.machine).sort(), ["duy-mbp", "hoa-mbp"]);
    await assert.rejects(hive.call("machines.setupMissing", { project: "app" }, siteOnly), code("not_found"));
  });
});
