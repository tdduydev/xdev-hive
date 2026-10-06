import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Actor, HiveBackend } from "@xdev-hive/core";

export function createMemoryCleanupMcpServer(backend: HiveBackend, actor: Actor, id: number): McpServer {
  const server = new McpServer({ name: "memory-review", version: "1.0.0" });
  server.registerTool("memory_list", {
    description: "Read only this project's memory snapshot, including stale facts. Start at offset 0 and use next until null.",
    inputSchema: { offset: z.number().int().min(0).default(0) },
    annotations: { readOnlyHint: true },
  }, async ({ offset }) => {
    const result = await backend.call("memory.cleanupRead", { id, offset }, actor);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  });
  return server;
}

/** A single-use local bridge: no hub token in the AI process, no project or write parameters. */
export async function memoryCleanupMcp(backend: HiveBackend, actor: Actor, id: number): Promise<{ url: string; token: string; close: () => Promise<void> }> {
  const token = randomBytes(32).toString("hex");
  const active = new Set<StreamableHTTPServerTransport>();
  const http = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/mcp" || req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(403); res.end(); return;
    }
    const server = createMemoryCleanupMcpServer(backend, actor, id);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    active.add(transport);
    res.on("close", () => { active.delete(transport); void transport.close(); void server.close(); });
    try {
      let raw = "";
      for await (const chunk of req) {
        raw += chunk.toString();
        if (raw.length > 32_000) throw new Error("Request too large");
      }
      await server.connect(transport);
      await transport.handleRequest(req, res, JSON.parse(raw));
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(0, "127.0.0.1", resolve); });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("No MCP address");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`, token,
    close: async () => {
      await Promise.all([...active].map((t) => t.close()));
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
