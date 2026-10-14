import { implement } from "@orpc/server";
import { contract, type SdlcOverride } from "@xdev-hive/contracts";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { recordAudit } from "../audit/index.ts";
import { loadProject } from "../catalog/index.ts";
import { authUser } from "../identity/index.ts";
import { notify } from "../notify/index.ts";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  type Jobs,
  NotFoundError,
  type RequestContext,
  type Tx,
} from "../platform/index.ts";
import { effectivePermissions, notificationRecipients, type OrgDeps, orgMiddlewares } from "../tenancy/index.ts";
import { sdlcItemProjects, sdlcItems, sdlcItemTasks, sdlcOverrides } from "./schema.ts";

type OverrideRow = typeof sdlcOverrides.$inferSelect;
type ItemRow = typeof sdlcItems.$inferSelect;

export const OVERRIDE_PERMISSION = "sdlc.override";

export interface OverrideInput {
  itemId: string;
  taskId?: string | undefined;
  projectId?: string | undefined;
  reason: string;
  expiresAt?: string | undefined;
}

const itemNotFound = () => new NotFoundError("SDLC_ITEM_NOT_FOUND", "Không tìm thấy hạng mục.");

async function namesOf(tx: Tx, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ id: authUser.id, name: authUser.name })
    .from(authUser)
    .where(inArray(authUser.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, r.name]));
}

export async function overrideViews(tx: Tx, rows: OverrideRow[], now = new Date()): Promise<SdlcOverride[]> {
  const names = await namesOf(
    tx,
    rows.flatMap((r) => (r.revokedBy ? [r.decidedBy, r.revokedBy] : [r.decidedBy])),
  );
  const person = (userId: string) => ({ userId, name: names.get(userId) ?? userId });
  return rows.map((r) => ({
    id: r.id,
    itemId: r.itemId,
    taskId: r.taskId,
    projectId: r.projectId,
    reason: r.reason,
    decidedBy: person(r.decidedBy),
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt?.toISOString() ?? null,
    revokedAt: r.revokedAt?.toISOString() ?? null,
    revokedBy: r.revokedBy ? person(r.revokedBy) : null,
    active: !r.revokedAt && (!r.expiresAt || r.expiresAt > now),
  }));
}

/** Ngoại lệ của hạng mục, mới nhất trước, cho chi tiết hạng mục. */
export async function listOverrides(tx: Tx, itemId: string): Promise<SdlcOverride[]> {
  const rows = await tx.select().from(sdlcOverrides).where(eq(sdlcOverrides.itemId, itemId));
  rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return overrideViews(tx, rows);
}

/** Đội của các dự án mà ngoại lệ phủ: một task, một dự án, hoặc mọi dự án còn trong hạng mục. */
async function scopeTeams(
  tx: Tx,
  itemId: string,
  scope: { taskId: string | null; projectId: string | null },
): Promise<{ teamId: string; projectKey: string }[]> {
  const members = await tx
    .select({ projectId: sdlcItemProjects.projectId })
    .from(sdlcItemProjects)
    .where(and(eq(sdlcItemProjects.itemId, itemId), isNull(sdlcItemProjects.removedAt)));
  let projectIds = members.map((m) => m.projectId);
  if (scope.taskId) {
    const [link] = await tx
      .select({ projectId: sdlcItemTasks.projectId })
      .from(sdlcItemTasks)
      .where(and(eq(sdlcItemTasks.itemId, itemId), eq(sdlcItemTasks.taskId, scope.taskId)));
    // Task đã rời hạng mục (dòng bị xoá theo task): rơi về mọi đội để ngoại lệ mồ côi vẫn thu hồi được.
    if (link) projectIds = [link.projectId];
  } else if (scope.projectId) {
    projectIds = [scope.projectId];
  }
  const out: { teamId: string; projectKey: string }[] = [];
  for (const id of projectIds) {
    const project = await loadProject(tx, id);
    if (project) out.push({ teamId: project.teamId, projectKey: project.key });
  }
  return out;
}

async function loadItem(tx: Tx, itemId: string): Promise<ItemRow> {
  const [item] = await tx.select().from(sdlcItems).where(eq(sdlcItems.id, itemId));
  if (!item) throw itemNotFound();
  return item;
}

/** `all`: phạm vi cả hạng mục cần quyền ở mọi đội (FR-051); `any`: thu hồi chỉ cần một đội, vì thu hồi chỉ siết lại. */
async function requireOverridePermission(
  tx: Tx,
  userId: string,
  targets: { teamId: string; projectKey: string }[],
  mode: "all" | "any",
): Promise<void> {
  const held = new Map<string, boolean>();
  for (const { teamId } of targets) {
    if (!held.has(teamId)) held.set(teamId, (await effectivePermissions(tx, userId, teamId)).has(OVERRIDE_PERMISSION));
  }
  const missing = targets.filter((t) => !held.get(t.teamId));
  const ok = mode === "all" ? missing.length === 0 : missing.length < targets.length;
  if (targets.length === 0 || !ok) {
    const where = (mode === "all" ? missing : targets).map((t) => t.projectKey).join(", ");
    throw new ForbiddenError(
      "SDLC_OVERRIDE_FORBIDDEN",
      `Cần quyền ${OVERRIDE_PERMISSION} ở đội của dự án ${where || "của hạng mục"}.`,
    );
  }
}

async function notifyOverride(
  tx: Tx,
  jobs: Jobs | undefined,
  item: ItemRow,
  row: OverrideRow,
  action: "create" | "revoke",
  by: string,
): Promise<void> {
  const admins = await notificationRecipients(tx);
  const scope = row.taskId ? "một task" : row.projectId ? "một dự án" : "cả hạng mục";
  const who = (await namesOf(tx, [by])).get(by) ?? by;
  const created = action === "create";
  await notify(
    tx,
    {
      orgId: item.orgId,
      event: "sdlc.override",
      eventKey: `sdlc.override:${action}:${row.id}`,
      recipientIds: [...new Set([...admins, item.ownerUserId])],
      title: `${created ? "Ngoại lệ chặn" : "Thu hồi ngoại lệ"} · ${item.title}`,
      body: [
        `${who} ${created ? "cho phép run code chạy khi chưa đủ tài liệu" : "đã thu hồi ngoại lệ"} (phạm vi ${scope}).`,
        `Lý do: ${row.reason}`,
        row.expiresAt && created ? `Hết hạn: ${row.expiresAt.toISOString()}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    },
    { jobs },
  );
}

/**
 * Tạo ngoại lệ chặn (FR-030). Người tạo cần `sdlc.override` ở đội của dự án mà ngoại lệ phủ; phạm vi cả hạng mục cần ở
 * mọi đội còn tham gia, vì quyền ở hạng mục không thay quyền ở dự án (D22).
 */
export async function createOverride(
  tx: Tx,
  userId: string,
  input: OverrideInput,
  deps: { jobs?: Jobs | undefined } = {},
): Promise<SdlcOverride> {
  const reason = input.reason.trim();
  if (reason.length < 10) throw new BadRequestError("SDLC_OVERRIDE_REASON", "Lý do ngoại lệ cần ít nhất 10 ký tự.");
  if (input.taskId && input.projectId)
    throw new BadRequestError("SDLC_OVERRIDE_SCOPE", "Chọn một phạm vi: task, dự án, hoặc cả hạng mục.");
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  if (expiresAt && !(expiresAt > new Date()))
    throw new BadRequestError("SDLC_OVERRIDE_EXPIRY", "Hạn của ngoại lệ phải ở tương lai.");

  const item = await loadItem(tx, input.itemId);
  if (item.status === "done" || item.status === "cancelled")
    throw new ConflictError("SDLC_ITEM_CLOSED", "Hạng mục đã đóng, không tạo ngoại lệ được.");
  const taskId = input.taskId ?? null;
  const projectId = input.projectId ?? null;
  if (taskId) {
    const [link] = await tx
      .select({ taskId: sdlcItemTasks.taskId })
      .from(sdlcItemTasks)
      .where(and(eq(sdlcItemTasks.itemId, item.id), eq(sdlcItemTasks.taskId, taskId)));
    if (!link) throw new NotFoundError("SDLC_TASK_NOT_IN_ITEM", "Task không thuộc hạng mục này.");
  }
  if (projectId) {
    const [member] = await tx
      .select({ projectId: sdlcItemProjects.projectId })
      .from(sdlcItemProjects)
      .where(
        and(
          eq(sdlcItemProjects.itemId, item.id),
          eq(sdlcItemProjects.projectId, projectId),
          isNull(sdlcItemProjects.removedAt),
        ),
      );
    if (!member) throw new NotFoundError("SDLC_PROJECT_NOT_IN_ITEM", "Dự án không tham gia hạng mục này.");
  }

  await requireOverridePermission(tx, userId, await scopeTeams(tx, item.id, { taskId, projectId }), "all");

  const [row] = await tx
    .insert(sdlcOverrides)
    .values({ orgId: item.orgId, itemId: item.id, taskId, projectId, reason, decidedBy: userId, expiresAt })
    .returning();
  if (!row) throw new Error("Không tạo được ngoại lệ.");
  await recordAudit(tx, {
    action: "sdlc.override.create",
    targetType: "sdlc_item",
    targetId: item.id,
    data: {
      overrideId: row.id,
      itemId: item.id,
      taskId,
      projectId,
      scope: taskId ? "task" : projectId ? "project" : "item",
      reason,
      expiresAt: expiresAt?.toISOString() ?? null,
    },
  });
  await notifyOverride(tx, deps.jobs, item, row, "create", userId);
  return (await overrideViews(tx, [row]))[0] as SdlcOverride;
}

/** Thu hồi ngoại lệ còn hiệu lực. Chỉ cần `sdlc.override` ở một đội mà ngoại lệ phủ, vì thu hồi chỉ làm cổng chặt lại. */
export async function revokeOverride(
  tx: Tx,
  userId: string,
  id: string,
  deps: { jobs?: Jobs | undefined } = {},
): Promise<SdlcOverride> {
  // Khoá dòng để hai người thu hồi cùng lúc không cùng ghi audit.
  const [row] = await tx.select().from(sdlcOverrides).where(eq(sdlcOverrides.id, id)).for("update");
  if (!row) throw new NotFoundError("SDLC_OVERRIDE_NOT_FOUND", "Không tìm thấy ngoại lệ.");
  const item = await loadItem(tx, row.itemId);
  await requireOverridePermission(tx, userId, await scopeTeams(tx, item.id, row), "any");
  if (row.revokedAt) throw new ConflictError("SDLC_OVERRIDE_INACTIVE", "Ngoại lệ đã được thu hồi.");
  if (row.expiresAt && row.expiresAt <= new Date())
    throw new ConflictError("SDLC_OVERRIDE_INACTIVE", "Ngoại lệ đã hết hạn.");

  const [updated] = await tx
    .update(sdlcOverrides)
    .set({ revokedAt: new Date(), revokedBy: userId })
    .where(eq(sdlcOverrides.id, id))
    .returning();
  if (!updated) throw new Error("Không thu hồi được ngoại lệ.");
  await recordAudit(tx, {
    action: "sdlc.override.revoke",
    targetType: "sdlc_item",
    targetId: item.id,
    data: { overrideId: id, itemId: item.id, taskId: row.taskId, projectId: row.projectId },
  });
  await notifyOverride(tx, deps.jobs, item, updated, "revoke", userId);
  return (await overrideViews(tx, [updated]))[0] as SdlcOverride;
}

/** Route `overrides.*`; T070 gộp vào router của module để file này không đụng `router.ts` chung. */
export function overrideRoutes(deps: OrgDeps & { jobs?: Jobs | undefined }) {
  const { authed, inOrg } = orgMiddlewares(deps);
  const os = implement(contract.sdlc.overrides).$context<RequestContext>().use(authed).use(inOrg);
  return {
    overrides: {
      create: os.create.handler(({ context: { tx, user }, input }) =>
        createOverride(tx, user.id, input, { jobs: deps.jobs }),
      ),
      revoke: os.revoke.handler(({ context: { tx, user }, input }) =>
        revokeOverride(tx, user.id, input.id, { jobs: deps.jobs }),
      ),
    },
  };
}
