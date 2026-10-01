import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { grantPermissions, ROLE_PERMISSIONS, type Actor } from "@xdev-hive/core";
import { SqliteHive } from "@xdev-hive/core/node";
import { createHubApp } from "#web/app.ts";
import { narrowest } from "#web/grants.ts";
import { TokenStore } from "#web/tokens.ts";
import { UserStore } from "#web/users.ts";

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

    // Asked for between heartbeats too, with a token of its own each time.
    const [polled] = (await rpc(machineToken, "chat.poll", {})).body.result;
    assert.equal(polled.sender, undefined);
    assert.match(polled.grant, /^hivechat_/);

    const beat = await heartbeat();
    const [request] = beat.body.result.chatRequests;
    assert.equal((await rpc(polled.grant, "tasks.list", {}, "claude-1.hoa-mbp")).status, 401, "a newer token replaces the one handed out before");
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
    // What it may not do itself, it proposes; Lan confirms it in the chat and it runs with Lan's rights.
    const tools = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(tools.includes("propose_task") && tools.includes("propose_run") && tools.includes("propose_task_status"), tools.join());
    assert.ok(!tools.includes("task_update") && !tools.includes("task_claim"), "a leader works on no task of its own");
    const proposed = await client.callTool({ name: "propose_task", arguments: { id: "app-2", title: "New", reason: "Asked for in the chat" } });
    assert.notEqual(proposed.isError, true, JSON.stringify(proposed.content));
    const actionId = JSON.parse((proposed.content as Array<{ text: string }>)[0]!.text).id as number;
    await client.close();
    assert.equal((await rpc(machineToken, "chat.propose", { action: { kind: "task.create", id: "app-3", title: "x" }, reason: "r" })).body.error?.key, "errors.chatProposeOnly", "not with the machine's own token");
    const decided = await lan("chat.decide", { actionId, accept: true });
    assert.deepEqual([decided.body.result?.status, decided.body.result?.result], ["done", { taskId: "app-2" }], JSON.stringify(decided.body));

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
    const both = narrowest(member, machine);
    assert.equal(both.role, "member");
    assert.deepEqual(Object.keys(both.access!.projects), ["app"], "only the projects both have");
    assert.deepEqual([...grantPermissions(both.access!.projects.app)].sort(), [...ROLE_PERMISSIONS.member].sort(), "lead ∩ member is member");
    assert.deepEqual(narrowest(admin, machine), { role: "member", access: machine.access }, "an unrestricted admin gets the machine's projects");
    assert.deepEqual(narrowest(admin, agentToken), { role: "agent" }, "an agent token never manages");
    assert.deepEqual(narrowest(member, agentToken), { role: "agent", access: member.access });
  });

  it("takes a chat file over HTTP from the session, and serves it so it can never run as a hub page", async () => {
    const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json", "x-hive-csrf": "1" }, body: JSON.stringify({ username: "lan", password }) });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const upload = (body: Uint8Array, query: string, headers: Record<string, string> = { "x-hive-csrf": "1" }) =>
      fetch(`${base}/api/chat/files?${query}`, { method: "POST", headers: { cookie, "content-type": "application/octet-stream", ...headers }, body });

    assert.equal((await upload(png, "project=app&name=a.png", {})).status, 403, "a cross-site form cannot post a file");
    assert.equal((await upload(png, "project=site&name=a.png")).status, 404, "Lan has no site");
    assert.equal((await upload(new Uint8Array(5 * 1024 * 1024 + 10), "project=app&name=big.png")).status, 413);
    const up = await upload(png, `project=app&name=${encodeURIComponent("lỗi đăng nhập.png")}`);
    assert.equal(up.status, 200);
    const file = ((await up.json()) as { result: { id: number; name: string; type: string } }).result;
    assert.deepEqual([file.name, file.type], ["lỗi đăng nhập.png", "image/png"]);

    const text = await upload(new TextEncoder().encode("<script>alert(1)</script>"), "project=app&name=notes.txt");
    const note = ((await text.json()) as { result: { id: number } }).result;
    const read = await fetch(`${base}/api/chat/files/${note.id}`, { headers: { cookie } });
    assert.equal(read.status, 200);
    assert.equal(read.headers.get("content-type"), "text/plain; charset=utf-8", "text is never served as a page");
    assert.equal(read.headers.get("x-content-type-options"), "nosniff");
    assert.match(read.headers.get("content-security-policy") ?? "", /sandbox/);
    assert.match(read.headers.get("content-disposition") ?? "", /^attachment; filename\*=UTF-8''notes\.txt$/);
    const image = await fetch(`${base}/api/chat/files/${file.id}`, { headers: { cookie } });
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.match(image.headers.get("content-disposition") ?? "", /^inline;/);
    assert.deepEqual([...new Uint8Array(await image.arrayBuffer())], [...png]);
    assert.equal((await fetch(`${base}/api/chat/files/${file.id}`)).status, 401, "not without a session or token");
    assert.equal((await fetch(`${base}/api/chat/files/abc`, { headers: { cookie } })).status, 404);
  });
});
