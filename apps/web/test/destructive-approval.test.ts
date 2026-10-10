import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { DESTRUCTIVE_HUB_EXEMPT, DESTRUCTIVE_HUB_RPCS, DESTRUCTIVE_NAME, type Actor } from "@xdev-hive/core";
import { SqliteHive } from "@xdev-hive/core/node";
import { createHubApp, WEB_RPC } from "#web/app.ts";
import { TokenStore } from "#web/tokens.ts";
import { LoginThrottle, UserStore } from "#web/users.ts";
import { adminSession, authHeaders } from "./session.ts";

let base = "";
let close: (() => void) | undefined;
let hive: SqliteHive;
let tokens: TokenStore;
let users: UserStore;
let adminToken = "";
const password = "pw-owner-Zq83kd2";

before(async () => {
  hive = new SqliteHive(":memory:", { backup: async () => ({ file: "/backups/hub.db" }) });
  hive.seed("hub");
  tokens = new TokenStore(hive.db);
  users = new UserStore(hive.db);
  const made = users.create({ username: "boss", hubRole: "owner" });
  users.changePassword(made.user.id, made.password, password);
  // The incident's shape: the machine's admin token, used by an agent session on that machine.
  adminToken = tokens.create("hc-duytd20-macmini", "admin", made.user.id).token;
  const root: Actor = { name: "boss", role: "admin" };
  await hive.call("tasks.create", { id: "T-1", project: "ehospital", title: "Keep" }, root);
  await hive.call("projects.archive", { project: "ehospital" }, root);
  const app = createHubApp({ hive, tokens, users, allowedHosts: ["127.0.0.1", "localhost"], throttle: new LoginThrottle(8, 60_000) });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
after(() => close?.());

type Answer = { status: number; body: { result?: any; error?: { code: string; message: string; key?: string; vars?: Record<string, number | string> } } };

/** What hub-client sends for an agent: its label and the MCP source. */
async function agent(method: string, input: unknown): Promise<Answer> {
  const res = await fetch(`${base}/api/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(adminToken), "x-hive-agent": "claude-code", "x-hive-source": JSON.stringify({ via: "mcp" }) },
    body: JSON.stringify({ method, input }),
  });
  return { status: res.status, body: await res.json() as Answer["body"] };
}

async function person() {
  let cookie = "";
  const send = async (path: string, body: unknown): Promise<Answer> => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hive-csrf": "1", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0]!;
    return { status: res.status, body: await res.json() as Answer["body"] };
  };
  assert.equal((await send("/api/login", { username: "boss", password })).status, 200);
  return (method: string, input: unknown = {}) => send("/api/rpc", { method, input });
}

describe("destructive calls of agents on the hub (ADM)", () => {
  it("classifies every hub RPC named like a deletion", () => {
    const loose = Object.keys(WEB_RPC).filter((m) => DESTRUCTIVE_NAME.test(m) && !(DESTRUCTIVE_HUB_RPCS as readonly string[]).includes(m) && !(m in DESTRUCTIVE_HUB_EXEMPT));
    assert.deepEqual(loose, [], "add each to DESTRUCTIVE_HUB_RPCS or, with why, to DESTRUCTIVE_HUB_EXEMPT");
    for (const m of DESTRUCTIVE_HUB_RPCS) assert.ok(m in WEB_RPC, `${m} is no hub RPC`);
  });

  // Spec 79a: the incident's machine token is an owner's, yet it acts as a member, so projects.delete is not within
  // its reach at all: refused outright, no proposal for a person to approve by mistake.
  it("refuses an agent's projects.delete on an admin's machine token, with no proposal", async () => {
    const before = hive.db.prepare("SELECT COUNT(*) AS n FROM proposals").get() as { n: number };
    const refused = await agent("projects.delete", { project: "ehospital", confirm: "ehospital" });
    assert.equal(refused.status, 403);
    assert.equal((hive.db.prepare("SELECT COUNT(*) AS n FROM proposals").get() as { n: number }).n, before.n);
    const rpc = await person();
    assert.equal((await rpc("tasks.list", { project: "ehospital" })).body.result.length, 1, "nothing deleted");
  });

  it("holds an agent's docs.remove until a person approves it", async () => {
    const rpc = await person();
    assert.equal((await rpc("docs.save", { key: "project/scratch/old", content: "# old" })).status, 200);
    const held = await agent("docs.remove", { key: "project/scratch/old" });
    assert.equal(held.status, 202);
    assert.equal(held.body.error?.code, "pending_approval");
    assert.equal(held.body.error?.key, "errors.pendingApproval");
    const id = Number(held.body.error?.vars?.id);
    assert.match(held.body.error!.message, new RegExp(`đã gửi đề xuất #${id}, chờ duyệt`));
    assert.equal((await rpc("docs.get", { key: "project/scratch/old" })).status, 200, "nothing removed yet");
    const approved = await rpc("proposals.approve", { id });
    assert.equal(approved.body.result?.status, "approved", JSON.stringify(approved.body));
    const line = (await rpc("admin.audit", {})).body.result.find((a: { action: string }) => a.action === "docs.remove");
    assert.equal(line.actor, "boss");
    assert.equal(line.agent, "claude-code@hc-duytd20-macmini", "the incident's session name");
  });

  it("holds an agent's revoke of its owner's token and runs it once approved", async () => {
    const owner = users.list().find((u) => u.username === "boss")!;
    const victim = tokens.create("ci", "agent", owner.id);
    const held = await agent("tokens.revoke", { id: victim.info.id });
    assert.equal(held.status, 202);
    assert.ok(tokens.verify(victim.token), "still valid while it waits");
    const rpc = await person();
    const approved = await rpc("proposals.approve", { id: Number(held.body.error?.vars?.id) });
    assert.equal(approved.body.result?.status, "approved", JSON.stringify(approved.body));
    assert.equal(tokens.verify(victim.token), null);
    const line = (await rpc("admin.audit", {})).body.result.find((a: { action: string }) => a.action === "tokens.revoke");
    assert.equal(line.actor, "boss");
    assert.match(line.agent ?? "", /^claude-code@/);
  });

  it("refuses an agent on an admin's token the revoke of someone else's token", async () => {
    const other = tokens.create("ci-other", "agent", null);
    assert.equal((await agent("tokens.revoke", { id: other.info.id })).status, 403);
    assert.ok(tokens.verify(other.token));
  });

  it("still refuses an agent what its token may not do, before any proposal", async () => {
    const before = hive.db.prepare("SELECT COUNT(*) AS n FROM proposals").get() as { n: number };
    const viewer = tokens.create("reader", "viewer", null).token;
    const res = await fetch(`${base}/api/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(viewer), "x-hive-agent": "claude" },
      body: JSON.stringify({ method: "users.purge", input: { id: "nobody" } }),
    });
    assert.equal(res.status, 403);
    assert.equal((hive.db.prepare("SELECT COUNT(*) AS n FROM proposals").get() as { n: number }).n, before.n);
  });

  it("lets a person delete straight away", async () => {
    const rpc = await person();
    const victim = tokens.create("old-ci", "agent", null);
    assert.equal((await rpc("tokens.revoke", { id: victim.info.id })).status, 200);
    assert.equal(tokens.verify(victim.token), null);
  });
});
