// Tổ chức, đội, hệ thống và phân quyền. Module khác chỉ import file này.
export { findOrgUserByEmail, findSystem, findSystemBySlug, resolveLegacyImportOrg, type SystemRef } from "./lookup.ts";
export { registerMcpTools } from "./mcp-tools.ts";
export { orphanUsersQueue, purgeOrphanUsers, registerOrphanUsersWorker } from "./orphans.ts";
export {
  notificationRecipients,
  type OrgRole,
  orgRoleOf,
  requireOrgRole,
  requireTeamRole,
  type TeamRole,
  teamRoleOf,
  visibleTeamIds,
} from "./permissions.ts";
export { ORG_HEADER, type OrgDeps, orgMiddlewares, type SessionUser, type TenancyDeps } from "./procedures.ts";
export { allowWith, customPermissions, effectivePermissions, rolesRouter } from "./roles.ts";
export { tenancyRouter } from "./router.ts";
// Bảng của module khác cần khoá ngoại kép (team_id, org_id) tới teams.
export { teams } from "./schema.ts";
export { authHooks } from "./sso.ts";
