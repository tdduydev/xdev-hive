import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { TRASH_DAYS, type Actor } from "@xdev-hive/core";
import { SqliteHive } from "@xdev-hive/core/node";
import { DatabaseSync } from "node:sqlite";
import { createHubApp } from "#web/app.ts";
import { TokenStore } from "#web/tokens.ts";
import { LoginThrottle, UserStore } from "#web/users.ts";

let base = "";
let close: () => void;
let users: UserStore;
let hive: SqliteHive;
const temp: Record<string, string> = {};

before(async () => {
  hive = new SqliteHive(":memory:");
  hive.seed("hub");
  const root: Actor = { name: "duy", role: "admin" };
  await hive.call("tasks.create", { id: "app-1", project: "app", title: "app task" }, root);
  const tokens = new TokenStore(hive.db);
  users = new UserStore(hive.db);
  // Signing in with a temporary password only gets as far as the password change; these start settled.
  for (const [name, role] of [["boss", "owner"], ["ann", "admin"]] as const) {
    const made = users.create({ username: name, hubRole: role });
    users.changePassword(made.user.id, made.password, `pw-${name.length}-Zq83kd2`);
    temp[name] = `pw-${name.length}-Zq83kd2`;
  }
  temp.vic = users.create({ username: "vic", hubRole: "viewer" }).password;
  users.setGrants(users.byUsername("vic")!.id, { app: "lead" });
  const app = createHubApp({ hive, tokens, users, allowedHosts: ["127.0.0.1", "localhost"], throttle: new LoginThrottle(8, 60_000) });
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
  // The temporary password must change at first sign-in; the rest of the test does not care.
  return b;
}

describe("hub roles", () => {
  it("map onto the admin flag, and the oldest admin of an old hub becomes owner", () => {
    assert.deepEqual(["boss", "ann", "vic"].map((u) => users.byUsername(u)!.admin), [true, true, false]);
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE hub_users(id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
      admin INTEGER NOT NULL DEFAULT 0, disabled INTEGER NOT NULL DEFAULT 0, must_change INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, last_login_at TEXT);
      INSERT INTO hub_users(id, username, display_name, password_hash, admin, created_at) VALUES ('1','old','Old','x',1,'2025-01-01'),('2','newer','N','x',1,'2026-01-01'),('3','m','M','x',0,'2026-01-01')`);
    const old = new UserStore(db);
    assert.deepEqual(old.list().map((u) => [u.username, u.hubRole]), [["m", "member"], ["newer", "admin"], ["old", "owner"]]);
  });

  it("a viewer account is capped to reading even where its grant says lead", async () => {
    const vic = users.byUsername("vic")!;
    users.update(vic.id, {});
    const b = browser();
    users.changePassword(vic.id, temp.vic!, "pw-viewer-Zq83kd2");
    await b.send("/api/login", { username: "vic", password: "pw-viewer-Zq83kd2" });
    const me = await b.send("/api/me");
    assert.equal(me.body.result.role, "viewer");
    const write = await b.rpc("tasks.create", { id: "app-2", project: "app", title: "x" });
    assert.notEqual(write.status, 200);
  });

  it("only an owner hands out or touches owner; an admin cannot", async () => {
        const b = await signedIn("ann", temp.ann!);
    const boss = users.byUsername("boss")!;
    assert.equal((await b.rpc("users.update", { id: boss.id, disabled: true })).body.error?.key, "errors.ownerOnly");
    assert.equal((await b.rpc("users.create", { username: "zed", hubRole: "owner" })).body.error?.key, "errors.ownerOnly");
    assert.equal((await b.rpc("users.create", { username: "zed", hubRole: "member" })).status, 200);
  });

  it("the last owner cannot be demoted, disabled or trashed", () => {
    const boss = users.byUsername("boss")!;
    assert.throws(() => users.update(boss.id, { hubRole: "admin" }), /chủ hub/);
    assert.throws(() => users.update(boss.id, { disabled: true }), /chủ hub/);
    assert.throws(() => users.trash(boss.id), /chủ hub/);
  });
});

describe("trash", () => {
  it("soft deletes, signs out, restores, and purges after the retention", () => {
    const { user } = users.create({ username: "tmp1" });
    const t = users.startSession(user.id);
    assert.ok(users.sessionUser(t.token));
    const trashed = users.trash(user.id);
    assert.ok(trashed.deletedAt && trashed.disabled && trashed.purgeAt);
    assert.equal(users.sessionUser(t.token), null);
    assert.throws(() => users.update(user.id, { displayName: "x" }), /thùng rác/);
    assert.throws(() => users.create({ username: "tmp1" }), /Đã có/);
    const back = users.restore(user.id);
    assert.equal(back.deletedAt, null);
    assert.equal(back.disabled, false);
    users.trash(user.id);
    assert.equal(users.purgeTrash(Date.now() + (TRASH_DAYS - 1) * 86_400_000), 0);
    assert.equal(users.purgeTrash(Date.now() + (TRASH_DAYS + 1) * 86_400_000), 1);
    assert.equal(users.get(user.id), null);
  });

  it("purge by hand only works on the trash, and takes the grants and tokens with it", () => {
    const { user } = users.create({ username: "tmp2" });
    users.setGrants(user.id, { app: "member" });
    assert.throws(() => users.purge(user.id), /thùng rác/);
    users.trash(user.id);
    users.purge(user.id);
    assert.equal(users.get(user.id), null);
    assert.equal(users.create({ username: "tmp2" }).user.grants.app, undefined);
  });

  it("over rpc: admins only, never oneself", async () => {
    const boss = await signedIn("boss", temp.boss!);
    const { user } = users.create({ username: "tmp3" });
    assert.equal((await boss.rpc("users.trash", { id: users.byUsername("boss")!.id })).body.error?.key, "errors.trashSelf");
    assert.equal((await boss.rpc("users.trash", { id: user.id })).body.result.deletedAt !== null, true);
    assert.equal((await boss.rpc("users.restore", { id: user.id })).body.result.deletedAt, null);
    const vic = browser();
    await vic.send("/api/login", { username: "vic", password: "pw-viewer-Zq83kd2" });
    assert.equal((await vic.rpc("users.trash", { id: user.id })).status, 403);
  });
});

describe("invite links", () => {
  it("make a one-use account with the role of the link, then stop working", async () => {
    const owner = await signedIn("boss", temp.boss!);
    const made = (await owner.rpc("users.inviteCreate", { hubRole: "viewer", days: 3 })).body.result as { token: string; invite: { id: string; role: string; state: string } };
    assert.equal(made.invite.state, "pending");
    const guest = browser();
    assert.equal((await guest.send("/api/invite/peek", { token: made.token })).body.result.role, "viewer");
    const bad = await guest.send("/api/invite/accept", { token: made.token, username: "newbie", password: "short" });
    assert.equal(bad.status, 400);
    const ok = await guest.send("/api/invite/accept", { token: made.token, username: "newbie", displayName: "New Bie", password: "a-good-password" });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.result.role, "viewer");
    assert.equal(users.byUsername("newbie")!.hubRole, "viewer");
    assert.equal(users.byUsername("newbie")!.mustChangePassword, false);
    assert.equal((await browser().send("/api/invite/accept", { token: made.token, username: "again", password: "a-good-password" })).status, 404);
    assert.equal(users.listInvites().find((i) => i.id === made.invite.id)!.state, "used");
  });

  it("expire, can be revoked, and an admin cannot make an owner link", async () => {
    const owner = await signedIn("boss", temp.boss!);
    const made = (await owner.rpc("users.inviteCreate", { hubRole: "member" })).body.result as { token: string; invite: { id: string } };
    await owner.rpc("users.inviteRevoke", { inviteId: made.invite.id });
    assert.equal((await browser().send("/api/invite/peek", { token: made.token })).status, 404);
    const expired = users.createInvite({ role: "member", days: 1, createdBy: "boss" });
    // Reaching into the table is the only way to age a link without waiting a day.
    (hive.db as DatabaseSync).prepare("UPDATE hub_invites SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(expired.invite.id);
    assert.equal(users.listInvites().find((i) => i.id === expired.invite.id)!.state, "expired");
    assert.equal((await browser().send("/api/invite/accept", { token: expired.token, username: "late", password: "a-good-password" })).status, 404);
    const ann = await signedIn("ann", temp.ann!);
    assert.equal((await ann.rpc("users.inviteCreate", { hubRole: "owner" })).body.error?.key, "errors.ownerOnly");
  });

  it("a resent link sets the password of the invited account and keeps its role", async () => {
    const { user } = users.create({ username: "waiting", hubRole: "member" });
    assert.equal(user.invited, true);
    const made = users.createInvite({ role: "owner", userId: user.id, createdBy: "boss" });
    assert.equal(made.invite.role, "member");
    assert.equal(made.invite.username, "waiting");
    const b = browser();
    const r = await b.send("/api/invite/accept", { token: made.token, password: "brand-new-password" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.result.user.username, "waiting");
    assert.equal(users.get(user.id)!.invited, false);
  });

  it("guesses are throttled", async () => {
    const b = browser();
    // The address already spent some misses in the tests above; what matters is that it ends in a lock, not a 404 forever.
    const seen: number[] = [];
    for (let n = 0; n < 10; n++) seen.push((await b.send("/api/invite/peek", { token: `hi_wrong${n}` })).status);
    assert.equal(seen.at(-1), 403);
    assert.equal(seen[0] === 404 || seen[0] === 403, true);
  });
});
