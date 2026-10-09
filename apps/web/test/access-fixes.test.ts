import assert from "node:assert/strict";
import { it } from "node:test";
import type { Request, RequestHandler, Response } from "express";
import { toolHash, worktreeCleanupSchema, type Actor } from "@xdev-hive/core";
import { SqliteHive } from "@xdev-hive/core/node";
import { createHubApp } from "#web/app.ts";
import type { ChatGrants } from "#web/grants.ts";
import { TokenStore } from "#web/tokens.ts";
import { UserStore } from "#web/users.ts";

// Runs the real Bearer auth and RPC handlers in-process (no socket), as token-security.test.ts does.
function harness(opts: { chatGrant?: { role: Actor["role"]; replyId: number } } = {}) {
  const hive = new SqliteHive(":memory:");
  const tokens = new TokenStore(hive.db);
  const users = new UserStore(hive.db);
  const chatGrants = { verify: (t: string) => (t === "hivechat_test" && opts.chatGrant ? { name: "chat-duy", ...opts.chatGrant } : null) } as unknown as ChatGrants;
  const app = createHubApp({ hive, tokens, users, chatGrants });
  const router = (app as unknown as { router: { stack: Array<{ route?: { path: string; stack: Array<{ handle: RequestHandler }> } }> } }).router;
  const route = router.stack.find((layer) => layer.route?.path === "/api/rpc")!.route!;
  const rpc = async (credential: string, method: string, input: unknown = {}, headers: Record<string, string> = {}) => {
    const req = { method: "POST", path: "/api/rpc", body: { method, input }, get: (key: string) => (key === "authorization" ? `Bearer ${credential}` : headers[key]) };
    let status = 200, body: any, authenticated = false;
    const res = { locals: {}, status: (n: number) => { status = n; return res; }, json: (v: unknown) => { body = v; return res; } };
    route.stack[0]!.handle(req as unknown as Request, res as unknown as Response, () => { authenticated = true; });
    if (!authenticated) return { status, body };
    await route.stack.at(-1)!.handle(req as unknown as Request, res as unknown as Response, () => {});
    return { status, body };
  };
  const auditOf = (action: string) => (hive.db.prepare("SELECT * FROM audit WHERE action = ?").all(action) as unknown[]).length;
  return { hive, tokens, users, rpc, auditOf };
}

it("P0-1: a chat reply's token cannot call the web-only RPCs or mint an ownerless token", async () => {
  const { hive, tokens, rpc } = harness({ chatGrant: { role: "admin", replyId: 1 } });
  try {
    const before = tokens.count();
    assert.equal((await rpc("hivechat_test", "tokens.create", { name: "evil", role: "admin" })).status, 403);
    assert.equal(tokens.count(), before);
    for (const method of ["tokens.list", "hub.info", "users.list", "releases.list", "webhooks.list", "budgets.set", "tasks.create", "agents.stop", "projects.retire", "machines.worktrees", "machines.tools", "chat.progress", "chat.finish", "chat.decide"]) {
      assert.equal((await rpc("hivechat_test", method)).status, 403, method);
    }
  } finally { hive.close(); }
});

it("P0-2: a viewer credential of a machine's owner cannot approve tools or manage worktrees", async () => {
  const { hive, tokens, users, rpc } = harness();
  try {
    const owner = users.create({ username: "hoa" }).user;
    users.setGrants(owner.id, { app: "lead" });
    const viewer = tokens.create("hoa-view", "viewer", owner.id).token;
    const member = tokens.create("hoa-mbp", "member", owner.id).token;
    hive.db.prepare("INSERT INTO machines(id, machine, instance, owner, last_seen) VALUES ('m1', 'mbp', 'i1', 'hoa', ?)").run(new Date().toISOString());
    const tools = (c: string, h: Record<string, string> = {}) => rpc(c, "machines.tools", { machineId: "m1" }, h);
    assert.equal((await tools(member)).body.result.canApprove, true);
    assert.equal((await tools(viewer)).body.result.canApprove, false);
    assert.equal((await tools(member, { "x-hive-agent": "runner", "x-hive-source": JSON.stringify({ via: "desktop" }) })).body.result.canApprove, false, "client headers cannot turn an agent into a person");
    assert.equal((await rpc(viewer, "machines.worktrees", { machineId: "m1" })).status, 403);
  } finally { hive.close(); }
});

it("P0-2: only the paired owner's machine token may use the desktop source for human decisions", async () => {
  const { hive, tokens, users, rpc } = harness();
  try {
    const owner = users.create({ username: "hoa" }).user;
    const stranger = users.create({ username: "lan" }).user;
    users.setGrants(owner.id, { app: "lead" });
    users.setGrants(stranger.id, { app: "lead" });
    const paired = tokens.create("hoa-mbp", "member", owner.id);
    const unpaired = tokens.create("hoa-other", "member", owner.id).token;
    const foreign = tokens.create("lan-mbp", "member", stranger.id).token;
    const machineId = "runner.mbp@hoa-mbp";
    const profile = { id: "claude-1", label: "Claude", kind: "claude", enabled: true, installed: true, account: null, cooldownUntil: null, runs: 0, rateLimited: 0, priority: 10 };
    const tool = (await hive.call("tools.list", {}, { name: "root", role: "admin" })).find((entry) => entry.id === "rtk")!;
    const hash = toolHash(tool);
    const cleanup = worktreeCleanupSchema.parse({});
    const worktrees = { measuredAt: new Date().toISOString(), totalBytes: 0, freeBytes: 1024 ** 3, cleanup, logs: [], errors: [], entries: [] };
    hive.db.prepare(`INSERT INTO machines(id, machine, instance, owner, token_id, last_seen, profiles, runner_settings, tool_states, worktrees)
      VALUES (?, 'mbp', 'i1', 'hoa', ?, ?, ?, ?, ?, ?)`).run(machineId, paired.info.id, new Date().toISOString(), JSON.stringify([profile]), JSON.stringify({ maxParallel: 2, mrEnabled: false, mrWhen: "after_review" }), JSON.stringify([{ id: tool.id, hash, trust: "new" }]), JSON.stringify(worktrees));
    const desktop = { "x-hive-agent": "desktop", "x-hive-source": JSON.stringify({ via: "desktop" }) };
    const call = (credential: string, method: string, input: unknown = {}) => rpc(credential, method, input, desktop);

    assert.equal((await call(paired.token, "machines.tools", { machineId })).body.result.canApprove, true);
    assert.equal((await call(paired.token, "machines.worktrees", { machineId })).status, 200);
    assert.equal((await call(paired.token, "machines.setProfile", { machineId, profileId: "claude-1", enabled: false })).status, 200);
    assert.equal((await call(paired.token, "machines.setRunner", { machineId, settings: { maxParallel: 3 } })).status, 200);
    for (const credential of [unpaired, foreign]) {
      assert.equal((await call(credential, "machines.tools", { machineId })).body.result.canApprove, false);
      assert.equal((await call(credential, "machines.worktrees", { machineId })).status, 403);
      assert.equal((await call(credential, "machines.approveTool", { machineId, toolId: tool.id, hash })).status, 403);
      assert.equal((await call(credential, "machines.manageWorktrees", { machineId, cleanup })).status, 403);
      assert.equal((await call(credential, "machines.setProfile", { machineId, profileId: "claude-1", enabled: false })).status, 403);
      assert.equal((await call(credential, "machines.setRunner", { machineId, settings: { maxParallel: 3 } })).status, 403);
    }
    assert.equal((await call(paired.token, "machines.approveTool", { machineId, toolId: tool.id, hash })).status, 200);
    assert.equal((await call(paired.token, "machines.manageWorktrees", { machineId, cleanup })).status, 200);
  } finally { hive.close(); }
});

it("P0-3: a member or agent token of an admin account is cut to its role, not unrestricted", async () => {
  const { hive, tokens, users, rpc } = harness();
  try {
    const admin = users.create({ username: "duy", admin: true }).user;
    const other = users.create({ username: "another-person" }).user;
    await hive.call("tasks.create", { id: "app-1", project: "app", title: "t" }, { name: "duy", role: "admin" });
    await hive.call("tasks.create", { id: "zzz-1", project: "zzz", title: "unrelated" }, { name: other.username, account: other.username, role: "admin" });
    const now = new Date().toISOString();
    hive.db.prepare(`INSERT INTO run_records(machine_id, run_id, machine, project, task_id, task_title, role, status, created_at, updated_at)
      VALUES ('runner.mbp@duy', 'R-test', 'mbp', 'app', 'app-1', 't', 'implement', 'succeeded', ?, ?)`).run(now, now);
    const gateId = Number(hive.db.prepare(`INSERT INTO sdlc_gates(project, task_id, gate, mode, status, created_at)
      VALUES ('app', 'app-1', 'review', 'human', 'waiting', ?)`).run(now).lastInsertRowid);
    const viewer = tokens.create("duy-view", "viewer", admin.id).token;
    const agent = tokens.create("duy-agent", "agent", admin.id).token;
    // Hub-wide settings stay with a hub admin: a token of one, whatever its role, is not that.
    for (const [name, credential] of [["viewer", viewer], ["agent", agent], ["member", tokens.create("duy-member", "member", admin.id).token]] as const) {
      assert.equal((await rpc(credential, "budgets.set", { budgets: [] })).status, 403, `${name} token of an admin sets spending caps`);
      assert.equal((await rpc(credential, "members.list", { project: "app" })).status, 403, `${name} token of an admin manages members`);
      assert.equal((await rpc(credential, "hub.info")).status, 403, name);
    }
    for (const id of ["app-1", "zzz-1"]) assert.equal((await rpc(agent, "tasks.update", { id, status: "done" })).status, 403, id);
    assert.equal((await rpc(agent, "runs.merge", { machineId: "runner.mbp@duy", runId: "R-test" })).status, 403);
    assert.equal((await rpc(agent, "sdlc.decide", { gateId, decision: "pass" })).status, 403);
    assert.equal((await rpc(agent, "tokens.create", { name: "child", role: "agent" })).status, 403);
    // Still works inside its role: an agent token still reads projects.
    assert.equal((await rpc(agent, "projects.list", {})).status, 200);
  } finally { hive.close(); }
});

it("P0-4: web-only RPCs are default-deny, hub-admin gated, and changes are audited", async () => {
  const { hive, tokens, users, rpc, auditOf } = harness();
  try {
    const person = users.create({ username: "lan" }).user;
    users.setGrants(person.id, { app: "lead" });
    const member = tokens.create("lan-dev", "member", person.id).token;
    assert.equal((await rpc(member, "nope.unknown")).status, 400, "an unlisted web method is refused");
    for (const method of ["releases.notes", "alerts.ack", "webhooks.test", "automation.save", "users.create", "hub.cleanup"]) {
      assert.equal((await rpc(member, method, {})).status, 403, method);
    }
    const root = tokens.create("root", "admin", null).token;
    assert.equal((await rpc(root, "users.create", { username: "kim" })).status, 200);
    assert.equal(auditOf("users.create"), 1);
    assert.equal((await rpc(root, "tokens.create", { name: "ci", role: "agent" })).status, 200);
    assert.equal(auditOf("tokens.create"), 1);
    assert.equal((await rpc(root, "alerts.ack", { id: -1 })).status, 400);
    assert.equal(auditOf("alerts.ack"), 0);
    assert.equal((await rpc(root, "releases.notes", {})).status, 400);
    assert.equal(auditOf("releases.notes"), 0);
  } finally { hive.close(); }
});
