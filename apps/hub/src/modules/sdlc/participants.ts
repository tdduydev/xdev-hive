import { implement } from "@orpc/server";
import { contract, type ProjectSdlcSettings, SDLC_MAX_PROJECTS, sdlcItemRef } from "@xdev-hive/contracts";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { recordAudit } from "../audit/index.ts";
import { loadProject, type ProjectRow } from "../catalog/index.ts";
import { notify } from "../notify/index.ts";
import {
  BadRequestError,
  ConflictError,
  type Jobs,
  NotFoundError,
  type RequestContext,
  type Tx,
} from "../platform/index.ts";
import { loadTask, setTaskStatus } from "../tasks/index.ts";
import { type OrgDeps, orgMiddlewares, teamMemberIds } from "../tenancy/index.ts";
import {
  activeItemProjects,
  itemForUser,
  itemViewers,
  requireItemManage,
  requireProjectWrite,
  type SdlcItemRow,
} from "./access.ts";
import { insertArtifacts, itemDetail, planArtifacts, sdlcSettingsOf } from "./items.ts";
import { sdlcItemProjects, sdlcItemTasks } from "./schema.ts";

/*
 * Dự án tham gia của hạng mục (specs/011 D19). Mọi dự án, kể cả dự án chính, có một dòng `sdlc_item_projects` chụp cài
 * đặt AI SDLC của dự án lúc thêm: chặn, đồng bộ, song song, nhãn, nơi chạy, tự duyệt theo bản chụp, để quản trị dự án
 * đổi cài đặt giữa chừng không đổi luật của hạng mục đang chạy.
 */

export interface ParticipantDeps {
  jobs?: Jobs | undefined;
  /** Địa chỉ web để link trong thông báo. */
  publicUrl?: string | undefined;
}

/** Như kiểm dự án của items.create (cùng mã lỗi): dự án đang hoạt động và đã bật AI SDLC; trả cài đặt để chụp. */
function requireSdlcProject(project: ProjectRow): ProjectSdlcSettings {
  if (project.state === "archived") throw new ConflictError("PROJECT_ARCHIVED", `Dự án ${project.key} đã lưu trữ.`);
  if (project.state !== "active")
    throw new ConflictError("PROJECT_NOT_READY", `Dự án ${project.key} chưa khởi tạo xong.`);
  const settings = sdlcSettingsOf(project);
  if (!settings.enabled)
    throw new BadRequestError(
      "SDLC_NOT_ENABLED",
      `Dự án ${project.key} chưa bật AI SDLC; quản trị dự án cần bật trước.`,
    );
  return settings;
}

const tooMany = () => new BadRequestError("SDLC_TOO_MANY_PROJECTS", `Hạng mục có tối đa ${SDLC_MAX_PROJECTS} dự án.`);
const closed = () =>
  new ConflictError("SDLC_ITEM_CLOSED", "Hạng mục đã xong hoặc đã huỷ, không đổi dự án tham gia được.");

/**
 * Tài liệu `scope: project` của dự án vừa thêm, lập như lúc tạo hạng mục (đường dẫn `<home>-<NNN>` trong repo tham gia).
 * Tài liệu đã có từ lần tham gia trước được giữ nguyên (insertArtifacts bỏ qua key trùng).
 */
async function addProjectArtifacts(
  tx: Tx,
  userId: string,
  item: SdlcItemRow,
  home: ProjectRow,
  project: ProjectRow,
  settings: ProjectSdlcSettings,
): Promise<void> {
  const plan = planArtifacts(item.mode, {
    home: { id: home.id, key: home.key, settings: item.settings },
    projects: [{ id: project.id, key: project.key, settings }],
    number: item.number,
    slug: item.slug,
    date: item.createdAt.toISOString().slice(0, 10),
  }).filter((a) => a.scope === "project" && a.projectId === project.id);
  await insertArtifacts(tx, userId, item, plan);
}

function itemLink(publicUrl: string | undefined, homeKey: string, item: SdlcItemRow): string | null {
  return publicUrl ? `${publicUrl.replace(/\/+$/, "")}/sdlc/${homeKey}/${sdlcItemRef(item.number)}` : null;
}

/** Hạng mục đang mở, khoá hàng để hai người thêm cùng lúc không vượt giới hạn 8 dự án. */
async function openItemForManage(tx: Tx, userId: string, itemId: string): Promise<SdlcItemRow> {
  const item = await itemForUser(tx, userId, itemId, true);
  if (item.status === "done" || item.status === "cancelled") throw closed();
  await requireItemManage(tx, userId, item);
  return item;
}

/**
 * `items.projects.add` (US16-1): chủ hạng mục hoặc quản trị đội chủ trì, có `sdlc.write` ở đội của dự án mới; dự án đã
 * bật AI SDLC; tối đa 8. Dự án từng bị bỏ thì thêm lại, chụp lại cài đặt hiện tại.
 */
export async function addItemProject(
  tx: Tx,
  userId: string,
  input: { id: string; projectId: string },
  deps: ParticipantDeps = {},
): Promise<void> {
  const item = await openItemForManage(tx, userId, input.id);
  const [project] = await requireProjectWrite(tx, userId, [input.projectId], "sdlc.write");
  if (!project) throw new NotFoundError("PROJECT_NOT_FOUND", "Không tìm thấy dự án trong tổ chức.");
  const settings = requireSdlcProject(project);
  const current = await activeItemProjects(tx, item.id);
  if (current.some((p) => p.projectId === project.id))
    throw new ConflictError("SDLC_PROJECT_ALREADY_ADDED", `Dự án ${project.key} đã tham gia hạng mục.`);
  if (current.length >= SDLC_MAX_PROJECTS) throw tooMany();
  const home = await loadProject(tx, item.projectId);
  if (!home) throw new NotFoundError("PROJECT_NOT_FOUND", "Không tìm thấy dự án chính của hạng mục.");
  await tx
    .insert(sdlcItemProjects)
    .values({
      orgId: sql`hive.ctx_org()`,
      itemId: item.id,
      projectId: project.id,
      teamId: project.teamId,
      role: "participant",
      settings,
      addedBy: userId,
    })
    .onConflictDoUpdate({
      target: [sdlcItemProjects.itemId, sdlcItemProjects.projectId],
      set: { teamId: project.teamId, settings, addedBy: userId, addedAt: sql`now()`, removedAt: null },
    });
  await addProjectArtifacts(tx, userId, item, home, project, settings);
  await recordAudit(tx, {
    action: "sdlc.item.project_add",
    targetType: "sdlc_item",
    targetId: item.id,
    data: { projectId: project.id, projectKey: project.key, teamId: project.teamId },
  });
  // Quản trị đội của dự án mới cần biết đội mình vừa có việc trong hạng mục của đội khác.
  const admins = (await teamMemberIds(tx, project.teamId, "admin")).filter((id) => id !== userId);
  const recipientIds = await itemViewers(tx, item, admins);
  if (recipientIds.length === 0) return;
  const ref = `${home.key}-${sdlcItemRef(item.number)}`;
  await notify(
    tx,
    {
      orgId: item.orgId,
      event: "sdlc.project_added",
      title: `Dự án ${project.key} được thêm vào hạng mục ${ref}`,
      body: `Hạng mục “${item.title}” (${ref}) giờ có dự án ${project.key} tham gia; đội của bạn duyệt và làm phần việc của dự án này.`,
      eventKey: `sdlc:${item.id}:project_added:${project.id}:${Date.now()}`,
      recipientIds,
      link: itemLink(deps.publicUrl, home.key, item),
    },
    { jobs: deps.jobs },
  );
}

/**
 * `items.projects.remove` (US16-2, D19): chỉ bỏ được dự án chưa có task nào từng chạy trong hạng mục; task `todo` của
 * dự án bị huỷ. Giữ dòng với `removed_at` để audit và truy vết còn biết dự án đã từng tham gia.
 */
export async function removeItemProject(
  tx: Tx,
  userId: string,
  input: { id: string; projectId: string },
): Promise<{ cancelledTaskIds: string[] }> {
  const item = await openItemForManage(tx, userId, input.id);
  const current = await activeItemProjects(tx, item.id);
  const row = current.find((p) => p.projectId === input.projectId);
  if (!row) throw new NotFoundError("SDLC_ITEM_PROJECT_NOT_FOUND", "Dự án không tham gia hạng mục.");
  if (row.role === "home") throw new ConflictError("SDLC_HOME_PROJECT", "Không bỏ được dự án chính của hạng mục.");
  const [project] = await requireProjectWrite(tx, userId, [input.projectId], "sdlc.write");
  if (!project) throw new NotFoundError("PROJECT_NOT_FOUND", "Không tìm thấy dự án trong tổ chức.");
  const itemTasks = await tx
    .select({
      taskId: sdlcItemTasks.taskId,
      removed: sdlcItemTasks.removed,
      // Như tasks.ts: sdlc không import runs (runs gọi sdlc ở queueRun), nên hỏi bảng runs bằng SQL.
      ran: sql<boolean>`exists (select 1 from hive.runs r where r.task_id = ${sdlcItemTasks.taskId})`,
    })
    .from(sdlcItemTasks)
    .where(and(eq(sdlcItemTasks.itemId, item.id), eq(sdlcItemTasks.projectId, input.projectId)));
  if (itemTasks.some((t) => t.ran))
    throw new ConflictError(
      "SDLC_PROJECT_HAS_RUNS",
      `Dự án ${project.key} đã có task chạy trong hạng mục; huỷ task trước.`,
    );
  const cancelledTaskIds: string[] = [];
  for (const t of itemTasks) {
    if (t.removed) continue;
    const task = await loadTask(tx, t.taskId);
    if (task?.status !== "todo") continue;
    await setTaskStatus(tx, t.taskId, "cancelled");
    cancelledTaskIds.push(t.taskId);
  }
  const taskIds = itemTasks.map((t) => t.taskId);
  if (taskIds.length > 0)
    await tx
      .update(sdlcItemTasks)
      .set({ removed: true })
      .where(and(eq(sdlcItemTasks.itemId, item.id), inArray(sdlcItemTasks.taskId, taskIds)));
  await tx
    .update(sdlcItemProjects)
    .set({ removedAt: sql`now()` })
    .where(
      and(
        eq(sdlcItemProjects.itemId, item.id),
        eq(sdlcItemProjects.projectId, input.projectId),
        isNull(sdlcItemProjects.removedAt),
      ),
    );
  await recordAudit(tx, {
    action: "sdlc.item.project_remove",
    targetType: "sdlc_item",
    targetId: item.id,
    data: { projectId: project.id, projectKey: project.key, cancelledTaskIds },
  });
  return { cancelledTaskIds };
}

// ---- Route `items.projects.*` --------------------------------------------------------------------------------------

/** Hàm đăng ký riêng để router.ts chỉ thêm một dòng `projects: participantRoutes(deps)` (T070 gộp). */
export function participantRoutes(deps: OrgDeps & ParticipantDeps) {
  const { authed, inOrg } = orgMiddlewares(deps);
  const os = implement(contract.sdlc.items.projects).$context<RequestContext>().use(authed);
  return {
    add: os.add.use(inOrg).handler(async ({ context: { tx, user }, input }) => {
      await addItemProject(tx, user.id, input, deps);
      return itemDetail(tx, user.id, input.id);
    }),
    remove: os.remove.use(inOrg).handler(async ({ context: { tx, user }, input }) => {
      await removeItemProject(tx, user.id, input);
      return itemDetail(tx, user.id, input.id);
    }),
  };
}
