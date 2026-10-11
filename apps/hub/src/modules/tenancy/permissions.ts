import { and, eq, sql } from "drizzle-orm";
import { ForbiddenError, type Tx } from "../platform/index.ts";
import { orgMembers, type orgRole, teamMembers, type teamRole, teams } from "./schema.ts";

export type OrgRole = (typeof orgRole.enumValues)[number];
export type TeamRole = (typeof teamRole.enumValues)[number];

const ORG_RANK: Record<OrgRole, number> = { member: 1, admin: 2, owner: 3 };
const TEAM_RANK: Record<TeamRole, number> = { viewer: 1, member: 2, admin: 3 };

const ORG_LABEL: Record<OrgRole, string> = { owner: "chủ sở hữu", admin: "quản trị", member: "thành viên" };
const TEAM_LABEL: Record<TeamRole, string> = { admin: "quản trị", member: "thành viên", viewer: "người xem" };

/**
 * Vai trò của người dùng trong tổ chức đang ở context, hoặc null nếu không phải thành viên đang hoạt động.
 * Lọc theo hive.ctx_org() chứ không chỉ dựa vào RLS: policy org_members còn cho người dùng thấy mọi tư cách
 * thành viên của chính họ, nên thiếu điều kiện này sẽ lấy nhầm vai trò ở tổ chức khác.
 */
export async function orgRoleOf(tx: Tx, userId: string): Promise<OrgRole | null> {
  const [row] = await tx
    .select({ role: orgMembers.role })
    .from(orgMembers)
    .where(
      and(eq(orgMembers.orgId, sql`hive.ctx_org()`), eq(orgMembers.userId, userId), eq(orgMembers.status, "active")),
    );
  return row?.role ?? null;
}

/** Đòi vai trò tổ chức ít nhất là `min`; trả về vai trò thực để người gọi khỏi truy vấn lại. */
export async function requireOrgRole(tx: Tx, userId: string, min: OrgRole): Promise<OrgRole> {
  const role = await orgRoleOf(tx, userId);
  if (!role) throw new ForbiddenError("NOT_ORG_MEMBER", "Bạn không phải thành viên của tổ chức này.");
  if (ORG_RANK[role] < ORG_RANK[min])
    throw new ForbiddenError("ORG_ROLE_REQUIRED", `Cần vai trò ${ORG_LABEL[min]} của tổ chức trở lên.`);
  return role;
}

/**
 * Vai trò của người dùng trong một đội, hoặc null nếu không có quyền gì. Owner/admin tổ chức được coi là admin
 * của mọi đội. Người không còn là thành viên đang hoạt động của tổ chức thì mất quyền ở mọi đội, kể cả khi
 * dòng team_members vẫn còn, vì khoá tài khoản chỉ đổi status ở org_members.
 */
export async function teamRoleOf(tx: Tx, userId: string, teamId: string): Promise<TeamRole | null> {
  const org = await orgRoleOf(tx, userId);
  if (!org) return null;
  // Đi từ teams để biết đội có tồn tại trong tổ chức của context (RLS lọc đội của tổ chức khác), nhờ vậy
  // owner/admin tổ chức không thành "admin" của một id đội bất kỳ.
  const [row] = await tx
    .select({ role: teamMembers.role })
    .from(teams)
    .leftJoin(teamMembers, and(eq(teamMembers.teamId, teams.id), eq(teamMembers.userId, userId)))
    .where(eq(teams.id, teamId));
  if (!row) return null;
  if (org === "owner" || org === "admin") return "admin";
  return row.role;
}

/** Đòi vai trò đội ít nhất là `min`; trả về vai trò thực. */
export async function requireTeamRole(tx: Tx, userId: string, teamId: string, min: TeamRole): Promise<TeamRole> {
  const role = await teamRoleOf(tx, userId, teamId);
  if (!role) throw new ForbiddenError("NOT_TEAM_MEMBER", "Bạn không có quyền truy cập đội này.");
  if (TEAM_RANK[role] < TEAM_RANK[min])
    throw new ForbiddenError("TEAM_ROLE_REQUIRED", `Cần vai trò ${TEAM_LABEL[min]} của đội trở lên.`);
  return role;
}
