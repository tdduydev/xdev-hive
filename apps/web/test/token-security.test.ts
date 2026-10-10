import assert from "node:assert/strict";
import { it } from "node:test";
import type { Request, Response, RequestHandler } from "express";
import { SqliteHive } from "@xdev-hive/core/node";
import { createHubApp } from "#web/app.ts";
import { TokenStore } from "#web/tokens.ts";
import { UserStore } from "#web/users.ts";

it("a viewer credential cannot mint an agent token with its owner's write grants", async () => {
  const hive = new SqliteHive(":memory:");
  const tokens = new TokenStore(hive.db);
  const users = new UserStore(hive.db);
  const user = users.create({ username: "audit-owner" }).user;
  users.setGrants(user.id, { app: "lead" });
  const viewer = tokens.create("audit-viewer", "viewer", user.id).token;
  const memberCreated = tokens.create("audit-device", "member", user.id);
  const member = memberCreated.token;
  const app = createHubApp({ hive, tokens, users });
  // Run the real Bearer auth and RPC handlers locally; no socket or external hub.
  const router = (app as unknown as { router: { stack: Array<{ route?: { path: string; stack: Array<{ handle: RequestHandler }> } }> } }).router;
  const route = router.stack.find((layer) => layer.route?.path === "/api/rpc")!.route!;
  const rpc = async (credential: string, method: string, input: unknown) => {
    const req = { method: "POST", body: { method, input }, get: (key: string) => key === "authorization" ? `Bearer ${credential}` : undefined };
    let status = 200, body: any, authenticated = false;
    const res = { locals: {}, status: (n: number) => { status = n; return res; }, json: (v: unknown) => { body = v; return res; } };
    route.stack[0]!.handle(req as Request, res as unknown as Response, () => { authenticated = true; });
    assert.equal(authenticated, true);
    await route.stack.at(-1)!.handle(req as Request, res as unknown as Response, () => {});
    return { status, body };
  };
  try {
    assert.equal((await rpc(viewer, "memory.write", { project: "app", kind: "context", content: "sentinel" })).status, 403);
    const before = tokens.count();
    for (const role of ["agent", "member", "admin"]) assert.equal((await rpc(viewer, "tokens.create", { name: "audit-child", role })).status, 403);
    assert.equal(tokens.count(), before, "refused minting does not persist a credential");
    assert.equal((await rpc(viewer, "tokens.create", { name: "audit-read-child", role: "viewer" })).status, 403);
    assert.equal((await rpc(member, "tokens.create", { name: "audit-agent-child", role: "agent" })).status, 200);
    assert.equal((await rpc(member, "tokens.create", { name: "audit-admin-child", role: "admin" })).status, 403);
    assert.equal((await rpc(viewer, "tokens.revoke", { id: memberCreated.info.id })).status, 403);
    assert.ok(tokens.verify(member), "a viewer cannot revoke the machine's write credential");
  } finally { hive.close(); }
});
