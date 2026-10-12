// Cổng MCP: xác thực token, chạy tool của các module trong withTenant, ghi audit. Module khác chỉ import file này
// và chỉ để đăng ký tool qua registerMcpTools(registry) của chính nó.

export { mcpAdminRouter } from "./admin-router.ts";
export { createMcpEndpoint, type McpEndpointDeps } from "./endpoint.ts";
export { type McpPrincipal, noRunTokens, type RunTokenVerifier } from "./principal.ts";
export { type McpOrgMembership, type McpTool, type McpToolContext, McpToolRegistry } from "./registry.ts";
