import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AGENT_TEMPLATES, HiveError, missingRequired, requiredItemIds, type Actor, type SetupReport } from "../src/index.ts";
import { SqliteHive } from "../src/node.ts";

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
    assert.deepEqual(m!.profiles, [profile]);
    await assert.rejects(hive.call("admin.machines", {}, viewer), code("forbidden"));
    await assert.rejects(hive.call("admin.machines", {}, mbp), code("forbidden"));
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
    assert.deepEqual((await hive.call("admin.audit", { action: "tasks.create" }, admin)).map((e) => e.target), ["T-1"]);
    await assert.rejects(hive.call("admin.audit", {}, viewer), code("forbidden"));
  });
});
