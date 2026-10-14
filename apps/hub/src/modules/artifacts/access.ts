import {
  ARTIFACT_ERRORS,
  type ArtifactAccess,
  type ArtifactErrorCode,
  type ArtifactErrorData,
  type ArtifactLinkKind,
  type ArtifactScope,
} from "@xdev-hive/contracts";
import { and, eq, inArray, ne, or, type SQL, sql } from "drizzle-orm";
import { recordAudit } from "../audit/index.ts";
import { findProject } from "../catalog/index.ts";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, type Tx } from "../platform/index.ts";
import { type OrgRole, orgRoleOf, type TeamRole, teamRolesOf } from "../tenancy/index.ts";
import { artifactLinks, artifacts } from "./schema.ts";

/*
 * Quyền trên artifact (plan.md "Permissions & Authorization", FR-020…FR-024, FR-032). RLS chỉ tách tổ chức; phạm vi
 * cá nhân/dự án/đội lọc ở đây, và mọi đường đọc (route, MCP, tìm, liên kết) dùng cùng `visibleArtifactsWhere` để không
 * đường nào lộ artifact ngoài phạm vi (SC-002). Quyền tính lại mỗi lần gọi để người rời đội mất quyền ngay.
 */

// ---- Lỗi -----------------------------------------------------------------------------------------------------------

/** Chi tiết đi kèm mã lỗi (`findings`, `latest`, `limit`…); router đưa vào `data` của lỗi oRPC. */
export type ArtifactErrorDetail = Omit<NonNullable<ArtifactErrorData>, "code">;

type DomainError = ForbiddenError | NotFoundError | ConflictError | BadRequestError;
const ERROR_CLASS = {
  FORBIDDEN: ForbiddenError,
  NOT_FOUND: NotFoundError,
  CONFLICT: ConflictError,
  BAD_REQUEST: BadRequestError,
} as const;

/**
 * Lỗi `ARTIFACT_*` là lỗi nghiệp vụ thường của platform (lớp API nào cũng đổi được), thêm `detail` để router artifact và
 * tool MCP trả được dòng bí mật, bản mới nhất khi xung đột, giới hạn đã chạm.
 */
export function artifactError(
  code: ArtifactErrorCode,
  message?: string,
  detail?: ArtifactErrorDetail,
): DomainError & { detail?: ArtifactErrorDetail } {
  const def = ARTIFACT_ERRORS[code];
  const error: DomainError & { detail?: ArtifactErrorDetail } = new ERROR_CLASS[def.status](
    code,
    message ?? def.message,
  );
  if (detail) error.detail = detail;
  return error;
}

export const artifactNotFound = () => artifactError("ARTIFACT_NOT_FOUND");

// ---- Ai đang gọi ---------------------------------------------------------------------------------------------------

/**
 * Người dùng (web, app, PAT) hoặc run gọi qua MCP. `userId` của run là người mở cuộc trò chuyện (run `leader`) hay người
 * bấm chạy; `threadId` do tool MCP điền sau khi `ThreadHost.assertRunThread` xác nhận.
 */
export type Principal =
  | { kind: "user"; userId: string }
  | {
      kind: "run";
      runId: string;
      runKind: string;
      projectId: string;
      userId: string | null;
      taskId: string | null;
      threadId: string | null;
    };

export interface UserReader {
  kind: "user";
  userId: string;
  orgRole: OrgRole;
  /** Đội và vai trò; owner/admin tổ chức là quản trị mọi đội (`teamRolesOf`). */
  teams: Map<string, TeamRole>;
}

export interface RunReader {
  kind: "run";
  runId: string;
  runKind: string;
  projectId: string;
  teamId: string;
  taskId: string | null;
  threadId: string | null;
  /** Người run làm thay; null khi run không có người hay người đó đã rời tổ chức. */
  actor: UserReader | null;
}

export type Reader = UserReader | RunReader;

async function userReader(tx: Tx, userId: string): Promise<UserReader | null> {
  const orgRole = await orgRoleOf(tx, userId);
  if (!orgRole) return null;
  return { kind: "user", userId, orgRole, teams: await teamRolesOf(tx, userId) };
}

export async function readerFor(tx: Tx, principal: Principal): Promise<Reader> {
  if (principal.kind === "user") {
    const reader = await userReader(tx, principal.userId);
    if (!reader) throw new ForbiddenError("NOT_ORG_MEMBER", "Bạn không phải thành viên của tổ chức này.");
    return reader;
  }
  const project = await findProject(tx, principal.projectId);
  if (!project) throw new ForbiddenError("RUN_PROJECT_MISSING", "Run không còn thuộc dự án nào trong tổ chức.");
  return {
    kind: "run",
    runId: principal.runId,
    runKind: principal.runKind,
    projectId: project.id,
    teamId: project.teamId,
    taskId: principal.taskId,
    threadId: principal.threadId,
    actor: principal.userId ? await userReader(tx, principal.userId) : null,
  };
}

/** Người đứng sau thao tác, để ghi tác giả, chủ, audit. */
export const readerUserId = (reader: Reader): string | null =>
  reader.kind === "user" ? reader.userId : (reader.actor?.userId ?? null);

// ---- Bộ lọc đọc ----------------------------------------------------------------------------------------------------

/** Đích liên kết cho run thấy và sửa artifact: chính run, task của run, cuộc trò chuyện của run (FR-032). */
export function runTargets(reader: RunReader): { kind: ArtifactLinkKind; id: string }[] {
  const out: { kind: ArtifactLinkKind; id: string }[] = [{ kind: "run", id: reader.runId }];
  if (reader.taskId) out.push({ kind: "task", id: reader.taskId });
  if (reader.threadId) out.push({ kind: "chat_thread", id: reader.threadId });
  return out;
}

function linkedTo(targets: { kind: ArtifactLinkKind; id: string }[]): SQL {
  const match = or(
    ...targets.map((t) => and(eq(artifactLinks.targetKind, t.kind), eq(artifactLinks.targetId, t.id))),
  ) as SQL;
  return sql`exists (select 1 from ${artifactLinks} where ${and(eq(artifactLinks.artifactId, artifacts.id), match)})`;
}

/**
 * Điều kiện "người gọi đọc được artifact này" cho truy vấn trên `artifacts` (D2). Người: chủ, hoặc thành viên đội của
 * phạm vi `project`/`team`, hoặc phạm vi `org`. Quản trị tổ chức không có nhánh riêng nên không đọc `private` của người
 * khác (C5). Run: phạm vi dự án của run, và artifact gắn với run/task/cuộc trò chuyện của run nhưng không bao giờ là
 * `private` của người khác người run làm thay.
 */
export function visibleArtifactsWhere(reader: Reader): SQL {
  if (reader.kind === "user") {
    const teamIds = [...reader.teams.keys()];
    return or(
      eq(artifacts.ownerUserId, reader.userId),
      eq(artifacts.scope, "org"),
      teamIds.length
        ? and(inArray(artifacts.scope, ["project", "team"]), inArray(artifacts.teamId, teamIds))
        : undefined,
    ) as SQL;
  }
  const notOthersPrivate = reader.actor
    ? or(ne(artifacts.scope, "private"), eq(artifacts.ownerUserId, reader.actor.userId))
    : ne(artifacts.scope, "private");
  return or(
    and(eq(artifacts.scope, "project"), eq(artifacts.projectId, reader.projectId)),
    and(linkedTo(runTargets(reader)), notOthersPrivate),
  ) as SQL;
}

/** Như `visibleArtifactsWhere` nhưng chỉ những artifact người gọi quản trị được (thùng rác). Run không quản trị. */
export function manageableArtifactsWhere(reader: Reader): SQL {
  if (reader.kind === "run") return sql`false`;
  const adminTeams = [...reader.teams].filter(([, role]) => role === "admin").map(([id]) => id);
  return or(
    eq(artifacts.ownerUserId, reader.userId),
    isOrgAdmin(reader.orgRole) ? eq(artifacts.scope, "org") : undefined,
    adminTeams.length
      ? and(inArray(artifacts.scope, ["project", "team"]), inArray(artifacts.teamId, adminTeams))
      : undefined,
  ) as SQL;
}

// ---- Bảng quyền ----------------------------------------------------------------------------------------------------

export type ArtifactAction = "read" | "write" | "manage" | "own";

/** Phần của artifact cần để xét quyền. */
export interface ArtifactFacts {
  ownerUserId: string;
  scope: ArtifactScope;
  teamId: string | null;
  projectId: string | null;
  /** Chủ còn là thành viên tổ chức; `private` của người đã rời thì quản trị tổ chức dọn được. */
  ownerActive: boolean;
  /** Gắn với chính run đang gọi (run đã tạo), hay với task/cuộc trò chuyện của run. Chỉ dùng cho run. */
  linkedToRun: boolean;
  linkedToRunWork: boolean;
}

const TEAM_RANK: Record<TeamRole, number> = { viewer: 1, ba: 2, member: 3, admin: 4 };
const isOrgAdmin = (role: OrgRole) => role === "admin" || role === "owner";
const scopedTeam = (facts: ArtifactFacts) =>
  facts.scope === "project" || facts.scope === "team" ? facts.teamId : null;

function userCan(reader: UserReader, facts: ArtifactFacts, action: ArtifactAction): boolean {
  const owner = facts.ownerUserId === reader.userId;
  const teamId = scopedTeam(facts);
  const teamRole = teamId ? reader.teams.get(teamId) : undefined;
  switch (action) {
    case "own":
      return owner;
    case "read":
      return owner || facts.scope === "org" || teamRole !== undefined;
    case "write":
      return owner || facts.scope === "org" || (teamRole !== undefined && TEAM_RANK[teamRole] >= TEAM_RANK.member);
    case "manage":
      return (
        owner ||
        teamRole === "admin" ||
        (facts.scope === "org" && isOrgAdmin(reader.orgRole)) ||
        (facts.scope === "private" && !facts.ownerActive && isOrgAdmin(reader.orgRole))
      );
  }
}

function runCan(reader: RunReader, facts: ArtifactFacts, action: ArtifactAction): boolean {
  const othersPrivate = facts.scope === "private" && facts.ownerUserId !== reader.actor?.userId;
  const read =
    (facts.scope === "project" && facts.projectId === reader.projectId) ||
    ((facts.linkedToRun || facts.linkedToRunWork) && !othersPrivate);
  switch (action) {
    case "read":
      return read;
    // Run sửa artifact nó tạo; artifact gắn với task/cuộc trò chuyện thì chỉ khi người run làm thay sửa được (US9-5).
    case "write":
      return (
        read &&
        (facts.linkedToRun || (facts.linkedToRunWork && !!reader.actor && userCan(reader.actor, facts, "write")))
      );
    // Đổi phạm vi, chủ, xoá và link công khai luôn cần người (FR-021, C17).
    case "manage":
    case "own":
      return false;
  }
}

/** Bảng quyền thuần, không chạm database (access.test.ts kiểm từng ô). */
export function can(reader: Reader, facts: ArtifactFacts, action: ArtifactAction): boolean {
  return reader.kind === "user" ? userCan(reader, facts, action) : runCan(reader, facts, action);
}

type ArtifactRow = typeof artifacts.$inferSelect;

/** Đọc từ database phần `ArtifactFacts` mà dòng artifact chưa có (chủ còn trong tổ chức, liên kết với run). */
export async function factsFor(tx: Tx, reader: Reader, row: ArtifactRow): Promise<ArtifactFacts> {
  let linkedToRun = false;
  let linkedToRunWork = false;
  if (reader.kind === "run") {
    const links = await tx
      .select({ kind: artifactLinks.targetKind, id: artifactLinks.targetId })
      .from(artifactLinks)
      .where(eq(artifactLinks.artifactId, row.id));
    for (const t of runTargets(reader)) {
      if (!links.some((l) => l.kind === t.kind && l.id === t.id)) continue;
      if (t.kind === "run") linkedToRun = true;
      else linkedToRunWork = true;
    }
  }
  const ownerActive =
    row.scope !== "private" ||
    readerUserId(reader) === row.ownerUserId ||
    (await orgRoleOf(tx, row.ownerUserId)) !== null;
  return {
    ownerUserId: row.ownerUserId,
    scope: row.scope,
    teamId: row.teamId,
    projectId: row.projectId,
    ownerActive,
    linkedToRun,
    linkedToRunWork,
  };
}

/**
 * Đòi quyền `action`. Không có quyền và không đọc được thì báo như không tồn tại để không dò được id; đọc được mà thiếu
 * quyền thì 403.
 */
export async function assertCan(
  tx: Tx,
  reader: Reader,
  row: ArtifactRow,
  action: ArtifactAction,
): Promise<ArtifactFacts> {
  const facts = await factsFor(tx, reader, row);
  // `manage` không kéo theo `read`: quản trị tổ chức dọn `private` của người đã rời mà không đọc nội dung (C5).
  if (can(reader, facts, action)) return facts;
  if (!can(reader, facts, "read")) throw artifactNotFound();
  throw new ForbiddenError(
    "ARTIFACT_FORBIDDEN",
    action === "write"
      ? "Bạn chỉ đọc được artifact này. Nhân bản để sửa bản riêng."
      : action === "own"
        ? ARTIFACT_ERRORS.ARTIFACT_LINK_OWNER_ONLY.message
        : "Chỉ chủ artifact hoặc quản trị của phạm vi mới làm được việc này.",
  );
}

export function accessView(reader: Reader, facts: ArtifactFacts): ArtifactAccess {
  return { write: can(reader, facts, "write"), manage: can(reader, facts, "manage"), owner: can(reader, facts, "own") };
}

// ---- Audit ---------------------------------------------------------------------------------------------------------

/** Ghi audit kèm ai gọi; run không có người dùng trong context nên ghi runId vào data. Không bao giờ ghi nội dung. */
export function audit(
  tx: Tx,
  reader: Reader,
  action: string,
  artifactId: string | undefined,
  data: Record<string, unknown> = {},
): Promise<string> {
  return recordAudit(tx, {
    action,
    actorUserId: readerUserId(reader),
    targetType: "artifact",
    targetId: artifactId,
    data: reader.kind === "run" ? { ...data, runId: reader.runId } : data,
  });
}
