import { implement } from "@orpc/server";
import {
  contract,
  type ProjectSdlcSettings,
  projectSdlcSettings,
  type ReviewGate,
  type ReviewPhase,
  SDLC_MAX_PROJECTS,
  type SdlcItemDetail,
  sdlcItemRef,
} from "@xdev-hive/contracts";
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
import { type OrgDeps, orgMiddlewares, teamMemberIds, teams } from "../tenancy/index.ts";
import {
  activeItemProjects,
  itemForUser,
  itemViewers,
  requireItemManage,
  requireProjectWrite,
  type SdlcItemRow,
} from "./access.ts";
import { sdlcItemProjects, sdlcItemTasks } from "./schema.ts";

/*
 * Dự án tham gia của hạng mục (specs/011 D19). Mọi dự án, kể cả dự án chính, có một dòng `sdlc_item_projects` chụp cài
 * đặt AI SDLC của dự án lúc thêm: chặn, đồng bộ, song song, nhãn, nơi chạy, tự duyệt theo bản chụp, để quản trị dự án
 * đổi cài đặt giữa chừng không đổi luật của hạng mục đang chạy.
 */

export type ItemProjectRole = "home" | "participant";

export interface ResolvedItemProject {
  project: ProjectRow;
  role: ItemProjectRole;
  settings: ProjectSdlcSettings;
}

export interface ParticipantDeps {
  jobs?: Jobs | undefined;
  /** Địa chỉ web để link trong thông báo. */
  publicUrl?: string | undefined;
  /**
   * Tạo tài liệu `scope: project` cho dự án vừa thêm; logic dựng tài liệu theo khuôn nằm ở items.ts (T012), nên gắn
   * qua deps thay vì gọi thẳng.
   */
  onProjectAdded?: ((tx: Tx, item: SdlcItemRow, project: ProjectRow) => Promise<void>) | undefined;
}

/** Cài đặt AI SDLC của dự án đã điền mặc định; dự án chưa có mục `sdlc` coi như chưa bật. */
export function sdlcSettingsOf(project: ProjectRow): ProjectSdlcSettings {
  return projectSdlcSettings.parse(project.settings.sdlc ?? {});
}

/** Dự án dùng được trong hạng mục: đang hoạt động (không lưu trữ, không dở khởi tạo) và đã bật AI SDLC. */
export function sdlcEnabled(project: ProjectRow): boolean {
  return project.state === "active" && sdlcSettingsOf(project).enabled;
}

const disabled = (p: ProjectRow) =>
  new ConflictError("SDLC_PROJECT_DISABLED", `Dự án ${p.key} chưa bật AI SDLC; quản trị dự án cần bật trước.`);
const tooMany = () => new BadRequestError("SDLC_TOO_MANY_PROJECTS", `Hạng mục có tối đa ${SDLC_MAX_PROJECTS} dự án.`);
const closed = () =>
  new ConflictError("SDLC_ITEM_CLOSED", "Hạng mục đã xong hoặc đã huỷ, không đổi dự án tham gia được.");

/**
 * Kiểm dự án của `items.create` (US1-6): tối đa 8, cùng tổ chức (RLS: dự án tổ chức khác coi như không có), người tạo có
 * `sdlc.write` ở đội của mọi dự án, mọi dự án đã bật AI SDLC. Thiếu một thì từ chối cả yêu cầu, chưa ghi gì.
 */
export async function resolveItemProjects(
  tx: Tx,
  userId: string,
  input: { projectId: string; participants?: readonly string[] | undefined },
): Promise<ResolvedItemProject[]> {
  const participants = input.participants ?? [];
  if (participants.includes(input.projectId) || new Set(participants).size !== participants.length)
    throw new BadRequestError("SDLC_DUPLICATE_PROJECT", "Dự án tham gia trùng nhau hoặc trùng dự án chính.");
  if (participants.length + 1 > SDLC_MAX_PROJECTS) throw tooMany();
  const projects = await requireProjectWrite(tx, userId, [input.projectId, ...participants], "sdlc.write");
  for (const p of projects) if (!sdlcEnabled(p)) throw disabled(p);
  return projects.map((project) => ({
    project,
    role: project.id === input.projectId ? "home" : "participant",
    settings: sdlcSettingsOf(project),
  }));
}

/** Ghi dòng dự án cho hạng mục vừa tạo, trong transaction của items.create. */
export async function insertItemProjects(
  tx: Tx,
  itemId: string,
  resolved: readonly ResolvedItemProject[],
  userId: string,
): Promise<void> {
  if (resolved.length === 0) return;
  await tx.insert(sdlcItemProjects).values(
    resolved.map((r) => ({
      orgId: sql`hive.ctx_org()`,
      itemId,
      projectId: r.project.id,
      teamId: r.project.teamId,
      role: r.role,
      settings: r.settings,
      addedBy: userId,
    })),
  );
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
  if (!sdlcEnabled(project)) throw disabled(project);
  const current = await activeItemProjects(tx, item.id);
  if (current.some((p) => p.projectId === project.id))
    throw new ConflictError("SDLC_PROJECT_ALREADY_ADDED", `Dự án ${project.key} đã tham gia hạng mục.`);
  if (current.length >= SDLC_MAX_PROJECTS) throw tooMany();
  const settings = sdlcSettingsOf(project);
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
  await deps.onProjectAdded?.(tx, item, project);
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
  const home = await loadProject(tx, item.projectId);
  const ref = `${home?.key ?? ""}-${sdlcItemRef(item.number)}`;
  await notify(
    tx,
    {
      orgId: item.orgId,
      event: "sdlc.project_added",
      title: `Dự án ${project.key} được thêm vào hạng mục ${ref}`,
      body: `Hạng mục “${item.title}” (${ref}) giờ có dự án ${project.key} tham gia; đội của bạn duyệt và làm phần việc của dự án này.`,
      eventKey: `sdlc:${item.id}:project_added:${project.id}:${Date.now()}`,
      recipientIds,
      link: home ? itemLink(deps.publicUrl, home.key, item) : null,
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

// ---- Cổng theo đội (D21) -----------------------------------------------------------------------------------------

export interface ItemTeam {
  teamId: string;
  slug: string;
  name: string;
  /** Dự án của đội trong hạng mục, dự án chính trước. */
  projects: { id: string; key: string; name: string }[];
}

/** Đội có dự án đang tham gia hạng mục, gộp dự án cùng đội; đội chủ trì đứng đầu. */
export async function itemTeams(tx: Tx, itemId: string): Promise<ItemTeam[]> {
  const rows = await activeItemProjects(tx, itemId);
  if (rows.length === 0) return [];
  const teamRows = await tx
    .select({ id: teams.id, slug: teams.slug, name: teams.name })
    .from(teams)
    .where(
      inArray(
        teams.id,
        rows.map((r) => r.teamId),
      ),
    );
  const byId = new Map(teamRows.map((t) => [t.id, t]));
  const out = new Map<string, ItemTeam>();
  for (const r of rows) {
    const team = byId.get(r.teamId);
    if (!team) continue;
    const project = await loadProject(tx, r.projectId);
    const entry = out.get(team.id) ?? { teamId: team.id, slug: team.slug, name: team.name, projects: [] };
    entry.projects.push({ id: r.projectId, key: project?.key ?? r.projectId, name: project?.name ?? "" });
    out.set(team.id, entry);
  }
  // Dự án tạo cùng lúc có cùng added_at; xếp theo tên/key (dự án chính, đội chủ trì vẫn đứng đầu) để checkpoint không
  // đổi thứ tự hay tên giữa hai lần mở phiên.
  const byName = (x: string, y: string) => x.localeCompare(y, "vi");
  const homeId = rows[0]?.projectId;
  for (const t of out.values())
    t.projects.sort((x, y) => Number(y.id === homeId) - Number(x.id === homeId) || byName(x.key, y.key));
  const [home, ...rest] = [...out.values()];
  return home ? [home, ...rest.sort((x, y) => byName(x.name, y.name))] : [];
}

const GATE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** Id checkpoint `<gate>-<teamSlug>`; quá 40 ký tự hay trùng thì dùng số thứ tự đội để vẫn hợp lệ với `reviewGate`. */
function teamGateId(gateId: string, team: ItemTeam, index: number, used: Set<string>): string {
  const wanted = `${gateId}-${team.slug}`;
  const id = GATE_ID.test(wanted) && !used.has(wanted) ? wanted : `${gateId.slice(0, 36)}-${index + 1}`;
  used.add(id);
  return id;
}

/**
 * D21: mỗi checkpoint người có id trong `perProjectGates` nhân thành một checkpoint cho mỗi đội tham gia, `roles` tính
 * trong đội đó qua `reviewers.teamScope`. Giai đoạn đạt khi mọi checkpoint đạt, như mọi cổng nhiều checkpoint của spec
 * 004. Một đội thì giữ nguyên: đội của tài liệu đã là đội chủ trì.
 */
export function expandPerProjectGates(
  phases: readonly ReviewPhase[],
  perProjectGates: readonly string[],
  itemTeamList: readonly ItemTeam[],
): ReviewPhase[] {
  if (perProjectGates.length === 0 || itemTeamList.length <= 1) return phases.map((p) => ({ ...p }));
  const wanted = new Set(perProjectGates);
  return phases.map((phase) => {
    const used = new Set(phase.gates.map((g) => g.id));
    const gates = phase.gates.flatMap((gate): ReviewGate[] => {
      if (gate.kind !== "human" || !wanted.has(gate.id)) return [gate];
      used.delete(gate.id);
      return itemTeamList.map((team, i) => ({
        ...gate,
        id: teamGateId(gate.id, team, i, used),
        name: clip(`${gate.name} · ${team.name} (${team.projects.map((p) => p.key).join(", ")})`, 120),
        reviewers: {
          users: gate.reviewers?.users ?? [],
          roles: gate.reviewers?.roles ?? [],
          teams: gate.reviewers?.teams ?? [],
          quorum: gate.reviewers?.quorum ?? 1,
          ...(gate.reviewers?.allowRequester === undefined ? {} : { allowRequester: gate.reviewers.allowRequester }),
          teamScope: team.teamId,
        },
      }));
    });
    return { ...phase, gates };
  });
}

/** Quy trình của phiên duyệt với cổng theo đội; danh sách đội chụp lúc gọi (lúc mở phiên). */
export async function perTeamWorkflow(
  tx: Tx,
  itemId: string,
  phases: readonly ReviewPhase[],
  perProjectGates: readonly string[],
): Promise<ReviewPhase[]> {
  if (perProjectGates.length === 0) return phases.map((p) => ({ ...p }));
  return expandPerProjectGates(phases, perProjectGates, await itemTeams(tx, itemId));
}

// ---- Route `items.projects.*` --------------------------------------------------------------------------------------

export interface ParticipantRouteDeps extends OrgDeps, ParticipantDeps {
  /** Chi tiết hạng mục do items.ts (T012) dựng; route trả chi tiết sau khi đổi như contract. */
  itemDetail: (tx: Tx, userId: string, itemId: string) => Promise<SdlcItemDetail>;
}

/** Hàm đăng ký riêng để router.ts chỉ thêm một dòng `projects: participantRoutes(deps)` (T070 gộp). */
export function participantRoutes(deps: ParticipantRouteDeps) {
  const { authed, inOrg } = orgMiddlewares(deps);
  const os = implement(contract.sdlc.items.projects).$context<RequestContext>().use(authed);
  return {
    add: os.add.use(inOrg).handler(async ({ context: { tx, user }, input }) => {
      await addItemProject(tx, user.id, input, deps);
      return deps.itemDetail(tx, user.id, input.id);
    }),
    remove: os.remove.use(inOrg).handler(async ({ context: { tx, user }, input }) => {
      await removeItemProject(tx, user.id, input);
      return deps.itemDetail(tx, user.id, input.id);
    }),
  };
}
