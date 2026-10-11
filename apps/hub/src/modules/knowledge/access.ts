import type { KnowledgeAuthor, KnowledgeScope, ScopeView } from "@xdev-hive/contracts";
import { and, eq, inArray, isNull, or, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { recordAudit } from "../audit/index.ts";
import { findProject } from "../catalog/index.ts";
import { ConflictError, ForbiddenError, NotFoundError, type Tx } from "../platform/index.ts";
import {
  type OrgRole,
  orgRoleOf,
  requireOrgRole,
  requireTeamRole,
  type TeamRole,
  teamRoleOf,
  teams,
} from "../tenancy/index.ts";

/**
 * Ai đang gọi. Người dùng đi qua API; run là agent gọi qua MCP (task sau gắn), đã được cổng MCP xác thực bằng run
 * token và chỉ làm việc trong dự án của run.
 */
export type Principal = { kind: "user"; userId: string } | { kind: "run"; runId: string; projectId: string };

/** Phạm vi đã giải: team_id null là cả tổ chức, project_id null là cả đội. */
export interface Scope {
  teamId: string | null;
  projectId: string | null;
}

/** Phần dữ liệu tri thức người gọi được đọc, tính một lần cho mỗi thao tác. */
export type Reader =
  | { kind: "user"; principal: Principal & { kind: "user" }; orgRole: OrgRole; teams: Map<string, TeamRole> }
  | { kind: "run"; principal: Principal & { kind: "run" }; teamId: string; projectId: string };

/** Một dự án cụ thể: mục của tổ chức, của đội sở hữu dự án, và của chính dự án. */
export interface ProjectView {
  teamId: string;
  projectId: string;
}

export async function readerFor(tx: Tx, principal: Principal): Promise<Reader> {
  if (principal.kind === "run") {
    const project = await findProject(tx, principal.projectId);
    // Run mà dự án đã mất (hoặc ở tổ chức khác) thì không còn quyền gì.
    if (!project) throw new ForbiddenError("RUN_PROJECT_MISSING", "Run không còn thuộc dự án nào trong tổ chức.");
    return { kind: "run", principal, teamId: project.teamId, projectId: project.id };
  }
  const orgRole = await orgRoleOf(tx, principal.userId);
  if (!orgRole) throw new ForbiddenError("NOT_ORG_MEMBER", "Bạn không phải thành viên của tổ chức này.");
  // Số đội trong một tổ chức nhỏ, hỏi vai trò từng đội một lần là đủ (cùng cách listProjects của catalog).
  const roles = new Map<string, TeamRole>();
  for (const { id } of await tx.select({ id: teams.id }).from(teams)) {
    const role = await teamRoleOf(tx, principal.userId, id);
    if (role) roles.set(id, role);
  }
  return { kind: "user", principal, orgRole, teams: roles };
}

export function canRead(reader: Reader, scope: Scope): boolean {
  if (scope.teamId === null) return true;
  if (reader.kind === "user") return reader.teams.has(scope.teamId);
  return scope.teamId === reader.teamId && (scope.projectId === null || scope.projectId === reader.projectId);
}

/**
 * Điều kiện SQL "người gọi đọc được dòng này" cho bảng có cột team_id/project_id. Có `project` thì thu về đúng phần
 * áp dụng cho dự án đó; run luôn bị thu về dự án của nó.
 */
export function visibleWhere(
  reader: Reader,
  cols: { teamId: PgColumn; projectId: PgColumn },
  project?: ProjectView | undefined,
): SQL {
  const view = project ?? (reader.kind === "run" ? reader : undefined);
  if (view) {
    return or(
      isNull(cols.teamId),
      and(eq(cols.teamId, view.teamId), or(isNull(cols.projectId), eq(cols.projectId, view.projectId))),
    ) as SQL;
  }
  const ids = reader.kind === "user" ? [...reader.teams.keys()] : [];
  return (ids.length ? or(isNull(cols.teamId), inArray(cols.teamId, ids)) : isNull(cols.teamId)) as SQL;
}

const projectNotFound = () => new NotFoundError("PROJECT_NOT_FOUND", "Không tìm thấy dự án trong tổ chức.");

/** Dự án người gọi đọc được, theo key hoặc id. Run chỉ được nói tới dự án của nó. */
export async function projectFor(tx: Tx, reader: Reader, ref: string): Promise<ProjectView> {
  const project = await findProject(tx, ref);
  // Không có quyền xem thì báo như không tồn tại để không lộ dự án.
  if (!project || !canRead(reader, { teamId: project.teamId, projectId: project.id })) throw projectNotFound();
  return { teamId: project.teamId, projectId: project.id };
}

/** Dự án đặt trong tham số, hoặc dự án của run khi không đặt. */
export async function projectContext(
  tx: Tx,
  reader: Reader,
  ref: string | undefined,
): Promise<ProjectView | undefined> {
  if (ref !== undefined) return projectFor(tx, reader, ref);
  return reader.kind === "run" ? reader : undefined;
}

export async function resolveScope(tx: Tx, reader: Reader, input: KnowledgeScope): Promise<Scope> {
  if (input.level === "org") return { teamId: null, projectId: null };
  if (input.level === "project") {
    const p = await projectFor(tx, reader, input.projectId);
    return { teamId: p.teamId, projectId: p.projectId };
  }
  const [team] = await tx.select({ id: teams.id }).from(teams).where(eq(teams.id, input.teamId));
  if (!team || !canRead(reader, { teamId: team.id, projectId: null }))
    throw new NotFoundError("TEAM_NOT_FOUND", "Không tìm thấy đội trong tổ chức.");
  return { teamId: team.id, projectId: null };
}

/** Phạm vi suy ra từ key tài liệu: `org/...`, `team/<slug>/...`, `project/<key>/...` (contract đã kiểm dạng key). */
export async function scopeOfDocKey(tx: Tx, reader: Reader, key: string): Promise<Scope> {
  const [level, ref] = key.split("/");
  if (level === "org") return { teamId: null, projectId: null };
  if (level === "project" && ref) {
    const p = await projectFor(tx, reader, ref);
    return { teamId: p.teamId, projectId: p.projectId };
  }
  const [team] = ref ? await tx.select({ id: teams.id }).from(teams).where(eq(teams.slug, ref)) : [];
  if (!team || !canRead(reader, { teamId: team.id, projectId: null }))
    throw new NotFoundError("TEAM_NOT_FOUND", "Không tìm thấy đội trong tổ chức.");
  return { teamId: team.id, projectId: null };
}

/**
 * Thao tác ghi trên một phạm vi:
 * - `write`: ghi memory. Thành viên đội; cấp tổ chức cần quản trị tổ chức vì mọi đội đều đọc. Run ghi được vào dự
 *   án và đội của nó.
 * - `propose`: tạo đề xuất. Thành viên đội; cấp tổ chức thì thành viên tổ chức nào cũng được, vì còn chờ duyệt.
 *   Run đề xuất được ở mọi phạm vi nó đọc được.
 * - `manage`: lưu tài liệu/skill trực tiếp, duyệt đề xuất. Quản trị đội (cấp tổ chức: quản trị tổ chức). Run không
 *   bao giờ được, để mọi thay đổi của agent lên tài liệu và skill đều qua người duyệt.
 */
export type Action = "write" | "propose" | "manage";

export async function authorize(tx: Tx, reader: Reader, scope: Scope, action: Action): Promise<void> {
  if (reader.kind === "run") {
    if (action === "manage")
      throw new ForbiddenError(
        "RUN_NOT_ALLOWED",
        "Agent không được sửa trực tiếp; hãy tạo đề xuất để quản trị đội duyệt.",
      );
    if (action === "write" && scope.teamId === null)
      throw new ForbiddenError("RUN_NOT_ALLOWED", "Agent chỉ ghi memory cho dự án hoặc đội của run.");
    return;
  }
  const userId = reader.principal.userId;
  if (scope.teamId === null) {
    if (action === "propose") return;
    await requireOrgRole(tx, userId, "admin");
    return;
  }
  await requireTeamRole(tx, userId, scope.teamId, action === "manage" ? "admin" : "member");
}

export function scopeView(row: Scope): ScopeView {
  const level = row.projectId ? "project" : row.teamId ? "team" : "org";
  return { level, teamId: row.teamId, projectId: row.projectId };
}

export function authorColumns(principal: Principal): { authorUserId: string | null; authorRunId: string | null } {
  return principal.kind === "user"
    ? { authorUserId: principal.userId, authorRunId: null }
    : { authorUserId: null, authorRunId: principal.runId };
}

export function authorView(row: { authorUserId: string | null; authorRunId: string | null }): KnowledgeAuthor {
  return { userId: row.authorUserId, runId: row.authorRunId };
}

/** Ghi audit kèm ai gọi; run không có người dùng trong context nên ghi runId vào data. */
export function audit(
  tx: Tx,
  principal: Principal,
  action: string,
  target: { type: string; id: string },
  data: Record<string, unknown> = {},
): Promise<string> {
  return recordAudit(tx, {
    action,
    actorUserId: principal.kind === "user" ? principal.userId : null,
    targetType: target.type,
    targetId: target.id,
    data: principal.kind === "run" ? { ...data, runId: principal.runId } : data,
  });
}

export const versionConflict = (what: string, current: number, base: number) =>
  new ConflictError(
    "VERSION_CONFLICT",
    current === 0
      ? `${what} chưa có, không sửa được từ phiên bản ${base}. Lưu với phiên bản gốc 0 để tạo mới.`
      : `${what} đã ở phiên bản ${current}, bạn sửa từ phiên bản ${base}. Tải bản mới nhất, gộp thay đổi rồi lưu lại.`,
  );

export const iso = (d: Date) => d.toISOString();
