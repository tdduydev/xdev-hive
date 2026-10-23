import { type SQL, sql } from "drizzle-orm";
import { ForbiddenError, NotFoundError, type Tx } from "../platform/index.ts";
import { orgRoleOf, requireTeamRole, type TeamRole, visibleTeamIds } from "../tenancy/index.ts";
import { chatThreads } from "./schema.ts";

type ThreadRow = typeof chatThreads.$inferSelect;

/**
 * Điều kiện SQL cho hội thoại Leader người dùng thấy được (spec 034 FR-090). RLS chỉ cắt theo tổ chức, nên trước đây mọi
 * thành viên đọc được trao đổi về dự án của đội khác. Owner/admin tổ chức thấy hết; người khác thấy hội thoại của dự
 * án thuộc đội mình có vai trò, và hội thoại chưa gắn dự án do chính mình tạo. Trả `undefined` là không lọc.
 */
export async function visibleThreadsWhere(tx: Tx, userId: string): Promise<SQL | undefined> {
  const orgRole = await orgRoleOf(tx, userId);
  if (orgRole === "owner" || orgRole === "admin") return undefined;
  const teamIds = await visibleTeamIds(tx, userId);
  const own = sql`(${chatThreads.projectId} is null and ${chatThreads.createdBy} = ${userId})`;
  if (teamIds.length === 0) return own;
  return sql`(${own} or ${chatThreads.projectId} in (
    select p.id from hive.projects p where p.team_id in (${sql.join(
      teamIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})
  ))`;
}

/** Id đội sở hữu dự án của hội thoại, null khi chưa gắn dự án hoặc dự án không còn. */
async function threadTeamId(tx: Tx, thread: ThreadRow): Promise<string | null> {
  if (!thread.projectId) return null;
  const { rows } = await tx.execute<{ team_id: string }>(
    sql`select team_id from hive.projects where id = ${thread.projectId}`,
  );
  return rows[0]?.team_id ?? null;
}

/**
 * Đòi người dùng thấy được hội thoại; không thấy thì báo như không tồn tại để không lộ id hội thoại của đội khác. Với
 * `min`, đòi thêm vai trò đội tối thiểu trên dự án (từ chối đề xuất là quyết định thay đội, viewer không được làm).
 */
export async function requireThreadAccess(tx: Tx, userId: string, thread: ThreadRow, min?: TeamRole): Promise<void> {
  const orgRole = await orgRoleOf(tx, userId);
  const orgAdmin = orgRole === "owner" || orgRole === "admin";
  const teamId = await threadTeamId(tx, thread);
  if (!teamId) {
    if (orgAdmin || thread.createdBy === userId) return;
    throw new NotFoundError("LEADER_THREAD_NOT_FOUND", "Không tìm thấy cuộc trò chuyện.");
  }
  if (orgAdmin) return;
  try {
    await requireTeamRole(tx, userId, teamId, min ?? "viewer");
  } catch (error) {
    if (error instanceof ForbiddenError && error.code === "NOT_TEAM_MEMBER")
      throw new NotFoundError("LEADER_THREAD_NOT_FOUND", "Không tìm thấy cuộc trò chuyện.");
    throw error;
  }
}
