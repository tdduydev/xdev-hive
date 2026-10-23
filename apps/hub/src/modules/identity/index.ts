export {
  type Auth,
  type AuthHooks,
  type AuthOptions,
  authConfig,
  createAuth,
  MCP_CONSENT_PAGE,
  MCP_LOGIN_PAGE,
  type McpMode,
  mcpEnabled,
  mcpMode,
  mcpResource,
  type OAuthApp,
  ssoProviderForDomain,
} from "./auth.ts";
export { meRouter } from "./router.ts";
// Module khác cần bảng người dùng để đặt khoá ngoại và lấy tên, email.
export { user as authUser } from "./schema.ts";
export {
  anySsoProvider,
  checkDomainVerification,
  DOMAIN_VERIFICATION_LABEL,
  type DomainVerificationResult,
  type DomainVerificationView,
  getDomainVerification,
  getSsoProvider,
  removeSsoProvider,
  requestDomainVerification,
  type SavedSsoProvider,
  type SsoActor,
  type SsoProviderInput,
  type SsoProviderView,
  saveSsoProvider,
  ssoCallbackUrl,
  systemTxtResolver,
  type TxtResolver,
} from "./sso.ts";
