import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { grantPermissions, grantRole, HiveError, intersectAccess, isContextDoc, may, permissionsOn, readGrant, ROLE_PERMISSIONS, type Actor } from "#core/index.ts";
import { SqliteHive } from "#core/node.ts";

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

const list = (actor: Actor, owner: string | null) => [...(permissionsOn(actor, owner) ?? [])].sort();

describe("permissions per project (roadmap 25)", () => {
  it("creates the initial brief with taskManage alone and validates it atomically", async () => {
    const hive = await hub();
    const manager: Actor = { name: "po", role: "member", access: { projects: { web: { permissions: ["view", "taskManage"] } } } };
    const task = await hive.call("tasks.create", { id: "brief-1", project: "web", title: "Fix label", note: "Update label.\n\nXong khi\nBoth languages match." }, manager);
    assert.equal(task.note, "Update label.\n\nXong khi\nBoth languages match.");
    assert.equal(task.status, "todo");
    await assert.rejects(hive.call("tasks.create", { id: "brief-2", project: "web", title: "Invalid", note: "hidden\u200btext" }, manager));
    assert.ok(!(await hive.call("tasks.list", { project: "web" }, manager)).some((t) => t.id === "brief-2"));
    hive.close();
  });

  it("read old levels as roles, so grants saved before keep what they allowed", () => {
    assert.equal(readGrant("view"), "viewer");
    assert.equal(readGrant("contribute"), "member");
    assert.equal(readGrant("manage"), "lead");
    assert.equal(readGrant("owner"), null);
    assert.deepEqual(readGrant({ permissions: ["docApprove"] }), { permissions: ["view", "docApprove"] }, "seeing the project comes with any permission");
    assert.equal(readGrant({ permissions: ["docApprove", "fly"] }), null);
    assert.equal(grantRole({ permissions: [...ROLE_PERMISSIONS.reviewer] }), "reviewer");
    assert.equal(grantRole({ permissions: [...ROLE_PERMISSIONS.qa] }), "qa");
    assert.deepEqual([...ROLE_PERMISSIONS.qa].sort(), ["codeReview", "qaVerify", "view"]);
    assert.equal(grantRole({ permissions: ["view", "docApprove"] }), "custom");
  });

  it("combine grants with the role cap, and give shared data to everyone", () => {
    assert.deepEqual(list(lan, "web"), [...ROLE_PERMISSIONS.lead].sort());
    assert.deepEqual(list(lanAgent, "web"), ["docPropose", "memoryWrite", "taskWork", "view"], "agent tokens never approve or manage");
    assert.equal(permissionsOn(lan, "billing"), null);
    assert.deepEqual(list(lan, null), ["docPropose", "memoryWrite", "view"], "works somewhere → may propose to the shared data");
    assert.deepEqual(list({ name: "x", role: "member", access: { projects: { app: "view" } } }, null), ["view"]);
    assert.equal(may(admin, "billing", "membersManage"), true);
    assert.deepEqual(list({ name: "old", role: "agent" }, "billing"), ["codeReview", "docPropose", "memoryWrite", "taskWork", "view"], "tokens of no account keep the old rules");
  });

  it("give the shared data a grant of its own when the account has one", () => {
    const keeper: Actor = { name: "hoa", role: "member", access: { projects: { app: "member" }, shared: "reviewer" } };
    assert.equal(may(keeper, null, "docApprove"), true);
    assert.equal(may(keeper, null, "contextEdit"), false);
    const reader: Actor = { name: "an", role: "member", access: { projects: { app: "lead" }, shared: "viewer" } };
    assert.equal(may(reader, null, "docPropose"), false, "an explicit grant is the whole of it");
  });

  it("let the chat leader do only what both its sender and its machine may", () => {
    const both = intersectAccess({ projects: { app: "reviewer", web: "lead" } }, { projects: { app: "lead", billing: "lead" } })!;
    assert.deepEqual(Object.keys(both.projects), ["app"]);
    assert.deepEqual([...grantPermissions(both.projects.app)].sort(), [...ROLE_PERMISSIONS.reviewer].sort());
    assert.deepEqual([...grantPermissions(both.shared)].sort(), ["docPropose", "memoryWrite", "view"]);
  });

  it("know which docs agents read", () => {
    assert.equal(isContextDoc("project/app/agents"), true);
    assert.equal(isContextDoc("project/app/decisions"), true);
    assert.equal(isContextDoc("project/app/skills/deploy"), true);
    assert.equal(isContextDoc("org/style", { includeInAgents: true }), true);
    assert.equal(isContextDoc("project/app/api", { paths: ["apps/api/**"] }), true);
    assert.equal(isContextDoc("project/app/huong-dan", { paths: [] }), false);
  });
});

describe("roles in the hub (roadmap 25)", () => {
  const as = (name: string, grant: unknown, role: Actor["role"] = "member"): Actor => ({ name, role, access: { projects: { web: grant as never } } });
  const reviewer = as("rv", "reviewer");
  const member = as("mb", "member");

  it("let a reviewer approve docs, memory and leader actions, and move reviewed work to done, but not run or edit what agents read", async () => {
    const hive = await hub();
    await hive.call("docs.save", { key: "project/web/huong-dan", content: "v1", title: "Hướng dẫn" }, admin);
    const p = await hive.call("proposals.create", { docKey: "project/web/huong-dan", baseVersion: 1, content: "v2", reason: "sửa" }, member);
    assert.equal((await hive.call("proposals.approve", { id: p.id }, reviewer)).status, "approved");
    const ctx = await hive.call("proposals.create", { docKey: "project/web/agents", baseVersion: 1, content: "rules v2", reason: "sửa" }, member);
    await assert.rejects(hive.call("proposals.approve", { id: ctx.id }, reviewer), (e: unknown) => (e as HiveError).key === "errors.need.contextEdit");
    assert.equal((await hive.call("proposals.approve", { id: ctx.id }, lan)).status, "approved", "a lead edits the context");
    await assert.rejects(hive.call("docs.save", { key: "project/web/huong-dan", content: "v3", baseVersion: 2 }, reviewer), (e: unknown) => (e as HiveError).key === "errors.need.docEdit");
    await assert.rejects(hive.call("runs.dispatch", { machineId: "runner.duy-mbp@duy-mbp", project: "web", taskId: "web-1" } as never, reviewer), (e: unknown) => (e as HiveError).key === "errors.need.runDispatch");
    await hive.call("tasks.update", { id: "web-1", status: "review" }, member);
    await assert.rejects(hive.call("tasks.update", { id: "web-1", status: "done" }, member), (e: unknown) => (e as HiveError).key === "errors.need.codeReview");
    assert.equal((await hive.call("tasks.update", { id: "web-1", status: "done" }, reviewer)).status, "done");
  });

  it("make a doc for some paths, or one put in AGENTS.md, the context's to change", async () => {
    const hive = await hub();
    const editor = as("ed", { permissions: ["docEdit"] });
    await hive.call("docs.save", { key: "project/web/api", content: "API", title: "API" }, editor);
    await assert.rejects(hive.call("docs.save", { key: "project/web/api", content: "API", baseVersion: 1, paths: ["apps/api/**"] }, editor), code("forbidden"));
    await hive.call("docs.save", { key: "project/web/api", content: "API", baseVersion: 1, paths: ["apps/api/**"] }, as("ctx", { permissions: ["docEdit", "contextEdit"] }));
    await assert.rejects(hive.call("docs.save", { key: "project/web/api", content: "API v3", baseVersion: 2 }, editor), (e: unknown) => (e as HiveError).key === "errors.need.contextEdit");
  });

  it("approve memory written by someone who may approve it, and keep the rest waiting", async () => {
    const hive = new SqliteHive(":memory:", { memoryRequiresApproval: true });
    hive.seed("hub");
    assert.equal((await hive.call("memory.write", { project: "web", kind: "gotcha", content: "a" }, reviewer)).status, "approved");
    assert.equal((await hive.call("memory.write", { project: "web", kind: "gotcha", content: "b" }, member)).status, "pending");
  });
});

describe("per-project access in the hub", () => {
  it("scopes vector-index counts to the reader's project and shared grants", async () => {
    const hive = new SqliteHive(":memory:", { embedder: { model: "audit-fake", embed: async (texts) => texts.map(() => Float32Array.of(1)) } });
    try {
      for (const project of ["app", "hidden"]) await hive.call("memory.write", { project, kind: "context", content: "index sentinel" }, admin);
      await hive.call("memory.write", { shared: true, kind: "context", content: "shared index sentinel" }, admin);
      assert.equal(await hive.indexMemory(), 3);
      const reader: Actor = { name: "reader", role: "viewer", access: { projects: { app: "viewer" }, shared: { permissions: [] } } };
      const visible = await hive.call("memory.searchInfo", {}, reader);
      assert.deepEqual([visible.total, visible.indexed], [1, 1]);
      const withShared = await hive.call("memory.searchInfo", {}, { ...reader, access: { projects: { app: "viewer" } } });
      assert.deepEqual([withShared.total, withShared.indexed], [2, 2]);
    } finally { hive.close(); }
  });
  it("keeps denied shared context and memory counts out of project context and search info", async () => {
    const hive = await hub();
    try {
      const restricted: Actor = { name: "reader", role: "member", access: { projects: { app: "viewer" }, shared: { permissions: [] } } };
      await hive.call("docs.save", { key: "org/denied-context", content: "shared context sentinel", includeInAgents: true }, admin);
      const context = await hive.call("docs.context", { project: "app" }, restricted);
      assert.ok(!JSON.stringify(context).includes("shared context sentinel"));
      assert.equal(context.memory.shared, 0);
      assert.equal((await hive.call("memory.searchInfo", {}, restricted)).total, 1);
      const all = await hive.call("memory.searchInfo", {}, admin);
      assert.equal(all.total, 4, "unrestricted readers retain the global count");
    } finally { hive.close(); }
  });
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
    // The interface shows these in the person's language: the key and its placeholders travel with the error.
    await assert.rejects(hive.call("docs.save", { key: "project/app/agents", content: "x" }, lan), (e: unknown) => {
      const err = e as HiveError;
      return err.key === "errors.need.contextEdit" && err.vars?.project === "app";
    });
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
