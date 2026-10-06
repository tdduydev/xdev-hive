import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { HiveError, HubBackend, transferHive } from "@xdev-hive/core";
import { SqliteHive } from "@xdev-hive/core/node";
import { createHubApp } from "#web/app.ts";
import { TokenStore } from "#web/tokens.ts";
import { UserStore } from "#web/users.ts";

const testTmpDirs = new Set<string>();
function testTmpDir(prefix: string): string {
  const dir = mkdtempSync(prefix);
  testTmpDirs.add(dir);
  return dir;
}

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
  const app = createHubApp({ hive, tokens, users: new UserStore(hive.db), allowedHosts: ["127.0.0.1", "localhost"] });
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

  it("logs an agent's writes with its label, its token's owner and the run from x-hive-run (roadmap 27c)", async () => {
    const write = (headers: Record<string, string>, content: string) =>
      fetch(`${base}/api/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${tok.agent}`, ...headers },
        body: JSON.stringify({ method: "memory.write", input: { project: "audit27c", kind: "gotcha", content } }),
      });
    const source = JSON.stringify({ via: "mcp", machine: "duy-mbp", run: "R-src001", task: "T-1" });
    assert.equal((await write({ "x-hive-agent": "claude-1.duy-mbp", "x-hive-source": source, "x-hive-run": "R-hdr001" }, "từ shim")).status, 200);
    // A client that only sends the source (Gemini in a container) still gets its run logged.
    assert.equal((await write({ "x-hive-agent": "gemini-1.duy-mbp", "x-hive-source": source }, "từ container")).status, 200);
    assert.equal((await write({ "x-hive-agent": "codex-1.duy-mbp", "x-hive-run": "not a run id!" }, "run sai dạng")).status, 200);

    const rows = (await rpc(tok.admin, "admin.audit", { action: "memory.write" })).body.result as Array<{ agent: string; onBehalf: string; run: string | null }>;
    assert.deepEqual(
      rows.slice(0, 3).map((e) => [e.agent, e.onBehalf, e.run]),
      [
        ["codex-1.duy-mbp", "duy-macbook", null],
        ["gemini-1.duy-mbp", "duy-macbook", "R-src001"],
        ["claude-1.duy-mbp", "duy-macbook", "R-hdr001"],
      ],
      "a token of no account stands for itself",
    );
    assert.equal((await rpc(tok.admin, "admin.audit", { run: "R-hdr001" })).body.result.length, 1);
  });

  it("keeps the machine part of long agent labels, so two machines on one token get different leases", async () => {
    const label = `${"p".repeat(40)}.${"m".repeat(24)}`;
    const res = await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${tok.agent}`, "x-hive-agent": label } });
    assert.equal(((await res.json()) as { result: { name: string } }).result.name, `${label}@duy-macbook`);
  });

  it("keys machine heartbeats by runner label and token, readable by viewers", async () => {
    const beat = { machine: "duy-mbp", instance: "0123abcd", version: "0.1.0" };
    assert.equal((await rpc(tok.viewer, "machines.heartbeat", beat, "runner.pm")).status, 403);
    assert.equal((await rpc(tok.agent, "machines.heartbeat", beat, "runner.duy-mbp")).status, 200);
    const list = await rpc(tok.viewer, "machines.list", {});
    assert.deepEqual(list.body.result.map((m: { id: string; online: boolean }) => [m.id, m.online]), [["runner.duy-mbp@duy-macbook", true]]);
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
    const log = (await rpc(tok.admin, "admin.audit", { action: "tokens.revoke" })).body.result as Array<{ actor: string; target: string; detail: string }>;
    assert.deepEqual(log.map((e) => [e.actor, e.target, e.detail]), [["duy", "ci-gitlab", "agent"]], "token changes are in the audit log");
    assert.equal((await rpc(tok.agent, "admin.audit", {})).status, 403);
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

  it("pushes a machine's local data to the hub over HTTP and pulls it onto another machine", async () => {
    const local = new SqliteHive(":memory:");
    const me = { name: "duy", role: "admin" as const };
    await local.call("docs.save", { key: "project/transfer/agents", content: "Dùng pnpm" }, me);
    await local.call("tasks.create", { id: "TR-1", project: "transfer", title: "Chuyển dữ liệu" }, me);
    const hub = { backend: new HubBackend(base, tok.admin), actor: { name: "hive-transfer", role: "admin" as const }, label: "hub" };
    const push = await transferHive({ backend: local, actor: me, label: "máy A" }, hub);
    assert.equal(push.counts.failed, 0, JSON.stringify(push.items));
    assert.equal(push.items.find((i) => i.key === "project/transfer/agents")?.result, "added");
    assert.equal((await rpc(tok.viewer, "docs.get", { key: "project/transfer/agents" })).body.result.updatedBy, "hive-transfer@duy", "written under the transfer label");

    const other = new SqliteHive(":memory:");
    const pull = await transferHive(hub, { backend: other, actor: me, label: "máy B" }, { newVersions: true });
    assert.equal(pull.counts.failed, 0, JSON.stringify(pull.items));
    assert.equal((await other.call("tasks.list", { project: "transfer" }, me))[0]?.title, "Chuyển dữ liệu");
  });

  it("records where each write came from, and decides the channel itself", async () => {
    const source = { via: "mcp" as const, machine: "duy-mbp", run: "R-1fa9e2", task: "T-9" };
    const hub = new HubBackend(base, tok.agent);
    const m = await hub.call("memory.write", { project: "app", kind: "gotcha", content: "Seed data lives in db/seed" }, { name: "claude-1.duy-mbp", role: "agent", source });
    assert.deepEqual(m.source, source);
    assert.equal(m.taskId, "T-9");

    const res = await fetch(`${base}/api/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tok.agent}`, "x-hive-source": JSON.stringify({ via: "web", machine: "duy-mbp" }) },
      body: JSON.stringify({ method: "memory.write", input: { project: "app", kind: "context", content: "Claims to be the web page" } }),
    });
    assert.deepEqual(((await res.json()) as { result: { source: unknown } }).result.source, { via: "api", machine: "duy-mbp" });

    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${tok.agent}`, "x-hive-agent": "cursor", "x-hive-source": JSON.stringify({ via: "desktop", machine: "lan-pc" }) } },
    });
    const client = new Client({ name: "test", version: "0" });
    await client.connect(transport);
    const out = await client.callTool({ name: "memory_write", arguments: { project: "app", kind: "context", content: "Written over MCP HTTP" } });
    await client.close();
    const written = JSON.parse((out.content as Array<{ text: string }>)[0]!.text) as { source: unknown };
    assert.deepEqual(written.source, { via: "mcp", machine: "lan-pc" });
  });

  it("gives a viewer token the read-only MCP tools", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tok.viewer}` } } });
    const client = new Client({ name: "test", version: "0" });
    await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name).sort(), [
      "artifact_get",
      "artifact_list",
      "cost_summary",
      "doc_asset",
      "doc_get",
      "doc_list",
      "machine_list",
      "memory_search",
      "policy_get",
      "run_get",
      "run_list",
      "run_requests",
      "setup_missing",
      "skill_get",
      "skill_list",
      "task_get",
      "task_list",
      "task_next",
      "task_notes",
      "token_usage",
      "tool_list",
      "tool_status",
    ]);
    await client.close();
  });

  it("lets a client narrow MCP to read-only and give a default project (container runs)", async () => {
    const connect = async (headers: Record<string, string>) => {
      const client = new Client({ name: "test", version: "0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tok.agent}`, ...headers } } }));
      return client;
    };
    const ro = await connect({ "x-hive-readonly": "1", "x-hive-project": "app" });
    assert.deepEqual((await ro.listTools()).tools.map((t) => t.name).sort(), [
      "artifact_get",
      "artifact_list",
      "cost_summary",
      "doc_asset",
      "doc_get",
      "doc_list",
      "machine_list",
      "memory_search",
      "policy_get",
      "run_get",
      "run_list",
      "run_requests",
      "setup_missing",
      "skill_get",
      "skill_list",
      "task_get",
      "task_list",
      "task_next",
      "task_notes",
      "token_usage",
      "tool_list",
      "tool_status",
    ]);
    const listed = await ro.callTool({ name: "task_list", arguments: {} });
    assert.equal(listed.isError, undefined, "the default project stands in for the missing argument");
    await ro.close();
    const bad = await connect({ "x-hive-project": "../x", "x-hive-readonly": "0" });
    assert.ok((await bad.listTools()).tools.some((t) => t.name === "memory_write"), "0 or another value does not widen or narrow anything");
    await bad.close();
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

describe("hub UI", () => {
  it("serves the SPA from an install path with a dot directory (~/.local, .claude/worktrees…)", async () => {
    const dir = path.join(testTmpDir(path.join(os.tmpdir(), "hive-ui-")), ".local", "client");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>xDev Hive</title>");
    const hive = new SqliteHive(":memory:");
    const server = createHubApp({ hive, tokens: new TokenStore(hive.db), users: new UserStore(hive.db), ui: { dir } }).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      for (const route of ["/", "/docs"]) {
        const res = await fetch(`${url}${route}`);
        assert.equal(res.status, 200, route);
        assert.match(await res.text(), /<title>xDev Hive<\/title>/);
      }
    } finally {
      server.close();
      hive.close();
    }
  });
});

after(() => {
  for (const dir of testTmpDirs) rmSync(dir, { recursive: true, force: true });
});
