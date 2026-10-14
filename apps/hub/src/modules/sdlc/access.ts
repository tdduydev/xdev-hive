import { SYSTEM_ROLE_PERMISSIONS, type SystemRoleId } from "@xdev-hive/contracts";
import { inArray, type SQL, sql } from "drizzle-orm";
import { loadProject } from "../catalog/index.ts";
import { ForbiddenError, NotFoundError, type Tx } from "../platform/index.ts";
import { customPermissions, type TeamRole, teamRoleOf, teamRolesOf } from "../tenancy/index.ts";
import { sdlcItems } from "./schema.ts";

/*
 * Phân quyền của hạng mục (plan.md D22), bản tối thiểu của T012: xét theo đội của dự án chính. T015 thay thân bằng
 * bộ lọc theo mọi dự án tham gia và `docAccessFor`; chữ ký giữ nguyên để route không phải sửa.
 */

export type SdlcPermission = "sdlc.read" | "sdlc.write" | "sdlc.override";

// Xét quyền theo vai trò trong đội chứ không qua `effectivePermissions`: vai trò thành viên tổ chức có `sdlc.write` ở
// mọi nơi, nên dùng nó thì ai trong tổ chức cũng ghi được hạng mục của đội khác.
const teamSystemRole = (role: TeamRole) => `team-${role}` as SystemRoleId;

/** Có `permission` ở đội: vai trò hệ thống trong đội (owner/admin tổ chức là quản trị mọi đội) hoặc vai trò tự tạo. */
export async function hasTeamPermission(
  tx: Tx,
  userId: string,
  teamId: string,
  permission: SdlcPermission,
): Promise<boolean> {
  const role = await teamRoleOf(tx, userId, teamId);
  if (role && SYSTEM_ROLE_PERMISSIONS[teamSystemRole(role)]?.includes(permission)) return true;
  return (await customPermissions(tx, userId, teamId)).has(permission);
}

/**
 * Thiếu quyền ở một dự án là từ chối cả thao tác (FR-051), và báo tên dự án đó để người dùng biết cần xin quyền ở đâu.
 */
export async function requireProjectWrite(
  tx: Tx,
  userId: string,
  projectIds: readonly string[],
  permission: SdlcPermission = "sdlc.write",
): Promise<void> {
  for (const id of new Set(projectIds)) {
    const project = await loadProject(tx, id);
    if (!project) throw new NotFoundError("PROJECT_NOT_FOUND", "Không tìm thấy dự án.");
    if (!(await hasTeamPermission(tx, userId, project.teamId, permission)))
      throw new ForbiddenError("SDLC_FORBIDDEN", `Bạn không có quyền AI SDLC trên dự án ${project.key}.`);
  }
}

/** Hạng mục tối thiểu để xét quyền. */
export interface ItemAccessRow {
  id: string;
  teamId: string;
  ownerUserId: string;
}

export async function canReadItem(tx: Tx, userId: string, item: ItemAccessRow): Promise<boolean> {
  return hasTeamPermission(tx, userId, item.teamId, "sdlc.read");
}

/** Không thấy thì báo như không tồn tại, để người ngoài không dò được hạng mục của đội khác. */
export async function requireItemRead(tx: Tx, userId: string, item: ItemAccessRow): Promise<void> {
  if (!(await canReadItem(tx, userId, item)))
    throw new NotFoundError("SDLC_ITEM_NOT_FOUND", "Không tìm thấy hạng mục.");
}

/** Tạm dừng, tiếp tục, huỷ, bỏ qua giai đoạn, đổi chế độ: chủ hạng mục hoặc `sdlc.override` ở đội chủ trì. */
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

/** Điều kiện SQL cho mọi truy vấn đọc danh sách hạng mục; `sql\`false\`` khi người dùng không thấy đội nào. */
export async function visibleItemsWhere(tx: Tx, userId: string): Promise<SQL> {
  const roles = await teamRolesOf(tx, userId);
  const teams: string[] = [];
  for (const [teamId, role] of roles) {
    if (SYSTEM_ROLE_PERMISSIONS[teamSystemRole(role)]?.includes("sdlc.read")) teams.push(teamId);
    else if ((await customPermissions(tx, userId, teamId)).has("sdlc.read")) teams.push(teamId);
  }
  return teams.length ? inArray(sdlcItems.teamId, teams) : sql`false`;
}
