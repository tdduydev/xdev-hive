import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { HiveError, HubBackend } from "@xdev-hive/core";
import { SqliteHive } from "@xdev-hive/core/node";
import { createHubApp } from "../src/app.ts";
import { TokenStore } from "../src/tokens.ts";

let base = "";
let close: () => void;
const tok: Record<"admin" | "agent" | "viewer", string> = { admin: "", agent: "", viewer: "" };

before(async () => {
  const hive = new SqliteHive(":memory:", { memoryRequiresApproval: true });
  hive.seed();
  const tokens = new TokenStore(hive.db);
  tok.admin = tokens.create("duy", "admin").token;
  tok.agent = tokens.create("duy-macbook", "agent").token;
  tok.viewer = tokens.create("pm", "viewer").token;
  const app = createHubApp({ hive, tokens, allowedHosts: ["127.0.0.1", "localhost"] });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
after(() => close());

async function rpc(token: string | null, method: string, input?: unknown, agent?: string) {
  const res = await fetch(`${base}/api/rpc`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(agent ? { "x-hive-agent": agent } : {}),
    },
    body: JSON.stringify({ method, input }),
  });
  return { status: res.status, body: (await res.json()) as { result?: any; error?: { code: string } } };
}

describe("hub REST", () => {
  it("rejects missing or unknown tokens and foreign Host headers", async () => {
    assert.equal((await rpc(null, "docs.list")).status, 401);
    assert.equal((await rpc("hive_nope", "docs.list")).status, 401);
    // fetch() refuses to set Host, so use node:http to simulate a DNS-rebinding request.
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${base}/api/health`, { headers: { host: "evil.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, 403);
  });

  it("labels the actor with the agent name and token name", async () => {
    const res = await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${tok.agent}`, "x-hive-agent": "codex" } });
    const body = (await res.json()) as { result: { name: string; role: string } };
    assert.deepEqual(body.result, { name: "codex@duy-macbook", role: "agent", mode: "hub" });
  });

  it("applies roles: viewer reads, agent proposes, admin approves", async () => {
    assert.equal((await rpc(tok.viewer, "docs.list")).status, 200);
    assert.equal((await rpc(tok.viewer, "memory.write", { project: "app", kind: "gotcha", content: "x" })).status, 403);
    assert.equal((await rpc(tok.agent, "docs.save", { key: "org/x", content: "x" })).status, 403);

    const doc = (await rpc(tok.agent, "docs.get", { key: "org/agent-protocol" })).body.result;
    const proposal = await rpc(tok.agent, "proposals.create", {
      docKey: doc.key,
      baseVersion: doc.version,
      content: `${doc.content}\n7. Chạy test trước khi review.`,
      reason: "thêm quy tắc 7",
    }, "claude");
    assert.equal(proposal.status, 200);
    assert.equal(proposal.body.result.author, "claude@duy-macbook");
    assert.equal((await rpc(tok.agent, "proposals.approve", { id: proposal.body.result.id })).status, 403);
    const approved = await rpc(tok.admin, "proposals.approve", { id: proposal.body.result.id });
    assert.equal(approved.body.result.status, "approved");
  });

  it("validates input and reports conflicts with HTTP status codes", async () => {
    assert.equal((await rpc(tok.admin, "docs.save", { key: "org/x" })).status, 400);
    assert.equal((await rpc(tok.admin, "nope.method")).status, 400);
    await rpc(tok.admin, "docs.save", { key: "org/y", content: "1" });
    assert.equal((await rpc(tok.admin, "docs.save", { key: "org/y", content: "2", baseVersion: 0 })).status, 409);
  });

  it("manages tokens for admins only", async () => {
    assert.equal((await rpc(tok.agent, "tokens.list")).status, 403);
    const created = await rpc(tok.admin, "tokens.create", { name: "ci-gitlab", role: "agent" });
    assert.match(created.body.result.token, /^hive_/);
    assert.equal((await rpc(created.body.result.token, "docs.list")).status, 200);
    await rpc(tok.admin, "tokens.revoke", { id: created.body.result.info.id });
    assert.equal((await rpc(created.body.result.token, "docs.list")).status, 401);
  });
});

describe("hub as a backend", () => {
  it("serves the desktop/stdio HubBackend with the same errors as local mode", async () => {
    const hub = new HubBackend(base, tok.agent);
    const me = { name: "gemini", role: "agent" as const };
    const m = await hub.call("memory.write", { project: "app", kind: "convention", content: "Dùng zod ở biên API" }, me);
    assert.equal(m.author, "gemini@duy-macbook");
    assert.equal(m.status, "pending", "hub requires approval for agent memory");
    await assert.rejects(
      hub.call("docs.save", { key: "org/z", content: "x" }, me),
      (e: unknown) => e instanceof HiveError && e.code === "forbidden",
    );
  });

  it("speaks MCP over Streamable HTTP", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${tok.agent}`, "x-hive-agent": "cursor" } },
    });
    const client = new Client({ name: "test", version: "0" });
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((t) => t.name === "memory_search"));
    const res = await client.callTool({ name: "task_list", arguments: { project: "app" } });
    assert.equal(res.isError, undefined);
    await client.close();
  });
});
