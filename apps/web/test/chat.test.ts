import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Actor } from "@xdev-hive/core";
import { SqliteHive } from "@xdev-hive/core/node";
import { createHubApp } from "../src/app.ts";
import { narrowest } from "../src/grants.ts";
import { TokenStore } from "../src/tokens.ts";
import { UserStore } from "../src/users.ts";

let base = "";
let close: () => void;
let machineToken = "";
const password = "blue-comb-2026!";

before(async () => {
  const hive = new SqliteHive(":memory:");
  hive.seed("hub");
  const root: Actor = { name: "duy", role: "admin" };
  for (const p of ["app", "site"]) {
    await hive.call("docs.save", { key: `project/${p}/agents`, content: `${p} rules` }, root);
    await hive.call("tasks.create", { id: `${p}-1`, project: p, title: `${p} task` }, root);
  }
  const tokens = new TokenStore(hive.db);
  const users = new UserStore(hive.db);
  const person = (username: string, grants: Record<string, string>) => {
    const { user, password: temp } = users.create({ username });
    users.changePassword(user.id, temp, password);
    users.setGrants(user.id, grants);
    return user;
  };
  // Lan manages app; the machine belongs to Hoa, who only contributes to app but manages site.
  person("lan", { app: "manage" });
  const hoa = person("hoa", { app: "contribute", site: "manage" });
  machineToken = tokens.create("hoa-mbp", "member", hoa.id).token;
  const app = createHubApp({ hive, tokens, users, allowedHosts: ["127.0.0.1", "localhost"] });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
after(() => close());

const rpc = (bearer: string, method: string, input: unknown, agent = "runner.hoa-mbp") =>
  fetch(`${base}/api/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bearer}`, "x-hive-agent": agent },
    body: JSON.stringify({ method, input }),
  }).then(async (r) => ({ status: r.status, body: (await r.json()) as { result?: any; error?: { code: string; key?: string } } }));

async function signIn(username: string) {
  const res = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json", "x-hive-csrf": "1" }, body: JSON.stringify({ username, password }) });
  assert.equal(res.status, 200);
  const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  return (method: string, input: unknown) =>
    fetch(`${base}/api/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hive-csrf": "1", cookie },
      body: JSON.stringify({ method, input }),
    }).then(async (r) => ({ status: r.status, body: (await r.json()) as { result?: any; error?: { code: string; key?: string } } }));
}

const heartbeat = () =>
  rpc(machineToken, "machines.heartbeat", {
    machine: "hoa-mbp",
    instance: "a1b2c3d4",
    projects: ["app", "site"],
    acceptsRuns: true,
    profiles: [{ id: "claude-1", label: "Claude", kind: "claude", enabled: true, account: null, installed: true, loggedIn: true, cooldownUntil: null, runs: 0, rateLimited: 0 }],
  });

describe("chat replies on the hub", () => {
  it("gives the leader a token with only what both the sender and the machine may do, until the reply ends", async () => {
    await heartbeat();
    const lan = await signIn("lan");
    const sent = await lan("chat.send", { project: "app", machineId: "runner.hoa-mbp@hoa-mbp", text: "Tidy up the app tasks" });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));

    const beat = await heartbeat();
    const [request] = beat.body.result.chatRequests;
    assert.equal(request.replyId, sent.body.result.reply.id);
    assert.equal(request.sender, undefined, "the sender's rights stay on the hub");
    assert.match(request.grant, /^hivechat_/);
    const grant = request.grant as string;

    // Lan manages app and has no site; Hoa's machine only contributes to app: the leader contributes to app, nothing more.
    const tasks = await rpc(grant, "tasks.list", {}, "claude-1.hoa-mbp");
    assert.deepEqual(tasks.body.result.map((t: { id: string }) => t.id), ["app-1"], "site is Hoa's, not Lan's");
    assert.equal((await rpc(grant, "tasks.update", { id: "app-1", status: "doing" }, "claude-1.hoa-mbp")).status, 200, "contribute on app");
    const create = await rpc(grant, "tasks.create", { id: "app-2", project: "app", title: "New" }, "claude-1.hoa-mbp");
    assert.equal(create.status, 403, "manage needs both: Hoa's machine only contributes to app");
    const hidden = await rpc(grant, "docs.get", { key: "project/site/agents" }, "claude-1.hoa-mbp");
    assert.equal(hidden.body.error?.code, "not_found");

    // The same token works over MCP, where the agent's calls go.
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${grant}`, "x-hive-agent": "claude-1.hoa-mbp" } } });
    const client = new Client({ name: "test", version: "0" });
    await client.connect(transport);
    const doc = await client.callTool({ name: "doc_get", arguments: { key: "project/app/agents" } });
    assert.notEqual(doc.isError, true);
    await client.close();

    // The update is recorded under the leader's name.
    const updated = (await lan("tasks.list", { project: "app" })).body.result.find((t: { id: string }) => t.id === "app-1");
    assert.match(updated.owner ?? "", /claude-1\.hoa-mbp@chat-lan/);

    const done = await rpc(machineToken, "chat.finish", { replyId: request.replyId, status: "done", text: "Moved app-1 to doing." });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal((await rpc(grant, "tasks.list", {}, "claude-1.hoa-mbp")).status, 401, "gone with its reply");
  });

  it("narrows roles and projects to what both may do", () => {
    const admin: Actor = { name: "duy", role: "admin" };
    const agentToken: Actor = { name: "runner.x@ci", role: "agent" };
    const member: Actor = { name: "lan", role: "member", access: { projects: { app: "manage", site: "view" } } };
    const machine: Actor = { name: "runner.hoa@hoa", role: "member", access: { projects: { app: "contribute", billing: "manage" } } };
    assert.deepEqual(narrowest(member, machine), { role: "member", access: { projects: { app: "contribute" } } });
    assert.deepEqual(narrowest(admin, machine), { role: "member", access: machine.access }, "an unrestricted admin gets the machine's projects");
    assert.deepEqual(narrowest(admin, agentToken), { role: "agent" }, "an agent token never manages");
    assert.deepEqual(narrowest(member, agentToken), { role: "agent", access: member.access });
  });
});
