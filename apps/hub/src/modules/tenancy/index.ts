// Tổ chức, đội, hệ thống và phân quyền. Module khác chỉ import file này.

export { registerMcpTools } from "./mcp-tools.ts";
export {
  type OrgRole,
  orgRoleOf,
  requireOrgRole,
  requireTeamRole,
  type TeamRole,
  teamRoleOf,
} from "./permissions.ts";
export { ORG_HEADER, type TenancyDeps } from "./procedures.ts";
export { tenancyRouter } from "./router.ts";
// Bảng của module khác cần khoá ngoại kép (team_id, org_id) tới teams.
export { teams } from "./schema.ts";
