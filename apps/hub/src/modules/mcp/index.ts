// Cổng MCP: xác thực token, chạy tool của các module trong withTenant, ghi audit. Module khác chỉ import file này:
// để đăng ký tool qua registerMcpTools(registry) của chính nó, và (runs) để lấy MCP server ngoài được phép cho job.

export { mcpAdminRouter } from "./admin-router.ts";
export { issueDesktopToken } from "./admin-service.ts";
export { createMcpEndpoint, type McpEndpointDeps } from "./endpoint.ts";
export { type McpPrincipal, noRunTokens, type RunTokenVerifier } from "./principal.ts";
export {
  type McpOrgMembership,
  type McpProjectRef,
  type McpTool,
  type McpToolContext,
  McpToolRegistry,
} from "./registry.ts";
export { mcpServersForProject } from "./server-rules-service.ts";
