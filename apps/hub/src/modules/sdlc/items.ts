import {
  checkRepoPath,
  type ProjectSdlcSettings,
  projectSdlcSettings,
  renderRepoPath,
  SDLC_PHASE_KINDS,
  type SdlcItemCreate,
  type SdlcItemDetail,
  type SdlcItemSummary,
  type SdlcMode,
  type SdlcPhaseKind,
  type SdlcSuggestion,
  sdlcDocKey,
  sdlcItemCreate,
  sdlcItemGetInput,
  sdlcItemListInput,
  sdlcItemRef,
  sdlcSlug,
  sdlcSuggestInput,
} from "@xdev-hive/contracts";
import { and, asc, desc, eq, inArray, isNull, lt, or, type SQL, sql } from "drizzle-orm";
import type { z } from "zod";
import { recordAudit } from "../audit/index.ts";
import { findProject, loadProject, type ProjectRow } from "../catalog/index.ts";
import { authUser } from "../identity/index.ts";
import { saveDraft } from "../knowledge/index.ts";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, type Tx } from "../platform/index.ts";
import { loadConnection } from "../scm/index.ts";
import { teamRoleOf, teams } from "../tenancy/index.ts";
import {
  canManageItem,
  hasTeamPermission,
  requireItemManage,
  requireItemRead,
  requireProjectWrite,
  visibleItemsWhere,
} from "./access.ts";
import { resolveMode } from "./modes.ts";
import {
  initialPhases,
  lockItem,
  SDLC_QUEUE,
  type SdlcDeps,
  type SdlcItemRow,
  type SdlcJob,
  scheduleAdvance,
} from "./phases.ts";
import {
  sdlcArtifactSyncs,
  sdlcArtifacts,
  sdlcItemPhases,
  sdlcItemProjects,
  sdlcItems,
  sdlcOverrides,
  sdlcQuestions,
  sdlcSteps,
} from "./schema.ts";
import { type SuggestMode, suggestSdlc } from "./suggest.ts";

/*
 * Hạng mục AI SDLC (spec 011 US1, FR-006..FR-008): tạo từ ý tưởng hoặc issue, tạm dừng, tiếp tục, huỷ, đổi chế độ, và
 * các view cho bảng, danh sách, chi tiết. Phân quyền ở `access.ts`; giai đoạn ở `phases.ts`.
 */

const OPEN = ["active", "paused"] as const;

/** Cài đặt AI SDLC của dự án; dự án chưa có mục này coi như chưa bật. */
export function sdlcSettingsOf(project: ProjectRow): ProjectSdlcSettings {
  const parsed = projectSdlcSettings.safeParse(project.settings.sdlc ?? {});
  return parsed.success ? parsed.data : projectSdlcSettings.parse({});
}

/** Chế độ dự án cho dùng: danh sách khai, cộng chế độ mặc định (danh sách rỗng là chỉ chế độ mặc định). */
export function allowedModes(settings: ProjectSdlcSettings): string[] {
  return [...new Set([...settings.modes, ...(settings.defaultMode ? [settings.defaultMode] : [])])];
}

function requireSdlcProject(project: ProjectRow): ProjectSdlcSettings {
  if (project.state === "archived") throw new ConflictError("PROJECT_ARCHIVED", `Dự án ${project.key} đã lưu trữ.`);
  if (project.state !== "active")
    throw new ConflictError("PROJECT_NOT_READY", `Dự án ${project.key} chưa khởi tạo xong.`);
  const settings = sdlcSettingsOf(project);
  if (!settings.enabled) throw new BadRequestError("SDLC_NOT_ENABLED", `Dự án ${project.key} chưa bật AI SDLC.`);
  return settings;
}

async function requireProject(tx: Tx, id: string): Promise<ProjectRow> {
  const project = await loadProject(tx, id);
  if (!project) throw new NotFoundError("PROJECT_NOT_FOUND", "Không tìm thấy dự án.");
  return project;
}

// ---- Issue -------------------------------------------------------------------------------------------------------

/**
 * Số issue từ link (GitHub `/o/r/issues/12`, GitLab `/o/r/-/issues/12`); null khi link không thuộc repo của dự án, để
 * không gắn hạng mục vào issue của repo khác.
 */
export function issueNumberOf(
  url: string,
  repo: { repoOwner: string; repoName: string; repoWebUrl: string | null },
): number | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const m = /^\/(.+?)\/(?:-\/)?issues\/(\d+)\/?$/.exec(u.pathname);
  if (!m?.[1] || !m[2]) return null;
  if (m[1].toLowerCase() !== `${repo.repoOwner}/${repo.repoName}`.toLowerCase()) return null;
  if (repo.repoWebUrl && URL.canParse(repo.repoWebUrl) && new URL(repo.repoWebUrl).host !== u.host) return null;
  return Number(m[2]);
}

async function itemOfIssue(tx: Tx, projectId: string, issueNumber: number) {
  const [row] = await tx
    .select({ number: sdlcItems.number })
    .from(sdlcItems)
    .where(
      and(
        eq(sdlcItems.projectId, projectId),
        sql`${sdlcItems.source}->>'kind' = 'issue'`,
        sql`${sdlcItems.source}->>'issueNumber' = ${String(issueNumber)}`,
      ),
    );
  return row ?? null;
}

const issueTaken = (number: number) =>
  new ConflictError("SDLC_ISSUE_TAKEN", `Issue này đã có hạng mục ${sdlcItemRef(number)}.`);

// ---- Tài liệu ----------------------------------------------------------------------------------------------------

/** Tài liệu sẽ tạo cho một dự án của hạng mục. */
export interface PlannedArtifact {
  phaseId: string;
  artifactId: string;
  name: string;
  required: boolean;
  scope: "item" | "project";
  instance: string;
  projectId: string;
  projectKey: string;
  docKey: string;
  repoPath: string;
  /** Thư mục riêng của hạng mục trong repo (đoạn đầu có biến); null khi khuôn chỉ có biến ở tên file. */
  itemDir: string | null;
  template: string | null;
}

/** Thư mục riêng của hạng mục: tới đoạn đầu tiên có biến, vì thư mục cha (`specs/`) là của mọi hạng mục. */
function itemDirOf(template: string, rendered: string): string | null {
  const t = template.split("/");
  const at = t.findIndex((s) => s.includes("{"));
  if (at < 0 || at === t.length - 1) return null;
  return rendered
    .split("/")
    .slice(0, at + 1)
    .join("/");
}

/**
 * Tài liệu của mọi giai đoạn cho các dự án: `item` một bản ở dự án chính, `project` một bản mỗi dự án (repo không phải
 * dự án chính thay `{NNN}` bằng `<home>-<NNN>`, D20). Contract chưa có bản nào lúc tạo (D23, T016).
 */
export function planArtifacts(
  mode: SdlcMode,
  ctx: {
    home: { id: string; key: string; settings: ProjectSdlcSettings };
    projects: { id: string; key: string; settings: ProjectSdlcSettings }[];
    number: number;
    slug: string;
    date: string;
  },
): PlannedArtifact[] {
  const base = { number: ctx.number, slug: ctx.slug, date: ctx.date };
  const common = { homeKey: ctx.home.key, number: ctx.number, slug: ctx.slug };
  const rooted = (root: string | undefined, path: string) => (root ? `${root.replace(/\/+$/, "")}/${path}` : path);
  const out: PlannedArtifact[] = [];
  for (const phase of mode.phases)
    for (const a of phase.artifacts) {
      if (a.scope === "contract") continue;
      const targets = a.scope === "project" ? ctx.projects : [ctx.home];
      for (const p of targets) {
        const template = rooted(p.settings.docsRoot, a.path);
        const vars = p.id === ctx.home.id ? base : { ...base, homeKey: ctx.home.key };
        const repoPath = renderRepoPath(template, a.perUnit ? { ...vars, unit: "unit-1" } : vars);
        out.push({
          phaseId: phase.id,
          artifactId: a.id,
          name: a.name,
          required: a.required,
          scope: a.scope,
          instance: a.scope === "project" ? p.key : "",
          projectId: p.id,
          projectKey: p.key,
          docKey: sdlcDocKey({ ...common, artifactId: a.id, scope: a.scope, instance: p.key }),
          repoPath,
          itemDir: itemDirOf(template, repoPath),
          template: a.template ?? null,
        });
      }
    }
  return out;
}

/**
 * Đường dẫn của hạng mục mới không được trùng file trong repo hay tài liệu của hạng mục khác (edge case "hai hạng mục
 * cùng đường dẫn"). Đọc cây repo bằng nhà cung cấp Git ngay trong transaction vì phải từ chối trước khi ghi; không
 * đọc được repo (thiếu khoá chủ, lỗi mạng) thì bỏ qua phần repo, job đồng bộ sẽ báo nếu ghi đè.
 */
async function rejectPathConflicts(
  tx: Tx,
  deps: SdlcDeps,
  projects: ProjectRow[],
  plan: PlannedArtifact[],
): Promise<void> {
  for (const a of plan) {
    const bad = checkRepoPath(a.repoPath);
    if (bad) throw new BadRequestError("SDLC_PATH_INVALID", `${bad} (${a.repoPath})`);
  }
  if (plan.length) {
    const [taken] = await tx
      .select({ path: sdlcArtifactSyncs.repoPath })
      .from(sdlcArtifactSyncs)
      .where(
        or(
          ...plan.map((a) =>
            and(eq(sdlcArtifactSyncs.projectId, a.projectId), eq(sdlcArtifactSyncs.repoPath, a.repoPath)),
          ),
        ),
      );
    if (taken) throw new ConflictError("SDLC_PATH_TAKEN", `Đường dẫn ${taken.path} đã thuộc một hạng mục khác.`);
  }
  if (!deps.providerFactory || !deps.masterKey) return;
  for (const project of projects) {
    const mine = plan.filter((a) => a.projectId === project.id);
    if (!mine.length) continue;
    let files: string[];
    try {
      const conn = await loadConnection(tx, deps.masterKey, project.scmConnectionId);
      if (!conn) continue;
      const provider = deps.providerFactory(conn);
      const ref = { owner: project.repoOwner, name: project.repoName };
      const head = await provider.branchHead(ref, project.defaultBranch ?? "main");
      if (!head) continue;
      files = await provider.listFiles(ref, head);
    } catch {
      continue;
    }
    for (const a of mine) {
      const clash = files.find((f) => f === a.repoPath || (a.itemDir !== null && f.startsWith(`${a.itemDir}/`)));
      if (clash)
        throw new ConflictError(
          "SDLC_REPO_PATH_EXISTS",
          `Thư mục ${a.itemDir ?? a.repoPath} đã có trong repo ${project.key}. Dùng “Nhận thư mục có sẵn làm hạng mục” nếu đây là tài liệu đã viết.`,
        );
    }
  }
}

/**
 * Bản nháp đầu theo khuôn của chế độ (US1-4), dưới tên người tạo. Người tạo không soạn được tài liệu của đội đó, hay
 * key đã có bản nháp (đổi chế độ giữ cùng tài liệu) thì giữ nguyên: khuôn chỉ là chỗ bắt đầu, không bắt buộc.
 */
async function seedDraft(tx: Tx, userId: string, item: SdlcItemRow, a: PlannedArtifact): Promise<void> {
  if (!a.template) return;
  try {
    await saveDraft(
      tx,
      { kind: "user", userId },
      {
        key: a.docKey,
        title: `${a.name} · ${sdlcItemRef(item.number)} ${item.title}`.slice(0, 200),
        content: a.template,
        revision: 0,
      },
    );
  } catch (e) {
    if (!(e instanceof ForbiddenError) && !(e instanceof ConflictError)) throw e;
  }
}

/** Ghi tài liệu đã lập: dòng `sdlc_artifacts`, dòng đồng bộ nguồn ở repo giữ file, bản nháp theo khuôn. */
export async function insertArtifacts(
  tx: Tx,
  userId: string,
  item: SdlcItemRow,
  plan: PlannedArtifact[],
): Promise<void> {
  for (const a of plan) {
    const [row] = await tx
      .insert(sdlcArtifacts)
      .values({
        orgId: item.orgId,
        projectId: a.projectId,
        itemId: item.id,
        phaseId: a.phaseId,
        artifactId: a.artifactId,
        required: a.required,
        scope: a.scope,
        instance: a.instance,
        docKey: a.docKey,
        repoPath: a.repoPath,
      })
      .returning({ id: sdlcArtifacts.id });
    if (!row) continue;
    await tx.insert(sdlcArtifactSyncs).values({
      orgId: item.orgId,
      artifactId: row.id,
      projectId: a.projectId,
      kind: "source",
      repoPath: a.repoPath,
    });
    await seedDraft(tx, userId, item, a);
  }
}

// ---- Tạo ---------------------------------------------------------------------------------------------------------

export interface CreateItemOptions {
  /** `leader`: hành động `sdlc.item.create` đã duyệt; người duyệt là chủ (US1-5). */
  sourceKind?: "manual" | "leader" | undefined;
}

export async function createItem(
  tx: Tx,
  userId: string,
  raw: SdlcItemCreate,
  deps: SdlcDeps = {},
  opts: CreateItemOptions = {},
): Promise<SdlcItemDetail> {
  const input: z.output<typeof sdlcItemCreate> = sdlcItemCreate.parse(raw);
  const home = await requireProject(tx, input.projectId);
  const participants = await Promise.all(input.participants.map((id) => requireProject(tx, id)));
  const all = [home, ...participants];
  await requireProjectWrite(
    tx,
    userId,
    all.map((p) => p.id),
  );
  const settingsOf = new Map(all.map((p) => [p.id, requireSdlcProject(p)] as const));
  const settings = settingsOf.get(home.id) ?? sdlcSettingsOf(home);
  if (!allowedModes(settings).includes(input.modeRef))
    throw new BadRequestError("SDLC_MODE_NOT_ALLOWED", "Dự án không cho dùng chế độ này.");
  const mode = await resolveMode(tx, input.modeRef, home.teamId);
  if (!mode)
    throw new NotFoundError("SDLC_MODE_NOT_FOUND", `Không tìm thấy chế độ ${input.modeRef} hoặc chế độ đã tắt.`);

  let issueNumber: number | null = null;
  if (input.issueUrl) {
    issueNumber = issueNumberOf(input.issueUrl, home);
    if (issueNumber === null)
      throw new BadRequestError("SDLC_ISSUE_INVALID", `Link issue không thuộc repo của dự án ${home.key}.`);
    const taken = await itemOfIssue(tx, home.id, issueNumber);
    if (taken) throw issueTaken(taken.number);
  }

  // Khoá theo dự án chính tới hết transaction để hai hạng mục tạo cùng lúc không lấy cùng số (FR-008).
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`sdlc_items:${home.id}`}, 0))`);
  const [{ next } = { next: 1 }] = await tx
    .select({ next: sql<number>`coalesce(max(${sdlcItems.number}), 0)::int + 1` })
    .from(sdlcItems)
    .where(eq(sdlcItems.projectId, home.id));
  const slug = sdlcSlug(input.title);
  const date = new Date().toISOString().slice(0, 10);
  const withSettings = (p: ProjectRow) => ({ id: p.id, key: p.key, settings: settingsOf.get(p.id) ?? settings });
  const plan = planArtifacts(mode.definition, {
    home: withSettings(home),
    projects: all.map(withSettings),
    number: next,
    slug,
    date,
  });
  await rejectPathConflicts(tx, deps, all, plan);

  const phases = initialPhases(mode.definition, input.size);
  const [item] = await tx
    .insert(sdlcItems)
    .values({
      orgId: sql`hive.ctx_org()`,
      teamId: home.teamId,
      projectId: home.id,
      number: next,
      slug,
      title: input.title,
      idea: input.idea,
      source: {
        kind: issueNumber !== null ? "issue" : (opts.sourceKind ?? "manual"),
        url: input.issueUrl ?? null,
        issueNumber,
        path: null,
      },
      modeRef: mode.ref,
      mode: mode.definition,
      settings,
      sizeSuggested: input.suggestion?.size ?? null,
      size: input.size,
      suggestion: input.suggestion ?? null,
      phaseIndex: phases.index,
      ownerUserId: userId,
      createdBy: userId,
    })
    // Hai người nhận cùng một issue: chỉ mục `sdlc_items_issue` chặn người sau mà không làm hỏng transaction.
    .onConflictDoNothing()
    .returning();
  if (!item) {
    const taken = issueNumber !== null ? await itemOfIssue(tx, home.id, issueNumber) : null;
    if (taken) throw issueTaken(taken.number);
    throw new ConflictError("SDLC_ITEM_CONFLICT", "Không tạo được hạng mục, thử lại.");
  }

  await tx.insert(sdlcItemProjects).values(
    all.map((p) => ({
      orgId: item.orgId,
      itemId: item.id,
      projectId: p.id,
      teamId: p.teamId,
      role: p.id === home.id ? ("home" as const) : ("participant" as const),
      settings: settingsOf.get(p.id) ?? settings,
      addedBy: userId,
    })),
  );
  await tx.insert(sdlcItemPhases).values(
    phases.rows.map((r) => ({
      orgId: item.orgId,
      itemId: item.id,
      ...r,
      startedAt: r.status === "drafting" ? new Date() : null,
    })),
  );
  await insertArtifacts(tx, userId, item, plan);

  await recordAudit(tx, {
    action: "sdlc.item.create",
    targetType: "sdlc_item",
    targetId: item.id,
    data: {
      projectId: home.id,
      number: item.number,
      participants: participants.map((p) => p.id),
      source: item.source.kind,
      issueNumber,
      // FR-007: ghi cả gợi ý và lựa chọn cuối để đo độ khớp của gợi ý.
      suggestion: input.suggestion ?? null,
      chosen: { modeRef: mode.ref, size: input.size },
    },
  });
  if (issueNumber !== null && deps.jobs)
    await deps.jobs.enqueue(
      SDLC_QUEUE,
      { kind: "issue-comment", orgId: item.orgId, itemId: item.id } satisfies SdlcJob,
      { tx },
    );
  await scheduleAdvance(tx, item, deps);
  return itemDetail(tx, userId, item.id);
}

// ---- Gợi ý -------------------------------------------------------------------------------------------------------

export async function suggestItem(tx: Tx, userId: string, raw: unknown): Promise<SdlcSuggestion> {
  const input = sdlcSuggestInput.parse(raw);
  const project = await requireProject(tx, input.projectId);
  await requireProjectWrite(tx, userId, [project.id]);
  const settings = requireSdlcProject(project);
  const modes: SuggestMode[] = [];
  for (const ref of allowedModes(settings)) {
    const m = await resolveMode(tx, ref, project.teamId);
    if (m)
      modes.push({ ref: m.ref, name: m.definition.name, sizes: m.definition.sizes, profile: m.definition.profile });
  }
  const [first, ...rest] = modes;
  if (!first) throw new BadRequestError("SDLC_NO_MODES", `Dự án ${project.key} chưa có chế độ AI SDLC nào dùng được.`);
  return suggestSdlc({
    title: input.title,
    idea: input.idea,
    riskKeywords: settings.riskKeywords,
    modes: [first, ...rest],
    defaultMode: settings.defaultMode,
  });
}

// ---- Trạng thái --------------------------------------------------------------------------------------------------

async function lockForManage(tx: Tx, userId: string, id: string): Promise<SdlcItemRow> {
  const item = await lockItem(tx, id);
  if (!item) throw new NotFoundError("SDLC_ITEM_NOT_FOUND", "Không tìm thấy hạng mục.");
  await requireItemManage(tx, userId, item);
  return item;
}

/** Tạm dừng: không tạo run mới; bước đang chạy vẫn chạy xong. */
export async function pauseItem(tx: Tx, userId: string, id: string): Promise<SdlcItemDetail> {
  const item = await lockForManage(tx, userId, id);
  if (item.status !== "active")
    throw new ConflictError("SDLC_ITEM_NOT_ACTIVE", "Chỉ tạm dừng được hạng mục đang chạy.");
  await tx.update(sdlcItems).set({ status: "paused", updatedAt: sql`now()` }).where(eq(sdlcItems.id, id));
  await recordAudit(tx, { action: "sdlc.item.pause", targetType: "sdlc_item", targetId: id, data: {} });
  return itemDetail(tx, userId, id);
}

export async function resumeItem(tx: Tx, userId: string, id: string, deps: SdlcDeps = {}): Promise<SdlcItemDetail> {
  const item = await lockForManage(tx, userId, id);
  if (item.status !== "paused")
    throw new ConflictError("SDLC_ITEM_NOT_PAUSED", "Hạng mục không ở trạng thái tạm dừng.");
  await tx.update(sdlcItems).set({ status: "active", updatedAt: sql`now()` }).where(eq(sdlcItems.id, id));
  await recordAudit(tx, { action: "sdlc.item.resume", targetType: "sdlc_item", targetId: id, data: {} });
  await scheduleAdvance(tx, item, deps);
  return itemDetail(tx, userId, id);
}

/** Huỷ: bước chưa xong thành `cancelled`; task và run đã tạo giữ nguyên để người xem lại. */
export async function cancelItem(
  tx: Tx,
  userId: string,
  input: { id: string; reason?: string | undefined },
): Promise<SdlcItemDetail> {
  const item = await lockForManage(tx, userId, input.id);
  if (item.status !== "active" && item.status !== "paused")
    throw new ConflictError("SDLC_ITEM_CLOSED", "Hạng mục đã xong hoặc đã huỷ.");
  await tx.update(sdlcItems).set({ status: "cancelled", updatedAt: sql`now()` }).where(eq(sdlcItems.id, item.id));
  await tx
    .update(sdlcSteps)
    .set({ status: "cancelled", finishedAt: sql`now()` })
    .where(and(eq(sdlcSteps.itemId, item.id), inArray(sdlcSteps.status, ["queued", "running"])));
  await recordAudit(tx, {
    action: "sdlc.item.cancel",
    targetType: "sdlc_item",
    targetId: item.id,
    data: { reason: input.reason?.trim() || null },
  });
  return itemDetail(tx, userId, item.id);
}

/**
 * Đổi chế độ khi chưa tài liệu nào có baseline (edge case "dự án đổi chế độ mặc định"): dựng lại giai đoạn và tài liệu
 * theo chế độ mới. Bản nháp cùng key giữ nguyên nội dung người đã soạn.
 */
export async function changeItemMode(
  tx: Tx,
  userId: string,
  input: { id: string; modeRef: string },
  deps: SdlcDeps = {},
): Promise<SdlcItemDetail> {
  const item = await lockForManage(tx, userId, input.id);
  if (item.status !== "active" && item.status !== "paused")
    throw new ConflictError("SDLC_ITEM_CLOSED", "Hạng mục đã xong hoặc đã huỷ.");
  if (await hasBaseline(tx, item.id))
    throw new ConflictError("SDLC_MODE_LOCKED", "Chỉ đổi chế độ khi chưa có tài liệu nào được duyệt.");
  const [busy] = await tx
    .select({ id: sdlcSteps.id })
    .from(sdlcSteps)
    .where(and(eq(sdlcSteps.itemId, item.id), inArray(sdlcSteps.status, ["queued", "running"])));
  if (busy) throw new ConflictError("SDLC_STEP_RUNNING", "Đang có bước agent chạy; chờ bước xong rồi đổi chế độ.");
  if (input.modeRef === item.modeRef) return itemDetail(tx, userId, item.id);

  const members = await itemProjects(tx, item.id);
  const homeRow = members.find((m) => m.role === "home");
  const home = homeRow && (await loadProject(tx, homeRow.projectId));
  if (!home) throw new NotFoundError("PROJECT_NOT_FOUND", "Không tìm thấy dự án chính.");
  const settings = requireSdlcProject(home);
  if (!allowedModes(settings).includes(input.modeRef))
    throw new BadRequestError("SDLC_MODE_NOT_ALLOWED", "Dự án không cho dùng chế độ này.");
  const mode = await resolveMode(tx, input.modeRef, home.teamId);
  if (!mode)
    throw new NotFoundError("SDLC_MODE_NOT_FOUND", `Không tìm thấy chế độ ${input.modeRef} hoặc chế độ đã tắt.`);

  const projects: { id: string; key: string; settings: ProjectSdlcSettings }[] = [];
  for (const m of members) {
    const p = m.projectId === home.id ? home : await loadProject(tx, m.projectId);
    if (p) projects.push({ id: p.id, key: p.key, settings: m.settings });
  }
  const homeInfo = projects.find((p) => p.id === home.id) ?? { id: home.id, key: home.key, settings };
  const plan = planArtifacts(mode.definition, {
    home: homeInfo,
    projects,
    number: item.number,
    slug: item.slug,
    date: item.createdAt.toISOString().slice(0, 10),
  });
  // Tài liệu cũ của chính hạng mục sắp bị thay nên không tính là trùng.
  await tx.delete(sdlcArtifacts).where(eq(sdlcArtifacts.itemId, item.id));
  await tx.delete(sdlcItemPhases).where(eq(sdlcItemPhases.itemId, item.id));
  const loaded = (await Promise.all(projects.map((p) => loadProject(tx, p.id)))).filter((p): p is ProjectRow => !!p);
  await rejectPathConflicts(tx, deps, loaded, plan);

  const phases = initialPhases(mode.definition, item.size);
  const [updated] = await tx
    .update(sdlcItems)
    .set({ modeRef: mode.ref, mode: mode.definition, phaseIndex: phases.index, updatedAt: sql`now()` })
    .where(eq(sdlcItems.id, item.id))
    .returning();
  if (!updated) throw new NotFoundError("SDLC_ITEM_NOT_FOUND", "Không tìm thấy hạng mục.");
  await tx.insert(sdlcItemPhases).values(
    phases.rows.map((r) => ({
      orgId: item.orgId,
      itemId: item.id,
      ...r,
      startedAt: r.status === "drafting" ? new Date() : null,
    })),
  );
  await insertArtifacts(tx, userId, updated, plan);
  await recordAudit(tx, {
    action: "sdlc.item.change_mode",
    targetType: "sdlc_item",
    targetId: item.id,
    data: { from: item.modeRef, to: mode.ref },
  });
  if (updated.status === "active") await scheduleAdvance(tx, updated, deps);
  return itemDetail(tx, userId, item.id);
}

async function hasBaseline(tx: Tx, itemId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: sdlcArtifacts.id })
    .from(sdlcArtifacts)
    .where(and(eq(sdlcArtifacts.itemId, itemId), sql`${sdlcArtifacts.baselineVersion} is not null`))
    .limit(1);
  return Boolean(row);
}

// ---- View --------------------------------------------------------------------------------------------------------

type ItemProjectRow = typeof sdlcItemProjects.$inferSelect;

async function itemProjects(tx: Tx, itemId: string): Promise<ItemProjectRow[]> {
  return tx
    .select()
    .from(sdlcItemProjects)
    .where(and(eq(sdlcItemProjects.itemId, itemId), isNull(sdlcItemProjects.removedAt)));
}

/** Tên người dùng theo id; người đã xoá thì hiện id. */
async function namesOf(tx: Tx, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((v): v is string => !!v))];
  if (!wanted.length) return new Map();
  const rows = await tx
    .select({ id: authUser.id, name: authUser.name })
    .from(authUser)
    .where(inArray(authUser.id, wanted));
  return new Map(rows.map((r) => [r.id, r.name]));
}

const person = (names: Map<string, string>, userId: string) => ({ userId, name: names.get(userId) ?? userId });
const iso = (d: Date) => d.toISOString();
const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null);

/** Dữ liệu chung để dựng nhiều thẻ hạng mục trong vài truy vấn. */
interface SummaryContext {
  projects: Map<string, ProjectRow>;
  members: Map<string, ItemProjectRow[]>;
  phases: Map<string, (typeof sdlcItemPhases.$inferSelect)[]>;
  openQuestions: Map<string, number>;
  names: Map<string, string>;
}

async function summaryContext(tx: Tx, items: SdlcItemRow[]): Promise<SummaryContext> {
  const ids = items.map((i) => i.id);
  if (!ids.length)
    return { projects: new Map(), members: new Map(), phases: new Map(), openQuestions: new Map(), names: new Map() };
  const memberRows = await tx
    .select()
    .from(sdlcItemProjects)
    .where(and(inArray(sdlcItemProjects.itemId, ids), isNull(sdlcItemProjects.removedAt)));
  const projects = new Map<string, ProjectRow>();
  for (const pid of new Set([...items.map((i) => i.projectId), ...memberRows.map((m) => m.projectId)])) {
    const p = await loadProject(tx, pid);
    if (p) projects.set(pid, p);
  }
  const phaseRows = await tx
    .select()
    .from(sdlcItemPhases)
    .where(inArray(sdlcItemPhases.itemId, ids))
    .orderBy(asc(sdlcItemPhases.phaseIndex));
  const questions = await tx
    .select({ itemId: sdlcQuestions.itemId, n: sql<number>`count(*)::int` })
    .from(sdlcQuestions)
    .where(and(inArray(sdlcQuestions.itemId, ids), eq(sdlcQuestions.status, "open")))
    .groupBy(sdlcQuestions.itemId);
  const group = <T extends { itemId: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) m.set(r.itemId, [...(m.get(r.itemId) ?? []), r]);
    return m;
  };
  return {
    projects,
    members: group(memberRows),
    phases: group(phaseRows),
    openQuestions: new Map(questions.map((q) => [q.itemId, q.n])),
    names: await namesOf(
      tx,
      items.map((i) => i.ownerUserId),
    ),
  };
}

function toSummary(item: SdlcItemRow, ctx: SummaryContext): SdlcItemSummary {
  const home = ctx.projects.get(item.projectId);
  const phaseDef = item.mode.phases[item.phaseIndex];
  const phaseRow = ctx.phases.get(item.id)?.find((r) => r.phaseIndex === item.phaseIndex);
  const open = ctx.openQuestions.get(item.id) ?? 0;
  const members = [...(ctx.members.get(item.id) ?? [])].sort((a, b) =>
    a.role === b.role ? a.addedAt.getTime() - b.addedAt.getTime() : a.role === "home" ? -1 : 1,
  );
  const waitingFor =
    item.status === "paused"
      ? "Đang tạm dừng"
      : open
        ? `Chờ trả lời (${open})`
        : phaseRow?.status === "in_review"
          ? "Chờ duyệt"
          : null;
  return {
    id: item.id,
    project: { id: item.projectId, key: home?.key ?? "", name: home?.name ?? "" },
    number: item.number,
    ref: sdlcItemRef(item.number),
    slug: item.slug,
    title: item.title,
    modeRef: item.modeRef,
    modeName: item.mode.name,
    method: item.mode.method,
    size: item.size,
    status: item.status,
    phase:
      phaseDef && phaseRow && item.status !== "done" && item.status !== "cancelled"
        ? {
            id: phaseDef.id,
            name: phaseDef.name,
            kind: phaseDef.kind,
            status: phaseRow.status,
            index: item.phaseIndex,
            total: item.mode.phases.length,
          }
        : null,
    waitingFor,
    waitingMachine: false,
    openQuestions: open,
    projects: members.map((m) => {
      const p = ctx.projects.get(m.projectId);
      return { id: m.projectId, key: p?.key ?? "", name: p?.name ?? "", role: m.role };
    }),
    coverage: null,
    costUsd: null,
    owner: person(ctx.names, item.ownerUserId),
    createdAt: iso(item.createdAt),
    updatedAt: iso(item.updatedAt),
  };
}

/** Cursor của danh sách: (updated_at, id) của thẻ cuối, để trang sau không lặp hay sót khi có hạng mục vừa sửa. */
const encodeCursor = (item: SdlcItemRow) =>
  Buffer.from(`${item.updatedAt.toISOString()}|${item.id}`).toString("base64url");
function decodeCursor(cursor: string): { at: Date; id: string } | null {
  const [at, id] = Buffer.from(cursor, "base64url").toString().split("|");
  const date = at ? new Date(at) : null;
  return date && id && !Number.isNaN(date.getTime()) ? { at: date, id } : null;
}

const inProject = (projectId: string) =>
  sql`exists (select 1 from ${sdlcItemProjects} where ${sdlcItemProjects.itemId} = ${sdlcItems.id}
    and ${sdlcItemProjects.projectId} = ${projectId} and ${sdlcItemProjects.removedAt} is null)`;

const inPhaseKind = (kind: SdlcPhaseKind) =>
  sql`exists (select 1 from ${sdlcItemPhases} where ${sdlcItemPhases.itemId} = ${sdlcItems.id}
    and ${sdlcItemPhases.phaseIndex} = ${sdlcItems.phaseIndex} and ${sdlcItemPhases.kind} = ${kind})`;

export async function listItems(
  tx: Tx,
  userId: string,
  raw: unknown,
): Promise<{ items: SdlcItemSummary[]; nextCursor: string | null }> {
  const input = sdlcItemListInput.parse(raw);
  const where: (SQL | undefined)[] = [await visibleItemsWhere(tx, userId)];
  if (input.scope === "mine") where.push(or(eq(sdlcItems.ownerUserId, userId), eq(sdlcItems.createdBy, userId)));
  if (input.projectId) where.push(inProject(input.projectId));
  if (input.status) where.push(eq(sdlcItems.status, input.status));
  if (input.modeRef) where.push(eq(sdlcItems.modeRef, input.modeRef));
  if (input.phaseKind) where.push(inPhaseKind(input.phaseKind));
  const cursor = input.cursor ? decodeCursor(input.cursor) : null;
  if (cursor)
    where.push(
      or(lt(sdlcItems.updatedAt, cursor.at), and(eq(sdlcItems.updatedAt, cursor.at), lt(sdlcItems.id, cursor.id))),
    );
  const rows = await tx
    .select()
    .from(sdlcItems)
    .where(and(...where))
    .orderBy(desc(sdlcItems.updatedAt), desc(sdlcItems.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const ctx = await summaryContext(tx, page);
  const last = page.at(-1);
  return {
    items: page.map((r) => toSummary(r, ctx)),
    nextCursor: rows.length > input.limit && last ? encodeCursor(last) : null,
  };
}

const BOARD_LIMIT = 500;

/** Bảng theo loại giai đoạn chuẩn (FR-037): chế độ khác nhau vẫn chung cột. Chỉ hạng mục đang mở. */
export async function itemBoard(
  tx: Tx,
  userId: string,
  input: { projectId?: string | undefined; modeRef?: string | undefined },
): Promise<{ columns: { kind: SdlcPhaseKind; items: SdlcItemSummary[] }[] }> {
  const where: (SQL | undefined)[] = [await visibleItemsWhere(tx, userId), inArray(sdlcItems.status, [...OPEN])];
  if (input.projectId) where.push(inProject(input.projectId));
  if (input.modeRef) where.push(eq(sdlcItems.modeRef, input.modeRef));
  const rows = await tx
    .select()
    .from(sdlcItems)
    .where(and(...where))
    .orderBy(desc(sdlcItems.updatedAt))
    .limit(BOARD_LIMIT);
  const ctx = await summaryContext(tx, rows);
  const cards = rows.map((r) => toSummary(r, ctx));
  return {
    columns: SDLC_PHASE_KINDS.map((kind) => ({ kind, items: cards.filter((c) => c.phase?.kind === kind) })),
  };
}

export async function getItem(tx: Tx, userId: string, raw: unknown): Promise<SdlcItemDetail> {
  const input = sdlcItemGetInput.parse(raw);
  let id = input.id;
  if (!id && input.projectKey && input.number) {
    const project = await findProject(tx, input.projectKey);
    const [row] = project
      ? await tx
          .select({ id: sdlcItems.id })
          .from(sdlcItems)
          .where(and(eq(sdlcItems.projectId, project.id), eq(sdlcItems.number, input.number)))
      : [];
    id = row?.id;
  }
  if (!id) throw new NotFoundError("SDLC_ITEM_NOT_FOUND", "Không tìm thấy hạng mục.");
  return itemDetail(tx, userId, id);
}

const STEP_RUN_STATE = {
  queued: "queued",
  running: "running",
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
} as const;

/** Chi tiết hạng mục; người không đọc được thì báo không tồn tại. */
export async function itemDetail(tx: Tx, userId: string, id: string): Promise<SdlcItemDetail> {
  const [item] = await tx.select().from(sdlcItems).where(eq(sdlcItems.id, id));
  if (!item) throw new NotFoundError("SDLC_ITEM_NOT_FOUND", "Không tìm thấy hạng mục.");
  await requireItemRead(tx, userId, item);
  const ctx = await summaryContext(tx, [item]);
  const members = ctx.members.get(item.id) ?? [];
  const phaseRows = ctx.phases.get(item.id) ?? [];

  const artifacts = await tx
    .select()
    .from(sdlcArtifacts)
    .where(eq(sdlcArtifacts.itemId, item.id))
    .orderBy(asc(sdlcArtifacts.phaseId), asc(sdlcArtifacts.artifactId), asc(sdlcArtifacts.instance));
  const syncs = artifacts.length
    ? await tx
        .select()
        .from(sdlcArtifactSyncs)
        .where(
          inArray(
            sdlcArtifactSyncs.artifactId,
            artifacts.map((a) => a.id),
          ),
        )
    : [];
  const questions = await tx
    .select()
    .from(sdlcQuestions)
    .where(eq(sdlcQuestions.itemId, item.id))
    .orderBy(asc(sdlcQuestions.round), asc(sdlcQuestions.position));
  const steps = await tx
    .select()
    .from(sdlcSteps)
    .where(eq(sdlcSteps.itemId, item.id))
    .orderBy(asc(sdlcSteps.createdAt));
  const overrides = await tx
    .select()
    .from(sdlcOverrides)
    .where(eq(sdlcOverrides.itemId, item.id))
    .orderBy(desc(sdlcOverrides.createdAt));
  const names = await namesOf(tx, [
    item.ownerUserId,
    ...questions.map((q) => q.answeredBy),
    ...overrides.flatMap((o) => [o.decidedBy, o.revokedBy]),
  ]);
  const teamNames = new Map(
    (members.length
      ? await tx
          .select({ id: teams.id, name: teams.name })
          .from(teams)
          .where(
            inArray(
              teams.id,
              members.map((m) => m.teamId),
            ),
          )
      : []
    ).map((t) => [t.id, t.name]),
  );
  const keyOf = (projectId: string) => ctx.projects.get(projectId)?.key ?? "";
  const nameOfArtifact = new Map(item.mode.phases.flatMap((p) => p.artifacts.map((a) => [`${p.id}/${a.id}`, a.name])));
  const now = Date.now();

  const writable = await Promise.all(members.map((m) => hasTeamPermission(tx, userId, m.teamId, "sdlc.write")));
  const manage = await canManageItem(tx, userId, item);
  const open = item.status === "active" || item.status === "paused";
  const baselined = artifacts.some((a) => a.baselineVersion !== null);

  return {
    ...toSummary(item, ctx),
    idea: item.idea,
    source: item.source,
    mode: item.mode,
    sizeSuggested: item.sizeSuggested,
    suggestion: item.suggestion,
    settings: item.settings,
    projectsDetail: [...members]
      .sort((a, b) => (a.role === b.role ? 0 : a.role === "home" ? -1 : 1))
      .map((m) => {
        const p = ctx.projects.get(m.projectId);
        return {
          id: m.projectId,
          key: p?.key ?? "",
          name: p?.name ?? "",
          teamId: m.teamId,
          teamName: teamNames.get(m.teamId) ?? "",
          role: m.role,
          enabled: Boolean(p && p.state !== "archived" && sdlcSettingsOf(p).enabled),
          settings: m.settings,
          addedBy: m.addedBy,
          addedAt: iso(m.addedAt),
        };
      }),
    phases: item.mode.phases.map((p, index) => {
      const row = phaseRows.find((r) => r.phaseIndex === index);
      const required = artifacts.filter((a) => a.phaseId === p.id && a.required);
      return {
        id: p.id,
        index,
        name: p.name,
        kind: p.kind,
        optional: p.optional,
        status: row?.status ?? "pending",
        note: row?.note ?? null,
        requiredApproved: required.filter((a) => a.baselineVersion !== null && a.approval !== "revoked").length,
        requiredTotal: required.length,
        startedAt: isoOrNull(row?.startedAt ?? null),
        approvedAt: isoOrNull(row?.approvedAt ?? null),
      };
    }),
    artifacts: artifacts.map((a) => ({
      id: a.id,
      phaseId: a.phaseId,
      artifactId: a.artifactId,
      name: nameOfArtifact.get(`${a.phaseId}/${a.artifactId}`) ?? a.artifactId,
      scope: a.scope,
      instance: a.instance,
      required: a.required,
      docKey: a.docKey,
      repoPath: a.repoPath,
      projectId: a.projectId,
      consumerProjectIds: a.consumerProjectIds,
      contractFormat: (a.contractFormat as SdlcItemDetail["artifacts"][number]["contractFormat"]) ?? null,
      baselineVersion: a.baselineVersion,
      approval: a.approval,
      // Phiên duyệt và bản nháp nằm ở `knowledge`; màn hạng mục mở trình soạn theo `docKey` để xem.
      reviewId: null,
      hasDraft: false,
      syncs: syncs
        .filter((s) => s.artifactId === a.id)
        .map((s) => ({
          projectId: s.projectId,
          projectKey: keyOf(s.projectId),
          kind: s.kind,
          repoPath: s.repoPath,
          state: s.syncState,
          syncedVersion: s.syncedVersion,
          syncedCommit: s.syncedCommit,
          error: s.syncError,
          attempts: s.syncAttempts,
          syncedAt: isoOrNull(s.syncedAt),
          prUrl: null,
        })),
    })),
    questions: questions.map((q) => ({
      id: q.id,
      itemId: item.id,
      item: { ref: sdlcItemRef(item.number), title: item.title, projectKey: keyOf(item.projectId) },
      phaseId: q.phaseId,
      round: q.round,
      position: q.position,
      text: q.text,
      options: q.options,
      recommended: q.recommended,
      context: q.context,
      status: q.status,
      answer: q.answer,
      usedRecommended: q.usedRecommended,
      answeredBy: q.answeredBy ? person(names, q.answeredBy) : null,
      answeredAt: isoOrNull(q.answeredAt),
      createdAt: iso(q.createdAt),
    })),
    steps: steps.map((s) => ({
      id: s.id,
      phaseId: s.phaseId,
      stepId: s.stepId,
      action: s.action as SdlcItemDetail["steps"][number]["action"],
      round: s.round,
      status: s.status,
      run: s.runId ? { id: s.runId, state: STEP_RUN_STATE[s.status] } : null,
      waitingReason: null,
      instructions: s.instructions,
      result: s.result,
      error: s.error,
      createdBy: s.createdBy,
      createdAt: iso(s.createdAt),
      finishedAt: isoOrNull(s.finishedAt),
    })),
    // Task, tự duyệt và cảnh báo do bản tách (T030), tự duyệt (T017), contract (T016) điền.
    tasks: [],
    overrides: overrides.map((o) => ({
      id: o.id,
      itemId: o.itemId,
      taskId: o.taskId,
      projectId: o.projectId,
      reason: o.reason,
      decidedBy: person(names, o.decidedBy),
      createdAt: iso(o.createdAt),
      expiresAt: isoOrNull(o.expiresAt),
      revokedAt: isoOrNull(o.revokedAt),
      revokedBy: o.revokedBy ? person(names, o.revokedBy) : null,
      active: !o.revokedAt && (!o.expiresAt || o.expiresAt.getTime() > now),
    })),
    autoApprovals: [],
    warnings: [],
    convergeRound: item.convergeRound,
    convergedAt: isoOrNull(item.convergedAt),
    can: {
      write: writable.length > 0 && writable.every(Boolean),
      manage,
      override: await hasTeamPermission(tx, userId, item.teamId, "sdlc.override"),
      runWaves: manage,
      editProjects: item.ownerUserId === userId || (await teamRoleOf(tx, userId, item.teamId)) === "admin",
      changeMode: manage && open && !baselined,
    },
  };
}
