export {
  type Auth,
  type AuthOptions,
  authConfig,
  createAuth,
  MCP_CONSENT_PAGE,
  MCP_LOGIN_PAGE,
  mcpEnabled,
  mcpResource,
  type OAuthApp,
} from "./auth.ts";
export { meRouter } from "./router.ts";
// Module khác cần bảng người dùng để đặt khoá ngoại và lấy tên, email.
export { user as authUser } from "./schema.ts";
