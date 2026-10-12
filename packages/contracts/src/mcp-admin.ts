import { z } from "zod";
import { id, orgRoute } from "./common.ts";

export const mcpToolOutput = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  group: z.enum(["knowledge", "tasks", "runs", "tenancy", "leader"]),
  caller: z.enum(["runs", "users", "both"]),
  enabled: z.boolean(),
  calls: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
});
export const mcpTokenOutput = z.object({
  id,
  userId: z.string(),
  ownerName: z.string().nullable(),
  prefix: z.string(),
  clientId: z.string(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
});
export const mcpTokenLifetime = z.number().int().min(1).max(90);
export const createMcpTokenInput = z.object({
  clientId: z.string().trim().min(1).max(100),
  lifetimeDays: mcpTokenLifetime,
});
export type McpAdminTool = z.output<typeof mcpToolOutput>;
export type McpUserToken = z.output<typeof mcpTokenOutput>;

export const mcpAdminContract = {
  listTools: orgRoute("GET", "/v1/mcp/admin/tools", "Danh sách tool MCP và lượt gọi 7 ngày", "mcp").output(
    z.object({ tools: z.array(mcpToolOutput) }),
  ),
  setTool: orgRoute("PATCH", "/v1/mcp/admin/tools/{toolName}", "Bật/tắt tool MCP (quản trị)", "mcp")
    .input(z.object({ toolName: z.string().min(1).max(100), enabled: z.boolean() }))
    .output(z.object({ enabled: z.boolean() })),
  listTokens: orgRoute("GET", "/v1/mcp/admin/tokens", "Token của mình; quản trị xem toàn tổ chức", "mcp").output(
    z.object({ tokens: z.array(mcpTokenOutput) }),
  ),
  createToken: orgRoute("POST", "/v1/mcp/admin/tokens", "Tạo token MCP, chỉ trả bản rõ một lần", "mcp")
    .input(createMcpTokenInput)
    .output(z.object({ token: z.string(), info: mcpTokenOutput })),
  extendToken: orgRoute("POST", "/v1/mcp/admin/tokens/{id}/extend", "Đặt hạn token từ hôm nay (quản trị)", "mcp")
    .input(z.object({ id, lifetimeDays: mcpTokenLifetime }))
    .output(mcpTokenOutput),
  revokeToken: orgRoute("POST", "/v1/mcp/admin/tokens/{id}/revoke", "Thu hồi token MCP", "mcp")
    .input(z.object({ id }))
    .output(z.object({ revoked: z.literal(true) })),
};
