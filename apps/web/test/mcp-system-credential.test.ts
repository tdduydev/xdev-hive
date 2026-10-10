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

// GROUP-cli: a CLI opened on a whole system reaches the system's projects, and only those the account sees.
it("an MCP credential for a system reaches its projects only, and its tools still need a project", async () => {
  const hive = new SqliteHive(":memory:");
  const root: Actor = { name: "duy", role: "admin" };
  for (const p of ["his-api", "his-web", "billing"]) await hive.call("tasks.create", { id: `${p}-1`, project: p, title: `${p} task` }, root);
  await hive.call("systems.save", { name: "his", projects: ["his-api", "his-web"] }, root);
  const tokens = new TokenStore(hive.db);
  const users = new UserStore(hive.db);
  const lead = users.create({ username: "lead" }).user;
  users.setGrants(lead.id, { "his-api": "lead", "his-web": "lead", billing: "lead" });
  const narrow = users.create({ username: "narrow" }).user;
  users.setGrants(narrow.id, { "his-api": "member" });
  const outsider = users.create({ username: "outsider" }).user;
  users.setGrants(outsider.id, { billing: "member" });
  const machine = tokens.create("machine", "member", lead.id).token;
  const narrowMachine = tokens.create("narrow-machine", "member", narrow.id).token;
  const outsiderMachine = tokens.create("outsider-machine", "member", outsider.id).token;
  const server = createHubApp({ hive, tokens, users, allowedHosts: ["127.0.0.1"] }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (path: string, token: string, body: unknown) => {
    const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any };
  };
  const rpc = async (token: string, method: string, input: unknown) => (await post("/api/rpc", token, { method, input })).body;
  try {
    const issued = await post("/api/mcp-credentials", machine, { system: "his", readOnly: false });
    assert.equal(issued.status, 200, JSON.stringify(issued.body));
    const cred = issued.body.result.token as string;
    assert.deepEqual((await rpc(cred, "projects.list", {})).result.map((p: { project: string }) => p.project).sort(), ["his-api", "his-web"]);
    assert.deepEqual((await rpc(cred, "tasks.list", {})).result.map((t: { id: string }) => t.id).sort(), ["his-api-1", "his-web-1"]);
    const outside = await rpc(cred, "memory.write", { project: "billing", kind: "gotcha", content: "outside" });
    assert.ok(outside.error, "a project outside the system is out of reach");
    const inside = await rpc(cred, "memory.write", { project: "his-web", kind: "gotcha", content: "inside" });
    assert.ok(inside.result, JSON.stringify(inside));

    // The system's projects as they are now: one added later is reached by the same credential.
    await hive.call("systems.save", { name: "his", projects: ["his-api", "his-web", "billing"] }, root);
    assert.ok((await rpc(cred, "tasks.list", {})).result.some((t: { id: string }) => t.id === "billing-1"));
    await hive.call("systems.save", { name: "his", projects: ["his-api", "his-web"] }, root);

    // Never more than the account sees: narrow only has his-api.
    const narrowCred = (await post("/api/mcp-credentials", narrowMachine, { system: "his", readOnly: false })).body.result.token as string;
    assert.deepEqual((await rpc(narrowCred, "projects.list", {})).result.map((p: { project: string }) => p.project), ["his-api"]);
    assert.equal((await post("/api/mcp-credentials", outsiderMachine, { system: "his", readOnly: false })).status, 403, "sees none of the system");
    assert.equal((await post("/api/mcp-credentials", machine, { system: "his", project: "his-api", readOnly: false })).status, 400, "one or the other");
    assert.equal((await post("/api/mcp-credentials", machine, { system: "Not A Key", readOnly: false })).status, 400);

    // The MCP server of such a session: no default project, and the error names the system.
    const backend = mcpHubBackend({ url: base, token: machine }, undefined, false, "his");
    const mcp = createHiveMcpServer(backend, { name: "claude@m", role: "member", mcpCredential: true }, { system: "his" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await mcp.connect(a);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(b);
    const text = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as Array<{ text: string }>)[0]!.text;
    const named = await client.callTool({ name: "task_list", arguments: { project: "his-api" } });
    assert.equal(named.isError, undefined, text(named));
    assert.match(text(named), /his-api-1/);
    const noProject = await client.callTool({ name: "memory_write", arguments: { kind: "gotcha", content: "x" } });
    assert.equal(noProject.isError, true);
    assert.match(text(noProject), /system his/);
  } finally {
    server.close();
  }
});
