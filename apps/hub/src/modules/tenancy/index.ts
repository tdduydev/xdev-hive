// Tổ chức, đội, hệ thống và phân quyền. Module khác chỉ import file này.
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
