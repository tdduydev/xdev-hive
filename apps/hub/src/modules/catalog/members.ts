import type { ProjectMember, ProjectMembership } from "@xdev-hive/contracts";
import { and, asc, eq, sql } from "drizzle-orm";
import { recordAudit } from "../audit/index.ts";
import { authUser } from "../identity/index.ts";
import { BadRequestError, NotFoundError, type Tx } from "../platform/index.ts";
import {
  allowWith,
  directTeamIds,
  directTeamMembers,
  notificationRecipients,
  requireTeamRole,
  teamRoleOf,
} from "../tenancy/index.ts";
import { projectMembers, projects } from "./schema.ts";

interface ProjectTeam {
  id: string;
  teamId: string;
}

// Đọc thẳng bảng thay vì loadProject: projects.ts gọi addCreatorAsMember, import ngược lại sẽ thành vòng tròn.
async function projectAs(tx: Tx, userId: string, projectId: string, manage: boolean): Promise<ProjectTeam> {
  const [project] = await tx
    .select({ id: projects.id, teamId: projects.teamId })
    .from(projects)
    .where(eq(projects.id, projectId));
  // Không có vai trò ở đội sở hữu thì báo như không tồn tại, để không lộ dự án có thật.
  if (!project || !(await teamRoleOf(tx, userId, project.teamId)))
    throw new NotFoundError("PROJECT_NOT_FOUND", "Không tìm thấy dự án trong tổ chức.");
  if (manage)
    await allowWith(
      tx,
      userId,
      "projects.settings",
      () => requireTeamRole(tx, userId, project.teamId, "admin"),
      project.teamId,
    );
  return project;
}

async function membersOf(tx: Tx, projectId: string): Promise<ProjectMember[]> {
  const rows = await tx
    .select({
      userId: projectMembers.userId,
      name: authUser.name,
      email: authUser.email,
      image: authUser.image,
      addedBy: projectMembers.addedBy,
      createdAt: projectMembers.createdAt,
    })
    .from(projectMembers)
    .innerJoin(authUser, eq(authUser.id, projectMembers.userId))
    .where(eq(projectMembers.projectId, projectId))
    .orderBy(asc(authUser.name), asc(projectMembers.userId));
  return rows.map(({ createdAt, ...r }) => ({ ...r, addedAt: createdAt.toISOString() }));
}

export async function listProjectMembers(tx: Tx, userId: string, projectId: string): Promise<ProjectMember[]> {
  const project = await projectAs(tx, userId, projectId, false);
  return membersOf(tx, project.id);
}

/** Tên để báo lỗi; chỉ lấy tên của người trong tổ chức, id lạ thì giữ nguyên id để không lộ người của tổ chức khác. */
async function displayName(tx: Tx, userId: string): Promise<string> {
  if ((await notificationRecipients(tx, [userId])).length === 0) return userId;
  const [row] = await tx.select({ name: authUser.name }).from(authUser).where(eq(authUser.id, userId));
  return row?.name ?? userId;
}

export async function addProjectMembers(
  tx: Tx,
  userId: string,
  projectId: string,
  userIds: string[],
): Promise<ProjectMember[]> {
  const project = await projectAs(tx, userId, projectId, true);
  const wanted = [...new Set(userIds)];
  // Kiểm cả lô trước khi ghi: khoá ngoại tới team_members sẽ làm hỏng cả transaction ở người ngoài đội đầu tiên.
  const inTeam = await directTeamMembers(tx, project.teamId, wanted);
  const outsider = wanted.find((u) => !inTeam.has(u));
  if (outsider) {
    throw new BadRequestError(
      "PROJECT_MEMBER_NOT_IN_TEAM",
      `${await displayName(tx, outsider)} chưa thuộc đội. Thêm người này vào đội trước.`,
    );
  }
  const inserted = await tx
    .insert(projectMembers)
    .values(
      wanted.map((u) => ({
        projectId: project.id,
        orgId: sql`hive.ctx_org()`,
        teamId: project.teamId,
        userId: u,
        addedBy: userId,
      })),
    )
    .onConflictDoNothing()
    .returning({ userId: projectMembers.userId });
  // Chỉ ghi audit cho người mới vào: thêm lại người đã có là không đổi gì.
  for (const r of inserted) {
    await recordAudit(tx, {
      action: "project_member.add",
      targetType: "project",
      targetId: project.id,
      data: { userId: r.userId },
    });
  }
  return membersOf(tx, project.id);
}

export async function removeProjectMember(
  tx: Tx,
  userId: string,
  projectId: string,
  memberId: string,
): Promise<{ ok: true }> {
  const project = await projectAs(tx, userId, projectId, true);
  const removed = await tx
    .delete(projectMembers)
    .where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, memberId)))
    .returning({ userId: projectMembers.userId });
  if (removed.length === 0)
    throw new NotFoundError("PROJECT_MEMBER_NOT_FOUND", "Người này không phải thành viên dự án.");
  await recordAudit(tx, {
    action: "project_member.remove",
    targetType: "project",
    targetId: project.id,
    data: { userId: memberId },
  });
  return { ok: true };
}

export async function myProjectMembership(tx: Tx, userId: string): Promise<ProjectMembership> {
  const rows = await tx
    .select({ projectId: projectMembers.projectId })
    .from(projectMembers)
    .where(and(eq(projectMembers.orgId, sql`hive.ctx_org()`), eq(projectMembers.userId, userId)));
  return { projectIds: rows.map((r) => r.projectId), teamIds: await directTeamIds(tx, userId) };
}

/**
 * Người tạo dự án thành thành viên (FR-041). Owner/admin tổ chức không ở team_members thì bỏ qua, vì khoá ngoại sẽ làm
 * hỏng cả transaction tạo dự án.
 */
export async function addCreatorAsMember(tx: Tx, project: ProjectTeam, userId: string): Promise<void> {
  if (!(await directTeamMembers(tx, project.teamId, [userId])).has(userId)) return;
  await tx
    .insert(projectMembers)
    .values({ projectId: project.id, orgId: sql`hive.ctx_org()`, teamId: project.teamId, userId, addedBy: userId })
    .onConflictDoNothing();
}
