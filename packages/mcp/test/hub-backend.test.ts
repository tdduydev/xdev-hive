import assert from "node:assert/strict";
import { it } from "node:test";
import { mcpHubBackend } from "#mcp/hub-backend.ts";

it("exchanges once for concurrent MCP calls, refreshes before expiry, and never sends the parent to RPC", async (t) => {
  const parent = "synthetic-machine";
  let now = 1_000;
  let exchanges = 0;
  let fail = false;
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    if (url.endsWith("/api/mcp-credentials")) {
      assert.equal(headers.authorization, `Bearer ${parent}`);
      assert.deepEqual(JSON.parse(String(init.body)), { project: "app", readOnly: true });
      if (fail) return Response.json({ error: { message: "revoked" } }, { status: 401 });
      return Response.json({ result: { token: `synthetic-mcp-${++exchanges}` } });
    }
    assert.ok(url.endsWith("/api/rpc"));
    assert.equal(headers.authorization, `Bearer synthetic-mcp-${exchanges}`);
    return Response.json({ result: [] });
  });
  const backend = mcpHubBackend({ url: "https://fixture.invalid/", token: parent }, "app", true);
  const actor = { name: "agent", role: "agent" } as const;
  await Promise.all([backend.call("tasks.list", {}, actor), backend.call("docs.list", {}, actor)]);
  assert.equal(exchanges, 1);
  now += 55 * 60_000;
  await backend.call("tasks.list", {}, actor);
  assert.equal(exchanges, 2);
  now += 55 * 60_000;
  fail = true;
  await assert.rejects(backend.call("tasks.list", {}, actor), { code: "unauthorized" });
  fail = false;
  await backend.call("tasks.list", {}, actor);
  assert.equal(exchanges, 3, "a failed exchange can retry without using the parent for RPC");
});
