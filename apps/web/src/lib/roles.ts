import type { OrgRole, TeamRole } from "@xdev-hive/contracts";

export const ORG_ROLES: readonly OrgRole[] = ["owner", "admin", "member"];
/**
 * Thứ tự từ quyền cao xuống: BA/PO (specs/011 FR-061) và Tester (specs/036 FR-012) đứng giữa thành viên và chỉ xem như
 * thứ hạng của hub.
 */
export const TEAM_ROLES: readonly TeamRole[] = ["admin", "member", "ba", "tester", "viewer"];

export const ORG_ROLE_LABEL: Record<OrgRole, string> = { owner: "Chủ sở hữu", admin: "Quản trị", member: "Thành viên" };
export const TEAM_ROLE_LABEL: Record<TeamRole, string> = {
  admin: "Quản trị đội",
  member: "Thành viên",
  viewer: "Chỉ xem",
  ba: "BA/PO",
  tester: "Tester",
};

/*
 * Các hàm dưới đây chỉ để ẩn hoặc tắt nút; hub mới là nơi chặn (apps/hub, tenancy/permissions.ts). Viết theo cùng
 * quy tắc với hub để người dùng không bấm được nút chắc chắn bị từ chối.
 */

export const isOrgAdmin = (role: OrgRole): boolean => role === "owner" || role === "admin";

/** Vai trò thực trong đội: quản trị và chủ sở hữu tổ chức là quản trị của mọi đội. */
export function effectiveTeamRole(orgRole: OrgRole, teamRole: TeamRole | undefined): TeamRole | null {
  if (isOrgAdmin(orgRole)) return "admin";
  return teamRole ?? null;
}

/** Thêm hệ thống, thêm/gỡ người, đổi vai trò trong đội. */
export const canManageTeam = (orgRole: OrgRole, teamRole: TeamRole | undefined): boolean =>
  effectiveTeamRole(orgRole, teamRole) === "admin";

/** Đổi vai trò tổ chức: chỉ chủ sở hữu. Không cho tự đổi vai trò của mình để khỏi lỡ tay tự hạ quyền. */
export const canSetOrgRole = (actor: OrgRole, isSelf: boolean): boolean => actor === "owner" && !isSelf;

/** Khoá/mở khoá: quản trị trở lên, không tự khoá mình, chỉ chủ sở hữu đụng được tới chủ sở hữu khác. */
export const canSetStatus = (actor: OrgRole, target: OrgRole, isSelf: boolean): boolean =>
  isOrgAdmin(actor) && !isSelf && (target !== "owner" || actor === "owner");
