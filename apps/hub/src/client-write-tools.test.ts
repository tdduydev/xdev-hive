import { CLIENT_WRITE_TOOLS } from "@xdev-hive/contracts";
import { describe, expect, it } from "vitest";
import { registerMcpTools as artifactsMcpTools } from "./modules/artifacts/index.ts";
import { registerMcpTools as catalogMcpTools } from "./modules/catalog/index.ts";
import { registerMcpTools as docsyncMcpTools } from "./modules/docsync/index.ts";
import { registerMcpTools as knowledgeMcpTools } from "./modules/knowledge/index.ts";
import { registerMcpTools as leaderMcpTools } from "./modules/leader/index.ts";
import { McpToolRegistry } from "./modules/mcp/index.ts";
import { registerMcpTools as runsMcpTools } from "./modules/runs/index.ts";
import { registerMcpTools as sdlcMcpTools } from "./modules/sdlc/index.ts";
import { registerMcpTools as tenancyMcpTools } from "./modules/tenancy/index.ts";

// Cùng danh sách đăng ký với app.ts. Hộp thư đi trên máy chỉ biết tool qua CLIENT_WRITE_TOOLS (fixture cho Go), nên
// tool ghi mà thiếu ở bảng sẽ bị gửi thẳng khi hub vắng và mất lần ghi. Không suy từ `readOnly`: cờ đó là gợi ý cho chế
// độ plan của Claude, và plan_submit hay review_submit vẫn ghi dữ liệu hub.
function allTools() {
  const registry = new McpToolRegistry();
  tenancyMcpTools(registry);
  runsMcpTools(registry);
  knowledgeMcpTools(registry);
  catalogMcpTools(registry);
  leaderMcpTools(registry);
  artifactsMcpTools(registry);
  sdlcMcpTools(registry);
  docsyncMcpTools(registry);
  return registry.list();
}

describe("tool MCP có ghi", () => {
  it("cờ writes khớp đúng bảng CLIENT_WRITE_TOOLS", () => {
    const tools = allTools();
    const writes = tools.filter((tool) => tool.writes).map((tool) => tool.name);
    expect(writes.sort()).toEqual(Object.keys(CLIENT_WRITE_TOOLS).sort());
  });
});
