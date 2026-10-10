// Roadmap 79c: disabling or trashing an account revokes what could act as it, and enabling it again brings none of it back.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import type { Actor } from "@xdev-hive/core";
import { SqliteHive } from "@xdev-hive/core/node";
import { createHubApp } from "#web/app.ts";
import { TokenStore } from "#web/tokens.ts";
import { LoginThrottle, UserStore } from "#web/users.ts";

let base = "";
let close: () => void;
let users: UserStore;
let tokens: TokenStore;
let hive: SqliteHive;
const PW = "Zq83kd2-secret-A";

before(async () => {
  hive = new SqliteHive(":memory:");
  hive.seed("hub");
  const root: Actor = { name: "duy", role: "admin" };
  await hive.call("tasks.create", { id: "app-1", project: "app", title: "app task" }, root);
  tokens = new TokenStore(hive.db);
  users = new UserStore(hive.db);
  const boss = users.create({ username: "boss", hubRole: "owner" });
  users.changePassword(boss.user.id, boss.password, PW);
  const app = createHubApp({ hive, tokens, users, allowedHosts: ["127.0.0.1", "localhost"], throttle: new LoginThrottle(50, 60_000) });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
after(() => close());

function browser() {
  let cookie = "";
  const send = async (path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", "x-hive-csrf": "1", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0]!.endsWith("=") ? "" : set.split(";")[0]!;
    return { status: res.status, body: (await res.json()) as { result?: any; error?: { code: string; key?: string } } };
  };
  return { send, rpc: (method: string, input: unknown = {}) => send("/api/rpc", { method, input }) };
}
async function signedIn(username: string, password: string) {
  const b = browser();
  const r = await b.send("/api/login", { username, password });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return b;
}
const bearer = async (token: string) => (await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${token}` } })).status;

/** A settled member with two browser sessions, two machine tokens and an MCP credential issued from one of them. */
async function member(username: string) {
  const made = users.create({ username, hubRole: "member" });
  const password = "Lm47-pass-Qw91x";
  users.changePassword(made.user.id, made.password, password);
  users.setGrants(made.user.id, { app: "member" });
  const laptop = tokens.create("laptop", "agent", made.user.id).token;
  const desktop = tokens.create("desktop", "agent", made.user.id).token;
  const mcp = tokens.issueMcp(laptop, "app", false);
  const one = await signedIn(username, password);
  const two = await signedIn(username, password);
  for (const t of [laptop, desktop, mcp]) assert.equal(await bearer(t), 200);
  return { id: made.user.id, password, laptop, desktop, mcp, one, two };
}
const lastAudit = (target: string) =>
  hive.db.prepare("SELECT action, detail, detail_key, detail_vars FROM audit WHERE target = ? ORDER BY id DESC LIMIT 1").get(target) as Record<string, string>;

describe("disable revokes", () => {
  it("signs out every session, deletes every token and MCP credential, and enabling again brings none back", async () => {
    const m = await member("dan");
    const boss = await signedIn("boss", PW);
    assert.equal((await boss.rpc("users.update", { id: m.id, disabled: true })).status, 200);
    assert.equal((await m.one.send("/api/me")).status, 401);
    assert.equal((await m.two.send("/api/me")).status, 401);
    assert.deepEqual(tokens.list(m.id), []);
    for (const t of [m.laptop, m.desktop, m.mcp]) assert.equal(tokens.verify(t), null);

    const audit = lastAudit("dan");
    assert.equal(audit.action, "users.update");
    assert.equal(audit.detail_key, "audit.disabledRevoked");
    assert.deepEqual(JSON.parse(audit.detail_vars!), { sessions: 2, tokens: 2 });
    assert.match(audit.detail!, /thu hồi 2 token, 2 phiên/);

    assert.equal((await boss.rpc("users.update", { id: m.id, disabled: false })).status, 200);
    assert.equal(lastAudit("dan").detail_key, "audit.enabled");
    for (const t of [m.laptop, m.desktop, m.mcp]) assert.equal(await bearer(t), 401);
    assert.equal((await m.one.send("/api/me")).status, 401);
    // The account itself works again: only what it held before is gone.
    await signedIn("dan", m.password);
  });

  it("an account disabled before revocation existed loses its old tokens when enabled", () => {
    const { user } = users.create({ username: "legacy" });
    const old = tokens.create("old-pc", "agent", user.id).token;
    // As an older hub left it: disabled, its token only refused.
    hive.db.prepare("UPDATE hub_users SET disabled = 1 WHERE id = ?").run(user.id);
    users.update(user.id, { disabled: false });
    assert.equal(tokens.verify(old), null);
  });

  it("changing only the name or role of an enabled account keeps its tokens", () => {
    const { user } = users.create({ username: "keeper" });
    const t = tokens.create("pc", "agent", user.id).token;
    users.update(user.id, { displayName: "Keeper" });
    users.update(user.id, { hubRole: "viewer" });
    assert.ok(tokens.verify(t));
  });
});

describe("trash revokes", () => {
  it("over rpc: sessions, tokens and MCP credentials go, a restore does not bring them back, and the audit counts them", async () => {
    const m = await member("tom");
    const boss = await signedIn("boss", PW);
    assert.equal((await boss.rpc("users.trash", { id: m.id })).status, 200);
    assert.equal((await m.one.send("/api/me")).status, 401);
    assert.deepEqual(tokens.list(m.id), []);
    const audit = lastAudit("tom");
    assert.equal(audit.action, "users.trash");
    assert.equal(audit.detail_key, "audit.userTrashedRevoked");
    assert.deepEqual(JSON.parse(audit.detail_vars!), { sessions: 2, tokens: 2 });

    assert.equal((await boss.rpc("users.restore", { id: m.id })).status, 200);
    for (const t of [m.laptop, m.desktop, m.mcp]) assert.equal(await bearer(t), 401);
    assert.equal(users.get(m.id)!.grants.app, "member");
  });
});

describe("passwords", () => {
  it("changing one's password signs out the other sessions and keeps the current one", async () => {
    const m = await member("pat");
    const next = "Lm47-next-Qw91x";
    const r = await m.one.send("/api/password", { current: m.password, next });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await m.one.send("/api/me")).status, 200);
    assert.equal((await m.two.send("/api/me")).status, 401);
    // Machine tokens are not sessions: they keep working.
    assert.equal(await bearer(m.laptop), 200);
  });

  it("an admin's reset signs out every session of the account", async () => {
    const m = await member("rob");
    const boss = await signedIn("boss", PW);
    const r = await boss.rpc("users.resetPassword", { id: m.id });
    assert.equal(r.status, 200);
    assert.equal((await m.one.send("/api/me")).status, 401);
    assert.equal((await m.two.send("/api/me")).status, 401);
    assert.equal(lastAudit("rob").action, "users.resetPassword");
  });
});

describe("revokeAccess", () => {
  it("reports what it removed and leaves other accounts alone", () => {
    const a = users.create({ username: "ra" }).user;
    const b = users.create({ username: "rb" }).user;
    users.startSession(a.id);
    const kept = tokens.create("pc", "agent", b.id).token;
    tokens.create("pc", "agent", a.id);
    tokens.create("pc2", "agent", a.id);
    assert.deepEqual(users.revokeAccess(a.id), { sessions: 1, tokens: 2 });
    assert.deepEqual(users.revokeAccess(a.id), { sessions: 0, tokens: 0 });
    assert.ok(tokens.verify(kept));
  });
});
