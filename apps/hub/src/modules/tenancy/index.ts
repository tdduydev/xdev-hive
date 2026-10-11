// Tổ chức, đội, hệ thống và phân quyền. Module khác chỉ import file này.
export { findSystem, type SystemRef } from "./lookup.ts";
export { registerMcpTools } from "./mcp-tools.ts";
export { orphanUsersQueue, purgeOrphanUsers, registerOrphanUsersWorker } from "./orphans.ts";
export {
  type OrgRole,
  orgRoleOf,
  requireOrgRole,
  requireTeamRole,
  type TeamRole,
  teamRoleOf,
} from "./permissions.ts";
export { ORG_HEADER, type OrgDeps, orgMiddlewares, type SessionUser, type TenancyDeps } from "./procedures.ts";
export { tenancyRouter } from "./router.ts";
// Bảng của module khác cần khoá ngoại kép (team_id, org_id) tới teams.
export { teams } from "./schema.ts";
export { authHooks } from "./sso.ts";
