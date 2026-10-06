import assert from "node:assert/strict";
import { it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMemoryCleanupMcpServer } from "#mcp/memory-cleanup.ts";
import { SqliteHive } from "@xdev-hive/core/node";
import type { Actor } from "@xdev-hive/core";

it("the cleanup AI's MCP exposes only paginated project memory and rejects other tools", async () => {
  const hive = new SqliteHive(":memory:");
  const admin: Actor = { name: "admin", role: "admin" };
  const machine: Actor = { name: "runner.mac@mac", role: "agent" };
  await hive.call("machines.heartbeat", { machine: "mac", instance: "aaaaaaaa", projects: ["app"], acceptsRuns: true }, machine);
  await hive.call("memory.write", { project: "app", kind: "decision", content: "Only app data" }, admin);
  await hive.call("memory.write", { project: "hidden", kind: "decision", content: "Hidden data" }, admin);
  await hive.call("memory.setCleanup", { project: "app", enabled: true }, admin);
  hive.queueMemoryCleanup();
  const job = (await hive.call("memory.cleanupTake", { projects: ["app"] }, machine))!;
  const server = createMemoryCleanupMcpServer(hive, machine, job.id);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "review-test", version: "1" });
  try {
    await client.connect(b);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((t) => t.name), ["memory_list"]);
    const read = await client.callTool({ name: "memory_list", arguments: { offset: 0, project: "hidden" } });
    assert.ok(JSON.stringify(read).includes("Only app data"));
    assert.ok(!JSON.stringify(read).includes("Hidden data"));
    const denied = await client.callTool({ name: "memory_remove", arguments: { id: 1 } });
    assert.equal(denied.isError, true);
    assert.equal((await hive.call("memory.list", { project: "app" }, admin)).length, 1);
  } finally { await client.close(); await server.close(); hive.close(); }
});
