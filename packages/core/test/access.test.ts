import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { can, HiveError, levelOn, type Actor } from "../src/index.ts";
import { SqliteHive } from "../src/node.ts";

const admin: Actor = { name: "duy", role: "admin" };
/** A person with view on app, manage on web, nothing on billing. */
const lan: Actor = { name: "lan", role: "member", access: { projects: { app: "view", web: "manage" } } };
/** Lan's agent token: capped at contribute whatever her grants. */
const lanAgent: Actor = { name: "claude.lan-mbp@lan-mbp", role: "agent", access: lan.access };
const code = (c: string) => (e: unknown) => e instanceof HiveError && e.code === c;

async function hub() {
  const hive = new SqliteHive(":memory:");
  hive.seed("hub");
  for (const p of ["app", "web", "billing"]) {
    await hive.call("docs.save", { key: `project/${p}/agents`, content: `${p} rules` }, admin);
    await hive.call("memory.write", { project: p, kind: "gotcha", content: `${p} gotcha` }, admin);
    await hive.call("tasks.create", { id: `${p}-1`, project: p, title: `${p} task` }, admin);
  }
  await hive.call("memory.write", { shared: true, kind: "convention", content: "shared convention" }, admin);
  return hive;
}

describe("access levels", () => {
  it("combine grants with the role cap, and give shared data to everyone", () => {
    assert.equal(levelOn(lan, "web"), "manage");
    assert.equal(levelOn(lanAgent, "web"), "contribute", "agent tokens never manage");
    assert.equal(levelOn(lan, "billing"), null);
    assert.equal(levelOn(lan, null), "contribute", "contributes somewhere → may contribute to shared");
    assert.equal(levelOn({ name: "x", role: "member", access: { projects: { app: "view" } } }, null), "view");
    assert.equal(levelOn(admin, "billing"), "manage");
    assert.equal(levelOn({ name: "old", role: "agent" }, "billing"), "contribute", "tokens of no account keep the old rules");
    assert.equal(can({ name: "old", role: "agent" }, "billing", "manage"), false);
  });
});

describe("per-project access in the hub", () => {
  it("hides projects that were not granted from every list", async () => {
    const hive = await hub();
    const docs = (await hive.call("docs.list", {}, lan)).map((d) => d.key);
    assert.ok(docs.includes("org/agent-protocol"), "shared docs are visible");
    assert.ok(docs.includes("project/app/agents") && docs.includes("project/web/agents"));
    assert.ok(!docs.includes("project/billing/agents"));
    assert.deepEqual((await hive.call("tasks.list", {}, lan)).map((t) => t.id).sort(), ["app-1", "web-1"]);
    assert.deepEqual((await hive.call("memory.list", {}, lan)).map((m) => m.project ?? "chung").sort(), ["app", "chung", "web"]);
    assert.deepEqual((await hive.call("memory.search", { anyProject: true }, lan)).map((m) => m.project ?? "chung").sort(), ["app", "chung", "web"]);
    assert.deepEqual(await hive.call("tasks.list", { project: "billing" }, lan), []);
  });

  it("answers not_found for anything in a hidden project, forbidden when the level is too low", async () => {
    const hive = await hub();
    await assert.rejects(hive.call("docs.get", { key: "project/billing/agents" }, lan), code("not_found"));
    await assert.rejects(hive.call("memory.search", { project: "billing" }, lan), code("not_found"));
    await assert.rejects(hive.call("tasks.claim", { id: "billing-1" }, lanAgent), code("not_found"));
    await assert.rejects(hive.call("tasks.update", { id: "app-1", status: "doing" }, lan), code("forbidden"), "view only on app");
    await assert.rejects(hive.call("docs.save", { key: "project/app/agents", content: "x" }, lan), code("forbidden"));
    await assert.rejects(hive.call("docs.save", { key: "org/style", content: "x" }, lan), code("forbidden"), "shared docs: hub admins only");
    await assert.rejects(hive.call("tasks.create", { id: "web-2", project: "web", title: "x" }, lanAgent), code("forbidden"), "agent tokens cannot create tasks");
  });

  it("lets a manager run their project, and an agent token contribute to it", async () => {
    const hive = await hub();
    const doc = await hive.call("docs.get", { key: "project/web/agents" }, lan);
    await hive.call("docs.save", { key: "project/web/agents", content: "web rules v2", baseVersion: doc!.version }, lan);
    await hive.call("tasks.create", { id: "web-2", project: "web", title: "Trang mới" }, lan);
    assert.equal((await hive.call("tasks.claim", { id: "web-2" }, lanAgent)).claimed, true);
    const p = await hive.call("proposals.create", { docKey: "project/web/agents", baseVersion: doc!.version + 1, content: "web rules v3", reason: "thêm" }, lanAgent);
    await assert.rejects(hive.call("proposals.approve", { id: p.id }, lanAgent), code("forbidden"));
    assert.equal((await hive.call("proposals.approve", { id: p.id }, lan)).status, "approved");
    const shared = await hive.call("memory.write", { shared: true, kind: "gotcha", content: "VPN cho GitLab" }, lanAgent);
    assert.equal(shared.project, null, "contributors may add shared memory");
    await assert.rejects(hive.call("memory.remove", { id: shared.id }, lan), code("forbidden"), "shared memory is managed by hub admins");
  });

  it("keeps policy entries of hidden projects out of sight", async () => {
    const hive = await hub();
    await hive.call("policy.set", { projects: { app: ["agents"], billing: ["agents", "superpowers"] } }, admin);
    assert.deepEqual(Object.keys((await hive.call("policy.get", {}, lan)).projects), ["app"]);
  });

  it("shows every machine but only the runs of visible projects", async () => {
    const hive = await hub();
    const runner: Actor = { name: "runner.duy-mbp@duy-mbp", role: "agent" };
    const run = (project: string) => ({ runId: `r-${project}`, project, taskId: `${project}-1`, taskTitle: "t", role: "implement", status: "running", profileId: null, since: "2026-09-27T00:00:00Z" });
    await hive.call("machines.heartbeat", { machine: "duy-mbp", instance: "aaaaaaaa", runs: [run("web"), run("billing")] } as never, runner);
    const [m] = await hive.call("machines.list", {}, lan);
    assert.deepEqual(m!.runs.map((r) => r.project), ["web"]);
    assert.equal((await hive.call("machines.list", {}, admin))[0]!.runs.length, 2);
  });

  it("needs no second approval for memory from someone who manages the project", async () => {
    const hive = new SqliteHive(":memory:", { memoryRequiresApproval: true });
    hive.seed("hub");
    assert.equal((await hive.call("memory.write", { project: "web", kind: "gotcha", content: "cache" }, lan)).status, "approved");
    assert.equal((await hive.call("memory.write", { project: "web", kind: "gotcha", content: "cache" }, lanAgent)).status, "pending");
    assert.equal((await hive.call("memory.write", { shared: true, kind: "gotcha", content: "shared" }, lan)).status, "pending");
  });
});
