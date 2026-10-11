// Tổ chức, đội, hệ thống và phân quyền. Module khác chỉ import file này.
export { findSystem, type SystemRef } from "./lookup.ts";
export {
  type OrgRole,
  orgRoleOf,
  requireOrgRole,
  requireTeamRole,
  type TeamRole,
  teamRoleOf,
} from "./permissions.ts";
export { ORG_HEADER, type OrgActor, type OrgScopeDeps, orgScope } from "./scope.ts";
