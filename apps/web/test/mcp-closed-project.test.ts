import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Actor } from "@xdev-hive/core";
import { SqliteHive } from "@xdev-hive/core/node";
import { createHiveMcpServer, mcpHubBackend } from "@xdev-hive/mcp";
import { createHubApp } from "#web/app.ts";
import { TokenStore } from "#web/tokens.ts";
import { UserStore } from "#web/users.ts";

// Incident 2026-10-09: HIVE_PROJECT named a deleted project and every MCP tool answered [] as if the hub were empty.
it("refuses an MCP credential for an archived or deleted project with who and when, and the tools say so", async () => {
  const hive = new SqliteHive(":memory:");
  const root: Actor = { name: "duy", role: "admin" };
  for (const p of ["app", "gone", "old"]) await hive.call("tasks.create", { id: `${p}-1`, project: p, title: `${p} task` }, root);
  const tokens = new TokenStore(hive.db);
  const users = new UserStore(hive.db);
  const owner = users.create({ username: "owner" }).user;
  users.setGrants(owner.id, { app: "lead", gone: "lead", old: "lead" });
  const machine = tokens.create("machine", "member", owner.id).token;
  const server = createHubApp({ hive, tokens, users, allowedHosts: ["127.0.0.1"] }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (path: string, token: string, body: unknown) => {
    const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any };
  };
  const tools = async (project: string) => {
    const backend = mcpHubBackend({ url: base, token: machine }, project, false);
    const mcp = createHiveMcpServer(backend, { name: "claude@m", role: "member", mcpCredential: true }, { defaultProject: project });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await mcp.connect(a);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(b);
    return { backend, client };
  };
  const text = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as Array<{ text: string }>)[0]!.text;
  try {
    // Issued while the project was still in use: the incident's credential row.
    const stale = (await post("/api/mcp-credentials", machine, { project: "gone", readOnly: false })).body.result.token as string;
    hive.db.prepare(`INSERT INTO project_states(project, state, at, "by") VALUES ('gone', 'deleted', '2026-10-05T08:00:00.000Z', 'lan')`).run();
    await hive.call("projects.archive", { project: "old" }, root);

    const issued = await post("/api/mcp-credentials", machine, { project: "gone", readOnly: false });
    assert.equal(issued.status, 409);
    assert.equal(issued.body.error.key, "errors.projectDeleted");
    assert.deepEqual(issued.body.error.vars, { project: "gone", by: "lan", at: "2026-10-05T08:00:00.000Z" });
    assert.match(issued.body.error.message, /gone was deleted by lan at 2026-10-05/);

    const used = await post("/api/rpc", stale, { method: "projects.list", input: {} });
    assert.equal(used.status, 409, "a credential issued before the deletion is refused too, not answered with []");
    assert.equal(used.body.error.key, "errors.projectDeleted");

    const archived = await post("/api/mcp-credentials", machine, { project: "old", readOnly: false });
    assert.equal(archived.status, 409);
    assert.equal(archived.body.error.key, "errors.projectArchived");
    assert.equal(archived.body.error.vars.by, "duy");

    const dead = await tools("gone");
    const check = await dead.backend.check();
    assert.equal(check?.key, "errors.projectDeleted");
    for (const name of ["project_list", "task_list"]) {
      const result = await dead.client.callTool({ name, arguments: {} });
      assert.equal(result.isError, true, name);
      assert.match(text(result), /gone was deleted by lan/, name);
      assert.match(text(result), /HIVE_PROJECT=gone/, name);
      assert.match(text(result), /\.mcp\.json/, name);
    }
    const shelved = await tools("old");
    assert.match(text(await shelved.client.callTool({ name: "project_list", arguments: {} })), /old was archived by duy.*restore old/);

    const live = await tools("app");
    assert.equal(await live.backend.check(), null);
    const listed = await live.client.callTool({ name: "task_list", arguments: {} });
    assert.equal(listed.isError, undefined, text(listed));
    assert.match(text(listed), /app-1/);
    // An unreachable hub is not a closed project: the startup check stays quiet and lets the tools report it.
    assert.equal(await mcpHubBackend({ url: "http://127.0.0.1:1", token: machine }, "app", false).check(), null);
  } finally {
    server.close();
    hive.close();
  }
});
