import { SYSTEM_ROLE_PERMISSIONS, type SystemRoleId } from "@xdev-hive/contracts";
import { and, eq, inArray, isNull, or, type SQL, sql } from "drizzle-orm";
import { loadProject, type ProjectRow } from "../catalog/index.ts";
import type { DocAccessGrant, Reader as DocReader } from "../knowledge/index.ts";
import { ForbiddenError, NotFoundError, type Tx } from "../platform/index.ts";
import { customPermissions, type TeamRole, teamRolesOf } from "../tenancy/index.ts";
import { sdlcArtifacts, sdlcItemProjects, sdlcItems } from "./schema.ts";

/*
 * Phân quyền theo đội của hạng mục AI SDLC (specs/011 D22). RLS chỉ tách theo tổ chức, còn hạng mục trải nhiều đội nên
 * bộ lọc theo đội nằm ở đây: mọi truy vấn đọc `sdlc_*` đi qua `visibleItemsWhere`/`requireItemRead`, mọi thao tác ghi
 * gắn với dự án đi qua `requireProjectWrite`. Quyền kiểm mỗi lần gọi, không lưu, để người rời đội mất quyền ngay.
 * Chữ ký giữ như khung của T012 để route của hạng mục không phải sửa.
 */

export type SdlcPermission = "sdlc.read" | "sdlc.write" | "sdlc.override";

/** Hạng mục tối thiểu để xét quyền; `teamId` là đội chủ trì. */
export interface ItemAccessRow {
  id: string;
  teamId: string;
  ownerUserId: string;
}

// Vai trò tổ chức `member` cũng có `sdlc.*` (để menu hiện), nên không dùng effectivePermissions: quyền AI SDLC phải là
// quyền ở đội của dự án, không phải ở tổ chức.
const TEAM_ROLE_ID: Record<TeamRole, SystemRoleId> = {
  viewer: "team-viewer",
  ba: "team-ba",
  member: "team-member",
  admin: "team-admin",
};

const roleAllows = (role: TeamRole | null | undefined, permission: SdlcPermission) =>
  !!role && SYSTEM_ROLE_PERMISSIONS[TEAM_ROLE_ID[role]].includes(permission);

const itemNotFound = () => new NotFoundError("SDLC_ITEM_NOT_FOUND", "Không tìm thấy hạng mục.");

/** Đội nào trong `roles` cho `permission`: vai trò hệ thống trong đội, rồi vai trò tự tạo (chỉ cộng thêm quyền). */
async function teamsAllowing(
  tx: Tx,
  userId: string,
  roles: Map<string, TeamRole>,
  teamIds: readonly string[],
  permission: SdlcPermission,
): Promise<string[]> {
  const out: string[] = [];
  for (const teamId of new Set(teamIds)) {
    if (roleAllows(roles.get(teamId), permission) || (await customPermissions(tx, userId, teamId)).has(permission))
      out.push(teamId);
  }
  return out;
}

/** Có `permission` ở đội: vai trò hệ thống trong đội (owner/admin tổ chức là quản trị mọi đội) hoặc vai trò tự tạo. */
export async function hasTeamPermission(
  tx: Tx,
  userId: string,
  teamId: string,
  permission: SdlcPermission,
): Promise<boolean> {
  const roles = await teamRolesOf(tx, userId, [teamId]);
  return (await teamsAllowing(tx, userId, roles, [teamId], permission)).length > 0;
}

/**
 * FR-051: người gọi phải có `permission` ở đội của **từng** dự án; thiếu một thì từ chối cả thao tác, trước khi ghi gì,
 * và báo tên dự án đó để người dùng biết cần xin quyền ở đâu.
 */
export async function requireProjectWrite(
  tx: Tx,
  userId: string,
  projectIds: readonly string[],
  permission: SdlcPermission = "sdlc.write",
): Promise<ProjectRow[]> {
  const projects: ProjectRow[] = [];
  for (const id of new Set(projectIds)) {
    const project = await loadProject(tx, id);
    if (!project) throw new NotFoundError("PROJECT_NOT_FOUND", "Không tìm thấy dự án.");
    projects.push(project);
  }
  const teamIds = projects.map((p) => p.teamId);
  const allowed = new Set(await teamsAllowing(tx, userId, await teamRolesOf(tx, userId, teamIds), teamIds, permission));
  const denied = projects.find((p) => !allowed.has(p.teamId));
  if (denied) throw new ForbiddenError("SDLC_FORBIDDEN", `Bạn không có quyền AI SDLC trên dự án ${denied.key}.`);
  return projects;
}

/** Dự án đang tham gia (chưa bỏ) của hạng mục, dự án chính trước. */
export async function activeItemProjects(tx: Tx, itemId: string) {
  return tx
    .select()
    .from(sdlcItemProjects)
    .where(and(eq(sdlcItemProjects.itemId, itemId), isNull(sdlcItemProjects.removedAt)))
    .orderBy(sql`${sdlcItemProjects.role} = 'home' desc`, sdlcItemProjects.addedAt, sdlcItemProjects.projectId);
}

/** Đội của hạng mục: đội chủ trì và đội của mọi dự án đang tham gia. Dự án đã bỏ không còn mở quyền cho đội của nó. */
async function itemTeamIds(tx: Tx, item: ItemAccessRow): Promise<string[]> {
  return [...new Set([item.teamId, ...(await activeItemProjects(tx, item.id)).map((p) => p.teamId)])];
}

/** Điều kiện cho truy vấn có `sdlc_items`: hạng mục có đội chủ trì hoặc dự án tham gia thuộc đội người đọc thấy. */
export async function visibleItemsWhere(tx: Tx, userId: string): Promise<SQL> {
  // Không còn là thành viên tổ chức thì teamRolesOf trả rỗng: không thấy hạng mục nào.
  const roles = await teamRolesOf(tx, userId);
  const teams = await teamsAllowing(tx, userId, roles, [...roles.keys()], "sdlc.read");
  if (teams.length === 0) return sql`false`;
  return or(
    inArray(sdlcItems.teamId, teams),
    sql`exists (select 1 from ${sdlcItemProjects} where ${and(
      eq(sdlcItemProjects.itemId, sdlcItems.id),
      isNull(sdlcItemProjects.removedAt),
      inArray(sdlcItemProjects.teamId, teams),
    )})`,
  ) as SQL;
}

/** Như visibleItemsWhere cho run (MCP, seed): run chỉ thấy hạng mục có dự án của run. */
export function projectItemsWhere(projectId: string): SQL {
  return sql`exists (select 1 from ${sdlcItemProjects} where ${and(
    eq(sdlcItemProjects.itemId, sdlcItems.id),
    isNull(sdlcItemProjects.removedAt),
    eq(sdlcItemProjects.projectId, projectId),
  )})`;
}

export async function canReadItem(tx: Tx, userId: string, item: ItemAccessRow): Promise<boolean> {
  const teamIds = await itemTeamIds(tx, item);
  const roles = await teamRolesOf(tx, userId, teamIds);
  return (await teamsAllowing(tx, userId, roles, teamIds, "sdlc.read")).length > 0;
}

/** Không thấy thì báo như không tồn tại, để người ngoài không dò được tiêu đề hạng mục của đội khác. */
export async function requireItemRead(tx: Tx, userId: string, item: ItemAccessRow): Promise<void> {
  if (!(await canReadItem(tx, userId, item))) throw itemNotFound();
}

export type SdlcItemRow = typeof sdlcItems.$inferSelect;

/** Hạng mục người dùng thấy; `lock` khoá hàng cho thao tác đổi hạng mục. */
export async function itemForUser(tx: Tx, userId: string, id: string, lock = false): Promise<SdlcItemRow> {
  const q = tx.select().from(sdlcItems).where(eq(sdlcItems.id, id));
  const [row] = lock ? await q.for("update") : await q;
  if (!row) throw itemNotFound();
  await requireItemRead(tx, userId, row);
  return row;
}

/**
 * Tạm dừng, tiếp tục, huỷ, bỏ qua giai đoạn, đổi chế độ, đổi dự án tham gia: chủ hạng mục (còn `sdlc.write` ở đội chủ
 * trì) hoặc `sdlc.override` ở đội chủ trì (quản trị đội). Quyền ở dự án được thêm/bỏ kiểm riêng bằng requireProjectWrite.
 */
export async function canManageItem(tx: Tx, userId: string, item: ItemAccessRow): Promise<boolean> {
  if (item.ownerUserId === userId && (await hasTeamPermission(tx, userId, item.teamId, "sdlc.write"))) return true;
  return hasTeamPermission(tx, userId, item.teamId, "sdlc.override");
}

export async function requireItemManage(tx: Tx, userId: string, item: ItemAccessRow): Promise<void> {
  await requireItemRead(tx, userId, item);
  if (!(await canManageItem(tx, userId, item)))
    throw new ForbiddenError(
      "SDLC_MANAGE_FORBIDDEN",
      "Chỉ chủ hạng mục hoặc người có quyền ngoại lệ AI SDLC của đội làm được việc này.",
    );
}

/**
 * Lọc người nhận thông báo của hạng mục: chỉ người thấy hạng mục (D22). Thông báo không đi qua RLS theo đội nên thiếu
 * bước này sẽ lộ tiêu đề cho đội không tham gia.
 */
export async function itemViewers(tx: Tx, item: ItemAccessRow, userIds: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const userId of new Set(userIds)) if (await canReadItem(tx, userId, item)) out.push(userId);
  return out;
}

/**
 * Hook `docAccessFor` của knowledge (tiêm ở main.ts bằng provideDocAccess): tài liệu chung nằm ở dự án chính nên
 * mặc định chỉ đội chủ trì đọc được; người thấy hạng mục được đọc, người có `sdlc.write` ở một đội tham gia được đề
 * xuất. Không mở `manage`: lưu thẳng và duyệt vẫn theo cổng. Run chỉ đọc, và chỉ khi dự án của run tham gia hạng mục.
 */
export async function docAccessFor(tx: Tx, reader: DocReader, key: string): Promise<DocAccessGrant | null> {
  const [row] = await tx
    .select({ id: sdlcItems.id, teamId: sdlcItems.teamId, ownerUserId: sdlcItems.ownerUserId })
    .from(sdlcArtifacts)
    .innerJoin(sdlcItems, eq(sdlcItems.id, sdlcArtifacts.itemId))
    .where(eq(sdlcArtifacts.docKey, key));
  if (!row) return null;
  if (reader.kind === "run")
    return (await activeItemProjects(tx, row.id)).some((p) => p.projectId === reader.projectId)
      ? { read: true, propose: false }
      : null;
  const userId = reader.principal.userId;
  const teamIds = await itemTeamIds(tx, row);
  if ((await teamsAllowing(tx, userId, reader.teams, teamIds, "sdlc.read")).length === 0) return null;
  return { read: true, propose: (await teamsAllowing(tx, userId, reader.teams, teamIds, "sdlc.write")).length > 0 };
}
