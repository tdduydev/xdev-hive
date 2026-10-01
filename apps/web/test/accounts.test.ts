import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Actor } from "@xdev-hive/core";
import { SqliteHive } from "@xdev-hive/core/node";
import { createHubApp } from "#web/app.ts";
import { TokenStore } from "#web/tokens.ts";
import { LoginThrottle, UserStore } from "#web/users.ts";

let base = "";
let close: () => void;
let users: UserStore;
let adminToken = "";
const temp: Record<string, string> = {};

before(async () => {
  const hive = new SqliteHive(":memory:");
  hive.seed("hub");
  const root: Actor = { name: "duy", role: "admin" };
  for (const p of ["app", "billing"]) {
    await hive.call("docs.save", { key: `project/${p}/agents`, content: `${p} rules` }, root);
    await hive.call("tasks.create", { id: `${p}-1`, project: p, title: `${p} task` }, root);
  }
  const tokens = new TokenStore(hive.db);
  users = new UserStore(hive.db);
  adminToken = tokens.create("ops", "admin").token;
  temp.duy = users.create({ username: "duy", admin: true }).password;
  const lan = users.create({ username: "lan", displayName: "Lan" });
  temp.lan = lan.password;
  users.setGrants(lan.user.id, { app: "manage" });
  const app = createHubApp({ hive, tokens, users, allowedHosts: ["127.0.0.1", "localhost"], throttle: new LoginThrottle(3, 60_000) });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
after(() => close());

/** A tiny browser: keeps the session cookie and sends the CSRF header like the web client. */
function browser() {
  let cookie = "";
  const send = async (path: string, body?: unknown, extra: Record<string, string> = {}) => {
    const res = await fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", "x-hive-csrf": "1", ...(cookie ? { cookie } : {}), ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0]!.endsWith("=") ? "" : set.split(";")[0]!;
    return { status: res.status, body: (await res.json()) as { result?: any; error?: { code: string; message: string } }, set };
  };
  return { send, rpc: (method: string, input: unknown = {}) => send("/api/rpc", { method, input }), cookie: () => cookie };
}

async function signedIn(username: string, password: string) {
  const b = browser();
  const login = await b.send("/api/login", { username, password });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return b;
}

describe("accounts", () => {
  it("signs in with a temporary password that must be changed before anything else", async () => {
    const b = browser();
    const wrong = await b.send("/api/login", { username: "lan", password: "wrong-password" });
    assert.equal(wrong.status, 401);
    assert.equal((wrong.body.error as { key?: string }).key, "errors.badCredentials", "the interface translates it");
    const login = await b.send("/api/login", { username: "Lan", password: temp.lan });
    assert.equal(login.status, 200);
    assert.match(login.set ?? "", /hive_session=hs_[\w-]+; Path=\/; HttpOnly; SameSite=Strict/);
    assert.equal(login.body.result.user.mustChangePassword, true);
    assert.equal((await b.rpc("docs.list")).status, 403, "blocked until the password is changed");

    assert.equal((await b.send("/api/password", { current: temp.lan, next: "short" })).status, 400);
    const changed = await b.send("/api/password", { current: temp.lan, next: "blue-comb-2026!" });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal(changed.body.result.user.mustChangePassword, false);
    assert.equal((await b.rpc("docs.list")).status, 200);
    const saved = await b.rpc("memory.write", { project: "app", kind: "context", content: "From the web page" });
    assert.deepEqual(saved.body.result?.source ?? saved.body.error, { via: "web" });
  });

  it("shows a member only the projects granted, and refuses cookie calls without the CSRF header", async () => {
    const b = await signedIn("lan", "blue-comb-2026!");
    const me = (await b.send("/api/me")).body.result;
    // Saved as the old "manage", read as the role it became (roadmap 25).
    assert.deepEqual([me.role, me.access], ["member", { projects: { app: "lead" } }]);
    const keys = (await b.rpc("docs.list")).body.result.map((d: { key: string }) => d.key);
    assert.ok(keys.includes("project/app/agents") && keys.includes("org/agent-protocol"));
    assert.ok(!keys.includes("project/billing/agents"));
    const hidden = await b.rpc("docs.get", { key: "project/billing/agents" });
    assert.deepEqual([hidden.status, (hidden.body.error as { key?: string }).key], [404, "errors.notFound"]);
    const low = await b.rpc("docs.save", { key: "project/app/agents", content: "x" });
    assert.equal(low.status, 200, "manage on app");
    assert.equal((await b.rpc("tasks.create", { id: "app-2", project: "app", title: "Mới" })).status, 200, "manage on app");

    const forged = await fetch(`${base}/api/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: b.cookie() },
      body: JSON.stringify({ method: "docs.list", input: {} }),
    });
    assert.equal(forged.status, 403);
    const crossSite = await b.send("/api/rpc", { method: "docs.list", input: {} }, { origin: "https://evil.example" });
    assert.equal(crossSite.status, 403);
  });

  it("gives a machine a token owned by the person, with the same projects", async () => {
    const got = await fetch(`${base}/api/device-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "lan", password: "blue-comb-2026!", name: "lan-mbp" }),
    });
    const { result } = (await got.json()) as { result: { token: string; info: { role: string; ownerId: string } } };
    assert.equal(result.info.role, "member");
    const call = (method: string, input: unknown) =>
      fetch(`${base}/api/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${result.token}`, "x-hive-agent": "claude-1.lan-mbp" },
        body: JSON.stringify({ method, input }),
      }).then(async (r) => ({ status: r.status, body: (await r.json()) as { result?: any } }));
    assert.deepEqual((await call("tasks.list", {})).body.result.map((t: { id: string }) => t.id).sort(), ["app-1", "app-2"]);

    // Agents on that machine reach the hub over MCP with the same token and see the same.
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${result.token}`, "x-hive-agent": "codex" } },
    });
    const client = new Client({ name: "test", version: "0" });
    await client.connect(transport);
    const hidden = await client.callTool({ name: "doc_get", arguments: { key: "project/billing/agents" } });
    assert.equal(hidden.isError, true);
    await client.close();

    // A temporary password cannot mint machine tokens.
    const fresh = users.create({ username: "minh" });
    const refused = await fetch(`${base}/api/device-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "minh", password: fresh.password, name: "minh-pc" }),
    });
    assert.equal(refused.status, 403);
  });

  it("lets only admins manage accounts; a disabled account loses its session and tokens at once", async () => {
    const lan = await signedIn("lan", "blue-comb-2026!");
    assert.equal((await lan.rpc("users.list")).status, 403);
    const own = await lan.rpc("tokens.create", { name: "lan-ci", role: "agent" });
    assert.equal(own.status, 200);
    assert.equal((await lan.rpc("tokens.create", { name: "lan-root", role: "admin" })).status, 403);
    assert.deepEqual((await lan.rpc("tokens.list")).body.result.map((t: { name: string }) => t.name).sort(), ["lan-ci", "lan-mbp"]);

    const duy = await signedIn("duy", temp.duy!);
    await duy.send("/api/password", { current: temp.duy, next: "hive-admin-2026!" });
    const list = (await duy.rpc("users.list")).body.result as Array<{ id: string; username: string }>;
    const lanId = list.find((u) => u.username === "lan")!.id;
    assert.equal((await duy.rpc("users.setGrants", { id: lanId, grants: { app: "view", billing: "view" } })).status, 200);
    const keys = (await lan.rpc("docs.list")).body.result.map((d: { key: string }) => d.key);
    assert.ok(keys.includes("project/billing/agents"), "a grant applies to the next call");

    assert.equal((await duy.rpc("users.update", { id: lanId, disabled: true })).status, 200);
    assert.equal((await lan.rpc("docs.list")).status, 401);
    const ci = await fetch(`${base}/api/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${own.body.result.token}` },
      body: JSON.stringify({ method: "docs.list", input: {} }),
    });
    assert.equal(ci.status, 401, "tokens of a disabled account stop working");

    const log = (await duy.rpc("admin.audit", {})).body.result as Array<{ action: string; target: string }>;
    assert.ok(log.some((e) => e.action === "users.setGrants" && e.target === "lan"));
    assert.ok(log.some((e) => e.action === "auth.login" && e.target === "lan"));
  });

  it("locks a username after repeated wrong passwords, and keeps old tokens of no account working", async () => {
    const b = browser();
    for (let i = 0; i < 3; i++) assert.equal((await b.send("/api/login", { username: "duy", password: "nope-nope-nope" })).status, 401);
    const locked = await b.send("/api/login", { username: "duy", password: "hive-admin-2026!" });
    assert.equal(locked.status, 403);
    assert.match(locked.body.error!.message, /Sai quá nhiều lần/);

    const legacy = await fetch(`${base}/api/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ method: "docs.list", input: {} }),
    });
    const keys = ((await legacy.json()) as { result: Array<{ key: string }> }).result.map((d) => d.key);
    assert.ok(keys.includes("project/billing/agents"), "a token of no account keeps the old admin rights");
  });
});
