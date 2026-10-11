// Tổ chức, đội, hệ thống và phân quyền. Module khác chỉ import file này.
export {
  type OrgRole,
  orgRoleOf,
  requireOrgRole,
  requireTeamRole,
  type TeamRole,
  teamRoleOf,
} from "./permissions.ts";
// Bảng của module khác cần khoá ngoại kép (team_id, org_id) tới teams.
export { teams } from "./schema.ts";
