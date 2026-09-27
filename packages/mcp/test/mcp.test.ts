import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SqliteHive } from "@xdev-hive/core/node";
import { createHiveMcpServer } from "../src/index.ts";

async function connect(hive: SqliteHive, name = "claude@duy") {
  const server = createHiveMcpServer(hive, { name, role: "agent" }, { defaultProject: "app" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  return client;
}

const text = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as Array<{ text: string }>)[0]!.text;

describe("mcp tools", () => {
  it("exposes the agent tool set", async () => {
    const client = await connect(new SqliteHive(":memory:"));
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "doc_get",
      "doc_list",
      "doc_propose",
      "memory_search",
      "memory_write",
      "task_claim",
      "task_list",
      "task_update",
    ]);
  });

  it("shares memory between two agents", async () => {
    const hive = new SqliteHive(":memory:");
    const claude = await connect(hive, "claude@duy");
    const codex = await connect(hive, "codex@duy");
    await claude.callTool({ name: "memory_write", arguments: { kind: "decision", content: "API dùng tRPC" } });
    const res = await codex.callTool({ name: "memory_search", arguments: { query: "trpc" } });
    const hits = JSON.parse(text(res));
    assert.equal(hits[0].author, "claude@duy");
  });

  it("lets agents propose but not overwrite docs", async () => {
    const hive = new SqliteHive(":memory:");
    hive.seed();
    const client = await connect(hive);
    const doc = JSON.parse(text(await client.callTool({ name: "doc_get", arguments: { key: "org/agent-protocol" } })));
    const res = await client.callTool({
      name: "doc_propose",
      arguments: { key: doc.key, baseVersion: doc.version, content: `${doc.content}\n7. Test trước khi review.`, reason: "add rule 7" },
    });
    assert.equal(res.isError, undefined);
    assert.equal(JSON.parse(text(res)).status, "pending");

    const stale = await client.callTool({
      name: "doc_propose",
      arguments: { key: doc.key, baseVersion: 0, content: "x", reason: "stale" },
    });
    assert.equal(stale.isError, true);
    assert.match(text(stale), /^conflict:/);
  });
});
