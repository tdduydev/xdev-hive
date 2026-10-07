import assert from "node:assert/strict";
import { it } from "node:test";
import { isMethod } from "@xdev-hive/core";
import type { Request, RequestHandler, Response } from "express";
import { SqliteHive, migrationIndex } from "@xdev-hive/core/node";
import { createHubApp } from "#web/app.ts";
import { TokenStore } from "#web/tokens.ts";
import { UserStore } from "#web/users.ts";

it("binds run credentials to one task and rejects every human decision even with desktop headers", async () => {
  const hive = new SqliteHive(":memory:");
  const tokens = new TokenStore(hive.db);
  const users = new UserStore(hive.db);
  const owner = users.create({ username: "run-owner" }).user;
  users.setGrants(owner.id, { app: "lead", hidden: "lead" });
  const machineToken = tokens.create("machine", "member", owner.id);
  const now = new Date().toISOString();
  hive.db.prepare("INSERT INTO machines(id, machine, instance, last_seen, owner) VALUES (?, ?, ?, ?, ?)")
    .run("runner.test@machine", "test", "instance", now, owner.username);
  hive.db.prepare("INSERT INTO tasks(id, project, title, updated_at) VALUES (?, ?, ?, ?)").run("SEC-1", "app", "Security task", now);
  hive.db.prepare("INSERT INTO tasks(id, project, title, updated_at) VALUES (?, ?, ?, ?)").run("SEC-2", "hidden", "Hidden task", now);
  const app = createHubApp({ hive, tokens, users });
  const routes = (app as unknown as { router: { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: RequestHandler }> } }> } }).router.stack;
  const invoke = async (path: string, verb: string, credential: string, body: unknown, source: string | null = "desktop") => {
    const route = routes.find((layer) => layer.route?.path === path && layer.route.methods[verb])!.route!;
    const req = {
      method: verb.toUpperCase(), path, body,
      get: (key: string) => key === "authorization" ? `Bearer ${credential}` :
        key === "x-hive-agent" ? "runner.test" : key === "x-hive-source" && source ? JSON.stringify({ via: source, run: "forged" }) :
          key === "x-hive-run" ? "forged" : undefined,
    };
    let status = 200;
    let answer: any;
    const res = { locals: {}, status: (code: number) => { status = code; return res; }, json: (value: unknown) => { answer = value; return res; } };
    let authenticated = false;
    route.stack[0]!.handle(req as Request, res as unknown as Response, () => { authenticated = true; });
    if (authenticated) await route.stack.at(-1)!.handle(req as Request, res as unknown as Response, () => {});
    return { status, answer };
  };
  try {
    assert.equal((await invoke("/api/rpc", "post", machineToken.token, {
      method: "docs.save", input: { key: "project/app/agents", content: "Human context", baseVersion: 0 },
    })).status, 200, "the owner's human credential still edits context");
    assert.equal((await invoke("/api/rpc", "post", machineToken.token, {
      method: "machines.heartbeat", input: { machine: "test", instance: "aaaaaaaa", projects: ["app"] },
    })).status, 200);
    const issued = await invoke("/api/run-credentials", "post", machineToken.token,
      { machine: "test", project: "app", task: "SEC-1", run: "R-test", minutes: 30, readOnly: false });
    assert.equal(issued.status, 200);
    let runToken = issued.answer.result.token as string;
    assert.equal(tokens.verify(runToken)?.run?.project, "app");
    const claim = await invoke("/api/rpc", "post", runToken, { method: "tasks.claim", input: { id: "SEC-1" } });
    assert.equal(claim.status, 200);
    assert.equal(claim.answer.result.claimed, true);
    assert.equal((await invoke("/api/rpc", "post", runToken, { method: "tasks.update", input: { id: "SEC-1", status: "review", note: "ready" } })).status, 200);
    assert.equal((await invoke("/api/rpc", "post", runToken, { method: "tasks.list", input: { project: "app" } })).status, 200);
    assert.deepEqual((await invoke("/api/rpc", "post", runToken, { method: "tasks.list", input: { project: "hidden" } })).answer.result, []);
    assert.equal((await invoke("/api/rpc", "post", runToken, { method: "memory.write", input: { project: "app", kind: "context", content: "sample" } })).status, 200);
    const written = hive.db.prepare("SELECT source FROM memory WHERE content = 'sample'").get() as { source: string };
    assert.deepEqual(JSON.parse(written.source), { via: "mcp", machine: "test", run: "R-test", task: "SEC-1" });
    assert.equal((await invoke("/api/rpc", "post", runToken, { method: "tasks.update", input: { id: "SEC-2", status: "review" } })).status, 403);
    const decisions: Array<[string, unknown]> = [
      ["machines.approveTool", { machineId: "runner.test@machine", toolId: "tool", hash: "hash" }],
      ["machines.repair", { machineId: "runner.test@machine", tokenId: machineToken.info.id }],
      ["docs.save", { key: "project/app/agents", content: "changed", baseVersion: 0 }],
      ["docs.move", { key: "project/app/agents", to: "project/app/other" }],
      ["docs.remove", { key: "project/app/agents" }],
      ["docs.restore", { key: "project/app/agents" }],
      ["docs.syncRequest", { project: "app" }],
      ["docs.assetPut", { key: "project/app/agents", name: "file.txt", data: "eA==" }],
      ["docs.assetRemove", { key: "project/app/agents", name: "file.txt" }],
      ["docs.assistFinish", { id: 1, status: "done", markdown: "changed" }],
      ["proposals.approve", { id: 1 }],
      ["proposals.reject", { id: 1 }],
      ["chat.decide", { actionId: 1, accept: true }],
      ["chat.decideAll", { replyId: 1, accept: true }],
      ["runs.decidePlan", { id: 1, revision: 1, decision: "approve" }],
      ["runs.merge", { machineId: "runner.test@machine", runId: "R-test" }],
      ["sdlc.decide", { gateId: 1, decision: "pass" }],
      ["memory.approve", { id: 1 }],
      ["memory.resolve", { id: 1 }],
      ["memory.keep", { id: 1 }],
      ["memory.remove", { id: 1 }],
      ["memory.decideCleanup", { id: 1, accept: true }],
      ["tokens.create", { name: "child", role: "agent" }],
      ["tokens.revoke", { id: machineToken.info.id }],
      ["tasks.update", { id: "SEC-1", status: "done" }],
      ["machines.heartbeat", { machine: "test", instance: "forged", projects: ["app"] }],
      ["hub.backup", {}],
      ["hub.cleanup", {}],
    ];
    for (const [method] of decisions) assert.ok(isMethod(method) || ["tokens.create", "tokens.revoke", "hub.backup", "hub.cleanup"].includes(method), `Known sensitive method: ${method}`);
    const exchanged = await invoke("/api/mcp-credentials", "post", machineToken.token, { project: "app", readOnly: false });
    assert.equal(exchanged.status, 200);
    const mcpToken = exchanged.answer.result.token as string;
    assert.equal((await invoke("/api/rpc", "post", mcpToken, { method: "tasks.list", input: { project: "app" } })).status, 200);
    assert.equal((await invoke("/api/rpc", "post", mcpToken, { method: "memory.write", input: { project: "hidden", kind: "context", content: "hidden" } })).status, 404);
    for (const credential of [runToken, mcpToken]) {
      for (const source of ["desktop", "mcp", null]) {
        for (const [method, input] of decisions) {
          const result = await invoke("/api/rpc", "post", credential, { method, input }, source);
          assert.equal(result.status, 403, `${method} (${source}, ${credential === runToken ? "run" : "mcp"})`);
        }
      }
      assert.equal((await invoke("/api/mcp-credentials", "post", credential, { readOnly: false })).status, 403);
    }
    assert.equal((await hive.call("docs.get", { key: "project/app/agents" }, { name: "human", role: "admin" }))?.content, "Human context");
    users.setGrants(owner.id, { hidden: "lead" });
    assert.equal((await invoke("/api/rpc", "post", runToken, { method: "tasks.list", input: { project: "app" } })).status, 401);
    assert.equal((await invoke("/api/rpc", "post", mcpToken, { method: "tasks.list", input: { project: "app" } })).status, 401);
    users.setGrants(owner.id, { app: "lead", hidden: "lead" });
    const viewer = tokens.create("viewer", "viewer", owner.id);
    const viewerMcp = await invoke("/api/mcp-credentials", "post", viewer.token, { project: "app", readOnly: false });
    assert.equal(viewerMcp.status, 200);
    assert.equal((await invoke("/api/rpc", "post", viewerMcp.answer.result.token, { method: "memory.write", input: { project: "app", kind: "context", content: "readonly" } })).status, 403);
    const unowned = tokens.create("legacy", "admin");
    const unownedMcp = await invoke("/api/mcp-credentials", "post", unowned.token, { readOnly: false });
    assert.equal(unownedMcp.status, 200);
    assert.equal((await invoke("/api/rpc", "post", unownedMcp.answer.result.token, { method: "tasks.update", input: { id: "SEC-1", status: "done" } })).status, 403, "legacy admin credentials still exchange to an agent without review rights");
    assert.equal((await invoke("/api/run-credentials", "post", runToken,
      { machine: "test", project: "app", task: "SEC-1", run: "R-child", minutes: 30, readOnly: false })).status, 403);
    for (const minutes of [0, 1441, 30.5]) {
      assert.equal((await invoke("/api/run-credentials", "post", machineToken.token,
        { machine: "test", project: "app", task: "SEC-1", run: "R-invalid", minutes, readOnly: false })).status, 400);
    }
    assert.equal((await invoke("/api/run-credentials", "post", machineToken.token,
      { machine: "test", project: "app", task: "SEC-2", run: "R-invalid", minutes: 30, readOnly: false })).status, 403);
    // Research runs (roadmap 62b) have no task row; only the machine the request went to gets a credential.
    const request = (machineId: string) => Number(hive.db.prepare(`INSERT INTO run_requests(machine_id, machine, project, task_id, task_title, role,
      requested_by, requested_at, updated_at) VALUES (?, 'test', 'app', 'research-0', 'Topic', 'research', 'admin', ?, ?)`).run(machineId, now, now).lastInsertRowid);
    const research = (id: number, requestId: number) => hive.db.prepare(`INSERT INTO research_runs(id, project, input, projects, request_id, doc_key)
      VALUES (?, 'app', '{}', '["app"]', ?, 'project/app/research/x')`).run(id, requestId);
    research(7, request("runner.test@machine"));
    research(8, request("runner.other@machine"));
    assert.equal((await invoke("/api/run-credentials", "post", machineToken.token,
      { machine: "test", project: "app", task: "research-7", run: "R-research", minutes: 30, readOnly: true })).status, 200);
    assert.equal((await invoke("/api/run-credentials", "post", machineToken.token,
      { machine: "test", project: "app", task: "research-8", run: "R-research", minutes: 30, readOnly: true })).status, 403);
    assert.equal((await invoke("/api/run-credentials", "post", machineToken.token,
      { machine: "test", project: "hidden", task: "research-7", run: "R-research", minutes: 30, readOnly: true })).status, 403);
    const replacement = await invoke("/api/run-credentials", "post", machineToken.token,
      { machine: "test", project: "app", task: "SEC-1", run: "R-test", minutes: 30, readOnly: false });
    assert.equal(replacement.status, 200);
    assert.equal(tokens.verify(runToken), null, "reissuing a run credential invalidates its previous secret");
    runToken = replacement.answer.result.token;
    hive.db.prepare("UPDATE run_credentials SET expires_at = ?").run("2000-01-01T00:00:00.000Z");
    hive.db.prepare("UPDATE mcp_credentials SET expires_at = ?").run("2000-01-01T00:00:00.000Z");
    assert.equal((await invoke("/api/rpc", "post", mcpToken, { method: "tasks.list", input: { project: "app" } })).status, 401);
    assert.equal((await invoke("/api/rpc", "post", runToken, { method: "tasks.list", input: { project: "app" } })).status, 401);
    const fresh = await invoke("/api/run-credentials", "post", machineToken.token,
      { machine: "test", project: "app", task: "SEC-1", run: "R-test", minutes: 30, readOnly: true });
    const readToken = fresh.answer.result.token as string;
    assert.equal((await invoke("/api/rpc", "post", readToken, { method: "memory.write", input: { project: "app", kind: "context", content: "x" } })).status, 403);
    assert.equal((await invoke("/api/run-credentials", "delete", machineToken.token, { machine: "test", run: "R-test" })).status, 200);
    assert.equal((await invoke("/api/rpc", "post", readToken, { method: "tasks.list", input: { project: "app" } })).status, 401);
    const last = await invoke("/api/run-credentials", "post", machineToken.token,
      { machine: "test", project: "app", task: "SEC-1", run: "R-test", minutes: 30, readOnly: false });
    const lastMcp = await invoke("/api/mcp-credentials", "post", machineToken.token, { readOnly: false });
    tokens.revoke(machineToken.info.id);
    assert.equal((await invoke("/api/rpc", "post", last.answer.result.token, { method: "tasks.list", input: { project: "app" } })).status, 401);
    assert.equal((await invoke("/api/rpc", "post", lastMcp.answer.result.token, { method: "tasks.list", input: { project: "app" } })).status, 401);
  } finally { hive.close(); }
});

it("replays only the credential migration on a complete database", () => {
  const index = migrationIndex("CREATE TABLE run_credentials(");
  const hive = new SqliteHive(":memory:");
  try {
    assert.ok(Number((hive.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version) >= index + 1);
    hive.db.exec(`DROP TABLE run_credentials; DROP TABLE mcp_credentials; PRAGMA user_version = ${index}`);
    const upgraded = new SqliteHive(hive.db, { migrateTo: index + 1 });
    assert.ok(upgraded.db.prepare("SELECT 1 FROM run_credentials").all());
    assert.ok(upgraded.db.prepare("SELECT 1 FROM mcp_credentials").all());
  } finally { hive.close(); }
});
