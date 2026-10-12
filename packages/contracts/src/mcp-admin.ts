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

// ---- MCP server ngoài (MCP-05, MCP-06) ----

/** Tên server trong cấu hình CLI (`mcpServers.<tên>` của Claude Code, `mcp_servers.<tên>` của Codex). */
export const mcpServerKeyPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Tên worker dành cho cổng MCP của chính hub; server ngoài trùng tên sẽ đè mất cổng đó trong cấu hình CLI. */
export const RESERVED_MCP_SERVER_KEYS: readonly string[] = ["xdev-hive", "xdev-hive-run"];

/**
 * Tên server trong cấu hình CLI suy từ tên hiển thị ("GitHub" → "github"), để người quản trị chỉ nhập một tên mà
 * TOML của Codex vẫn nhận làm khoá trần.
 */
export function mcpServerKey(name: string): string {
  const key = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 64)
    .replace(/[-_]+$/g, "");
  return key || "server";
}

export const mcpServerRuleEffect = z.enum(["allow", "deny"]);
export const mcpServerMatchType = z.enum(["name", "url", "command", "wildcard"]);
// Claude Code thay ${BIẾN} trong cấu hình MCP bằng biến môi trường của chính nó, gồm cả run token của hub.
const noEnvExpansion = [
  (value: string) => !value.includes("${"),
  `Không dùng biến môi trường dạng \${…} trong cấu hình server.`,
] as const;
/** Cách worker khởi chạy server: tiến trình stdio trên máy chạy run, hoặc server HTTP có sẵn. */
export const mcpServerLaunch = z.discriminatedUnion("transport", [
  z.object({
    transport: z.literal("stdio"),
    command: z
      .string()
      .trim()
      .min(1, "Cần lệnh chạy server.")
      .max(500)
      .refine(...noEnvExpansion),
    args: z
      .array(
        z
          .string()
          .max(1000)
          .refine(...noEnvExpansion),
      )
      .max(50, "Tối đa 50 tham số."),
  }),
  z.object({
    transport: z.literal("http"),
    url: z
      .url({ protocol: /^https?$/, error: "URL phải bắt đầu bằng http:// hoặc https://." })
      .max(2000)
      .refine(...noEnvExpansion),
  }),
]);
export type McpServerLaunch = z.output<typeof mcpServerLaunch>;

export const mcpServerRuleInput = z.object({
  name: z.string().trim().min(1, "Cần tên server.").max(80, "Tên server tối đa 80 ký tự."),
  rule: mcpServerRuleEffect,
  matchType: mcpServerMatchType,
  /** Bỏ trống khi có cấu hình khởi chạy thì hub lấy theo chính server đó; `wildcard` luôn là `*`. */
  pattern: z.string().trim().max(500, "Mẫu khớp tối đa 500 ký tự.").default(""),
  /** null là quy tắc của cả tổ chức. */
  projectId: id.nullable(),
  /** Chỉ dòng có cấu hình khởi chạy mới được phát xuống máy chạy run. */
  launch: mcpServerLaunch.nullable(),
});
export type McpServerRuleInput = z.input<typeof mcpServerRuleInput>;

export const mcpServerRuleOutput = z.object({
  id,
  name: z.string(),
  key: z.string(),
  rule: mcpServerRuleEffect,
  matchType: mcpServerMatchType,
  pattern: z.string(),
  projectId: id.nullable(),
  projectKey: z.string().nullable(),
  launch: mcpServerLaunch.nullable(),
  updatedBy: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type McpServerRule = z.output<typeof mcpServerRuleOutput>;

export const mcpEffectiveServerOutput = z.object({
  ruleId: id,
  name: z.string(),
  key: z.string(),
  projectId: id.nullable(),
  launch: mcpServerLaunch,
  allowed: z.boolean(),
  /** Quy tắc quyết định; null khi không quy tắc nào khớp (mặc định chặn). */
  decidedBy: z.object({ id, name: z.string(), rule: mcpServerRuleEffect, projectId: id.nullable() }).nullable(),
});
export type McpEffectiveServer = z.output<typeof mcpEffectiveServerOutput>;

/** Server ngoài trong job_offer: chỉ những server được phép, đã bỏ mọi thứ không cần để khởi chạy. */
export const jobMcpServer = z.discriminatedUnion("transport", [
  z.object({
    name: z.string().regex(mcpServerKeyPattern),
    transport: z.literal("stdio"),
    command: z.string().min(1).max(500),
    args: z.array(z.string().max(1000)).max(50),
  }),
  z.object({ name: z.string().regex(mcpServerKeyPattern), transport: z.literal("http"), url: z.url().max(2000) }),
]);
export type JobMcpServer = z.output<typeof jobMcpServer>;

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
  listServers: orgRoute("GET", "/v1/mcp/admin/servers", "Quy tắc MCP server ngoài (quản trị)", "mcp").output(
    z.object({ rules: z.array(mcpServerRuleOutput) }),
  ),
  createServer: orgRoute("POST", "/v1/mcp/admin/servers", "Thêm quy tắc MCP server ngoài (quản trị)", "mcp")
    .input(mcpServerRuleInput)
    .output(mcpServerRuleOutput),
  updateServer: orgRoute("PATCH", "/v1/mcp/admin/servers/{id}", "Sửa quy tắc MCP server ngoài (quản trị)", "mcp")
    .input(mcpServerRuleInput.extend({ id }))
    .output(mcpServerRuleOutput),
  deleteServer: orgRoute("DELETE", "/v1/mcp/admin/servers/{id}", "Xoá quy tắc MCP server ngoài (quản trị)", "mcp")
    .input(z.object({ id }))
    .output(z.object({ deleted: z.literal(true) })),
  previewServers: orgRoute(
    "GET",
    "/v1/mcp/admin/servers/effective",
    "Server ngoài run của tổ chức hoặc một dự án sẽ nhận (quản trị)",
    "mcp",
  )
    .input(z.object({ projectId: id.optional() }))
    .output(z.object({ servers: z.array(mcpEffectiveServerOutput) })),
};
