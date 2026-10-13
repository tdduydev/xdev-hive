import { and, eq, inArray, sql } from "drizzle-orm";
import { BadRequestError, ForbiddenError, type Tx } from "../platform/index.ts";
import { orgMembers, type orgRole, teamMembers, type teamRole, teams } from "./schema.ts";

export type OrgRole = (typeof orgRole.enumValues)[number];
export type TeamRole = (typeof teamRole.enumValues)[number];

const ORG_RANK: Record<OrgRole, number> = { member: 1, admin: 2, owner: 3 };
const TEAM_RANK: Record<TeamRole, number> = { viewer: 1, member: 2, admin: 3 };

const ORG_LABEL: Record<OrgRole, string> = { owner: "chủ sở hữu", admin: "quản trị", member: "thành viên" };
const TEAM_LABEL: Record<TeamRole, string> = { admin: "quản trị", member: "thành viên", viewer: "người xem" };

/**
 * Vai trò đội lưu được. Hợp đồng đã có BA/PO (`ba`, specs/011) nhưng enum `team_role` của database và thứ hạng vai trò
 * chưa có (T004, T018); tới lúc đó từ chối rõ ràng thay vì để database báo lỗi.
 */
export function storableTeamRole(role: TeamRole | "ba"): TeamRole {
  if (role === "ba") throw new BadRequestError("TEAM_ROLE_UNSUPPORTED", "Vai trò BA/PO chưa dùng được trên hub này.");
  return role;
}

/** Lọc người nhận thật trong tổ chức: created_by của webhook có thể là danh tính Git, không phải tài khoản hub. */
export async function notificationRecipients(tx: Tx, userIds?: string[]): Promise<string[]> {
  if (userIds?.length === 0) return [];
  const rows = await tx
    .select({ userId: orgMembers.userId })
    .from(orgMembers)
    .where(
      and(
        eq(orgMembers.orgId, sql`hive.ctx_org()`),
        eq(orgMembers.status, "active"),
        userIds ? inArray(orgMembers.userId, [...new Set(userIds)]) : inArray(orgMembers.role, ["owner", "admin"]),
      ),
    );
  return rows.map((r) => r.userId);
}

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
  return (await teamRolesOf(tx, userId, [teamId])).get(teamId) ?? null;
}

/**
 * Vai trò của người dùng ở nhiều đội (bỏ trống `teamIds` là mọi đội của tổ chức) theo đúng luật của teamRoleOf, trong
 * một truy vấn: danh sách gom từ nhiều đội không phải hỏi database cho từng đội. Đội không có vai trò thì không có
 * trong Map.
 */
export async function teamRolesOf(tx: Tx, userId: string, teamIds?: string[]): Promise<Map<string, TeamRole>> {
  if (teamIds?.length === 0) return new Map();
  // Đi từ teams để biết đội có tồn tại trong tổ chức của context (RLS lọc đội của tổ chức khác), nhờ vậy
  // owner/admin tổ chức không thành "admin" của một id đội bất kỳ. Join org_members với hive.ctx_org() như orgRoleOf:
  // không còn là thành viên đang hoạt động thì không ra dòng nào.
  const rows = await tx
    .select({ teamId: teams.id, role: teamMembers.role, orgRole: orgMembers.role })
    .from(teams)
    .innerJoin(
      orgMembers,
      and(eq(orgMembers.orgId, sql`hive.ctx_org()`), eq(orgMembers.userId, userId), eq(orgMembers.status, "active")),
    )
    .leftJoin(teamMembers, and(eq(teamMembers.teamId, teams.id), eq(teamMembers.userId, userId)))
    .where(teamIds ? inArray(teams.id, [...new Set(teamIds)]) : undefined);
  const roles = new Map<string, TeamRole>();
  for (const r of rows) {
    const role = r.orgRole === "owner" || r.orgRole === "admin" ? "admin" : r.role;
    if (role) roles.set(r.teamId, role);
  }
  return roles;
}

/**
 * Id các đội người dùng có vai trò trong tổ chức của context: mọi đội với owner/admin tổ chức, còn lại là đội mình là
 * thành viên. Danh sách có phân trang cần lọc trong SQL; hỏi teamRoleOf cho từng dòng sau khi lấy sẽ làm trang hụt.
 */
export async function visibleTeamIds(tx: Tx, userId: string): Promise<string[]> {
  return [...(await teamRolesOf(tx, userId)).keys()];
}

/** Đòi vai trò đội ít nhất là `min`; trả về vai trò thực. */
export async function requireTeamRole(tx: Tx, userId: string, teamId: string, min: TeamRole): Promise<TeamRole> {
  return checkTeamRole(await teamRoleOf(tx, userId, teamId), min);
}

/** Như requireTeamRole với vai trò đã hỏi bằng teamRoleOf, để người gọi vừa hỏi xong không phải hỏi lại database. */
export function checkTeamRole(role: TeamRole | null, min: TeamRole): TeamRole {
  if (!role) throw new ForbiddenError("NOT_TEAM_MEMBER", "Bạn không có quyền truy cập đội này.");
  if (TEAM_RANK[role] < TEAM_RANK[min])
    throw new ForbiddenError("TEAM_ROLE_REQUIRED", `Cần vai trò ${TEAM_LABEL[min]} của đội trở lên.`);
  return role;
}

/**
 * Thành viên đang hoạt động của một đội có vai trò đội từ `min` trở lên, cộng owner/admin tổ chức (coi là quản trị mọi
 * đội như teamRoleOf). Dùng để báo cho người duyệt theo vai trò.
 */
export async function teamMemberIds(tx: Tx, teamId: string, min: TeamRole): Promise<string[]> {
  const roles = (Object.keys(TEAM_RANK) as TeamRole[]).filter((r) => TEAM_RANK[r] >= TEAM_RANK[min]);
  const members = await tx
    .select({ userId: teamMembers.userId })
    .from(teamMembers)
    .innerJoin(orgMembers, and(eq(orgMembers.userId, teamMembers.userId), eq(orgMembers.orgId, sql`hive.ctx_org()`)))
    .where(and(eq(teamMembers.teamId, teamId), inArray(teamMembers.role, roles), eq(orgMembers.status, "active")));
  const admins = await notificationRecipients(tx);
  return [...new Set([...members.map((m) => m.userId), ...admins])];
}
