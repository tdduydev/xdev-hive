import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import type { Actor } from "@xdev-hive/core";
import { SqliteHive } from "@xdev-hive/core/node";
import { createHubApp } from "#web/app.ts";
import { TokenStore } from "#web/tokens.ts";
import { UserStore } from "#web/users.ts";

let base = "";
let close: () => void;
let users: UserStore;
const token: Record<string, string> = {};
const id: Record<string, string> = {};

before(async () => {
  const hive = new SqliteHive(":memory:");
  hive.seed("hub");
  const root: Actor = { name: "duy", role: "admin" };
  await hive.call("tasks.create", { id: "app-1", project: "app", title: "Đăng nhập" }, root);
  const tokens = new TokenStore(hive.db);
  users = new UserStore(hive.db);
  // An account's machine token carries the account's grants, as a signed-in browser would.
  for (const [name, admin] of [["duy", true], ["lan", false], ["kha", false], ["minh", false], ["hoa", false]] as const) {
    const u = users.create({ username: name, admin }).user;
    id[name] = u.id;
    token[name] = tokens.create(`${name}-mbp`, admin ? "admin" : "member", u.id).token;
  }
  users.setGrants(id.lan!, { app: "lead" });
  // Manages members but holds little else: may give only that much.
  users.setGrants(id.kha!, { app: { permissions: ["view", "membersManage"] } });
  const server = createHubApp({ hive, tokens, users, allowedHosts: ["127.0.0.1", "localhost"] }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
after(() => close());

const rpc = async (who: string, method: string, input: unknown = {}) => {
  const res = await fetch(`${base}/api/rpc`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token[who]}` }, body: JSON.stringify({ method, input }) });
  return { status: res.status, body: (await res.json()) as { result?: any; error?: { key?: string } } };
};

describe("project members (roadmap 25)", () => {
  it("lets a project lead see and set roles in their project, and nobody else", async () => {
    assert.equal((await rpc("minh", "members.list", { project: "app" })).status, 404, "minh does not see app at all");
    const listed = await rpc("lan", "members.list", { project: "app" });
    assert.equal(listed.status, 200);
    const byName = Object.fromEntries((listed.body.result as Array<{ username: string; grant: unknown }>).map((m) => [m.username, m.grant]));
    assert.deepEqual([byName.lan, byName.duy, byName.minh], ["lead", "lead", null]);

    const set = await rpc("lan", "members.set", { project: "app", userId: id.minh, grant: "reviewer" });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal(set.body.result.grant, "reviewer");
    assert.equal((await rpc("minh", "tasks.list", { project: "app" })).body.result.length, 1, "minh sees app now");
    assert.equal((await rpc("minh", "members.list", { project: "app" })).body.error?.key, "errors.need.membersManage", "a reviewer does not manage members");
  });

  it("never lets anyone change their own role or an admin's", async () => {
    assert.equal((await rpc("lan", "members.set", { project: "app", userId: id.lan, grant: "viewer" })).body.error?.key, "errors.memberIsSelf");
    assert.equal((await rpc("lan", "members.set", { project: "app", userId: id.duy, grant: "viewer" })).body.error?.key, "errors.memberIsAdmin");
  });

  it("gives no more than the one giving holds, and takes away nothing they could not give", async () => {
    const above = await rpc("kha", "members.set", { project: "app", userId: id.hoa, grant: "member" });
    assert.equal(above.body.error?.key, "errors.memberAboveYou", "member holds permissions kha lacks");
    assert.equal((await rpc("kha", "members.set", { project: "app", userId: id.hoa, grant: "viewer" })).status, 200);
    assert.equal((await rpc("kha", "members.set", { project: "app", userId: id.minh, grant: null })).body.error?.key, "errors.memberAboveYou", "minh is a reviewer: more than kha holds");
    const out = await rpc("lan", "members.set", { project: "app", userId: id.hoa, grant: null });
    assert.equal(out.body.result.grant, null);
  });

  it("keeps a custom grant and the shared data's grant, and the shared data's members are its own lead's to set", async () => {
    assert.equal((await rpc("lan", "members.list", { project: null })).body.error?.key, "errors.needShared.membersManage");
    const saved = await rpc("duy", "users.setGrants", { id: id.lan, grants: { app: "lead", web: { permissions: ["docApprove", "fly"] } } });
    assert.equal(saved.body.error?.key, "errors.badGrant");
    const ok = await rpc("duy", "users.setGrants", { id: id.lan, grants: { app: "lead", web: { permissions: ["docApprove"] } }, shared: "lead" });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual([ok.body.result.grants.web, ok.body.result.shared], [{ permissions: ["view", "docApprove"] }, "lead"]);
    assert.equal(users.get(id.lan!)!.shared, "lead");
    const shared = await rpc("lan", "members.set", { project: null, userId: id.minh, grant: "reviewer" });
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    assert.equal(users.get(id.minh!)!.shared, "reviewer");
    // Every other grant stays when the admin page saves without a shared field.
    await rpc("duy", "users.setGrants", { id: id.lan, grants: { app: "lead" } });
    assert.equal(users.get(id.lan!)!.shared, "lead");
  });
});
