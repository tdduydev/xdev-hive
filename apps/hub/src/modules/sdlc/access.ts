import { SYSTEM_ROLE_PERMISSIONS, type SystemRoleId } from "@xdev-hive/contracts";
import { and, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import { loadProject, type ProjectRow } from "../catalog/index.ts";
import type { DocAccessGrant, Reader as DocReader } from "../knowledge/index.ts";
import { ForbiddenError, NotFoundError, type Tx } from "../platform/index.ts";
import { allowWith, type TeamRole, teamRolesOf } from "../tenancy/index.ts";
import { sdlcArtifacts, sdlcItemProjects, sdlcItems } from "./schema.ts";

/*
 * Phân quyền theo đội của hạng mục AI SDLC (specs/011 D22). RLS chỉ tách theo tổ chức, còn hạng mục trải nhiều đội nên
 * bộ lọc theo đội nằm ở đây: mọi truy vấn đọc `sdlc_*` đi qua `visibleItemsWhere`/`itemForReader`, mọi thao tác ghi gắn
 * với dự án đi qua `requireProjectWrite`. Quyền kiểm mỗi lần gọi, không lưu, để người rời đội mất quyền ngay.
 */

export type SdlcItemRow = typeof sdlcItems.$inferSelect;
export type SdlcPermission = "sdlc.read" | "sdlc.write" | "sdlc.override";

/** Người đọc: vai trò ở mọi đội của tổ chức, hỏi một lần cho cả thao tác (danh sách, bảng, thông báo). */
export interface SdlcReader {
  userId: string;
  teams: Map<string, TeamRole>;
}

// Vai trò tổ chức `member` cũng có `sdlc.*` (để menu hiện), nên không dùng effectivePermissions: quyền AI SDLC phải là
// quyền ở đội của dự án, không phải ở tổ chức.
const TEAM_ROLE_ID: Record<TeamRole, SystemRoleId> = {
  viewer: "team-viewer",
  ba: "team-ba",
  member: "team-member",
  admin: "team-admin",
};

export function teamRoleAllows(role: TeamRole | null | undefined, permission: string): boolean {
  return !!role && SYSTEM_ROLE_PERMISSIONS[TEAM_ROLE_ID[role]].includes(permission);
}

const itemNotFound = () => new NotFoundError("SDLC_ITEM_NOT_FOUND", "Không tìm thấy hạng mục.");
const projectNotFound = () => new NotFoundError("PROJECT_NOT_FOUND", "Không tìm thấy dự án trong tổ chức.");

export async function sdlcReaderFor(tx: Tx, userId: string): Promise<SdlcReader> {
  // Không còn là thành viên tổ chức thì teamRolesOf trả rỗng: không thấy hạng mục nào.
  return { userId, teams: await teamRolesOf(tx, userId) };
}

/** Đội người đọc thấy hạng mục: mọi vai trò đội đều có `sdlc.read` (cả viewer và BA/PO). */
function readableTeams(reader: SdlcReader): string[] {
  return [...reader.teams].filter(([, role]) => teamRoleAllows(role, "sdlc.read")).map(([teamId]) => teamId);
}

/**
 * Điều kiện cho truy vấn có `sdlc_items`: hạng mục có ít nhất một dự án tham gia (chưa bỏ) thuộc đội người đọc. Dự án đã
 * bỏ khỏi hạng mục không còn mở quyền xem cho đội của nó.
 */
export function visibleItemsWhere(reader: SdlcReader): SQL {
  const teamIds = readableTeams(reader);
  if (teamIds.length === 0) return sql`false`;
  return sql`exists (select 1 from ${sdlcItemProjects} where ${and(
    eq(sdlcItemProjects.itemId, sdlcItems.id),
    isNull(sdlcItemProjects.removedAt),
    inArray(sdlcItemProjects.teamId, teamIds),
  )})`;
}

/** Như visibleItemsWhere cho run (MCP, seed): run chỉ thấy hạng mục có dự án của run. */
export function projectItemsWhere(projectId: string): SQL {
  return sql`exists (select 1 from ${sdlcItemProjects} where ${and(
    eq(sdlcItemProjects.itemId, sdlcItems.id),
    isNull(sdlcItemProjects.removedAt),
    eq(sdlcItemProjects.projectId, projectId),
  )})`;
}

/** Hạng mục người đọc thấy; không thấy thì báo như không tồn tại để không lộ tiêu đề cho đội không tham gia. */
export async function itemForReader(tx: Tx, reader: SdlcReader, id: string, lock = false): Promise<SdlcItemRow> {
  const q = tx
    .select()
    .from(sdlcItems)
    .where(and(eq(sdlcItems.id, id), visibleItemsWhere(reader)));
  const [row] = lock ? await q.for("update") : await q;
  if (!row) throw itemNotFound();
  return row;
}

export async function itemForUser(tx: Tx, userId: string, id: string, lock = false): Promise<SdlcItemRow> {
  return itemForReader(tx, await sdlcReaderFor(tx, userId), id, lock);
}

/** Dự án đang tham gia (chưa bỏ) của hạng mục, dự án chính trước. */
export async function activeItemProjects(tx: Tx, itemId: string) {
  return tx
    .select()
    .from(sdlcItemProjects)
    .where(and(eq(sdlcItemProjects.itemId, itemId), isNull(sdlcItemProjects.removedAt)))
    .orderBy(sql`${sdlcItemProjects.role} = 'home' desc`, sdlcItemProjects.addedAt, sdlcItemProjects.projectId);
}

/**
 * FR-051: người gọi phải có `permission` ở đội của **từng** dự án; thiếu một thì từ chối cả thao tác, trước khi ghi gì.
 * Vai trò tự tạo gắn cho đội vẫn cộng thêm quyền như mọi chỗ khác (allowWith).
 */
export async function requireProjectWrite(
  tx: Tx,
  userId: string,
  projectIds: readonly string[],
  permission: SdlcPermission,
): Promise<ProjectRow[]> {
  const projects: ProjectRow[] = [];
  for (const id of new Set(projectIds)) {
    const project = await loadProject(tx, id);
    if (!project) throw projectNotFound();
    projects.push(project);
  }
  const roles = await teamRolesOf(
    tx,
    userId,
    projects.map((p) => p.teamId),
  );
  for (const p of projects) {
    await allowWith(
      tx,
      userId,
      permission,
      async () => {
        if (!teamRoleAllows(roles.get(p.teamId), permission))
          throw new ForbiddenError("SDLC_PROJECT_FORBIDDEN", `Bạn không có quyền AI SDLC trên dự án ${p.key}.`);
      },
      p.teamId,
    );
  }
  return projects;
}

/**
 * Đổi danh sách dự án tham gia: chủ hạng mục (còn `sdlc.write` ở đội chủ trì) hoặc quản trị đội chủ trì (plan.md
 * "Permissions"). Quyền ở dự án được thêm/bỏ kiểm riêng bằng requireProjectWrite.
 */
export async function requireItemManage(tx: Tx, userId: string, item: SdlcItemRow): Promise<void> {
  const role = (await teamRolesOf(tx, userId, [item.teamId])).get(item.teamId);
  const allowed = item.ownerUserId === userId ? teamRoleAllows(role, "sdlc.write") : role === "admin";
  if (!allowed)
    throw new ForbiddenError(
      "SDLC_ITEM_MANAGE_REQUIRED",
      "Chỉ chủ hạng mục hoặc quản trị đội chủ trì được đổi dự án tham gia.",
    );
}

/**
 * Lọc người nhận thông báo của hạng mục: chỉ người thấy hạng mục (D22). Thông báo không đi qua RLS theo đội nên thiếu
 * bước này sẽ lộ tiêu đề cho đội không tham gia.
 */
export async function itemViewers(tx: Tx, itemId: string, userIds: readonly string[]): Promise<string[]> {
  const teamIds = [...new Set((await activeItemProjects(tx, itemId)).map((p) => p.teamId))];
  const out: string[] = [];
  for (const userId of new Set(userIds)) {
    const roles = await teamRolesOf(tx, userId, teamIds);
    if ([...roles.values()].some((r) => teamRoleAllows(r, "sdlc.read"))) out.push(userId);
  }
  return out;
}

/**
 * Hook `docAccessFor` của knowledge (tiêm ở main.ts bằng provideDocAccess): tài liệu chung nằm ở dự án chính nên
 * mặc định chỉ đội chủ trì đọc được; thành viên đội tham gia khác được đọc, người có `sdlc.write` được đề xuất. Không
 * mở `manage`: lưu thẳng và duyệt vẫn theo cổng. Run chỉ đọc, và chỉ khi dự án của run tham gia hạng mục.
 */
export async function docAccessFor(tx: Tx, reader: DocReader, key: string): Promise<DocAccessGrant | null> {
  const [artifact] = await tx
    .select({ itemId: sdlcArtifacts.itemId })
    .from(sdlcArtifacts)
    .where(eq(sdlcArtifacts.docKey, key));
  if (!artifact) return null;
  const projects = await activeItemProjects(tx, artifact.itemId);
  if (reader.kind === "run")
    return projects.some((p) => p.projectId === reader.projectId) ? { read: true, propose: false } : null;
  const roles = projects.map((p) => reader.teams.get(p.teamId));
  if (!roles.some((r) => teamRoleAllows(r, "sdlc.read"))) return null;
  return { read: true, propose: roles.some((r) => teamRoleAllows(r, "sdlc.write")) };
}
