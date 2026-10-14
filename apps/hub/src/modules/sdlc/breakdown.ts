import { implement } from "@orpc/server";
import {
  type Breakdown,
  type BreakdownTask,
  contract,
  coverage,
  findRequirements,
  parseBreakdown,
  type SdlcBreakdownView,
  type SdlcDecomposition,
  type SdlcItemTask,
  sdlcItemRef,
  type TaskChecklistItem,
  writeBreakdown,
} from "@xdev-hive/contracts";
import { and, eq, inArray, sql } from "drizzle-orm";
import { recordAudit } from "../audit/index.ts";
import { loadProject } from "../catalog/index.ts";
import { editorState, getDoc, type Principal, saveDraft } from "../knowledge/index.ts";
import { BadRequestError, ForbiddenError, NotFoundError, type RequestContext, type Tx } from "../platform/index.ts";
import {
  createSystemTask,
  dependenciesOf,
  loadTask,
  setTaskDependencies,
  setTaskStatus,
  type TaskRow,
  updateSystemTask,
} from "../tasks/index.ts";
import { type OrgDeps, orgMiddlewares } from "../tenancy/index.ts";
import { activeItemProjects, itemForUser, requireProjectWrite, type SdlcItemRow } from "./access.ts";
import { sdlcArtifacts, sdlcItemTasks, sdlcTraceLinks } from "./schema.ts";

/*
 * Bản tách task của hạng mục (specs/011 D8, D24, US5): tài liệu tách việc là nguồn, bản tách là kết quả đọc nó. Baseline
 * của tài liệu đó tạo/cập nhật/huỷ task hub trong dự án của từng task; bản trước so theo khoá lát (`T003`, tiêu đề phần).
 */

/** Tác nhân hệ thống ghi ở `created_by` của task do bản tách tạo; như `SDLC_SYSTEM_ACTOR` của phases.ts. */
const SYSTEM_ACTOR = "system:sdlc";

interface ProjectRef {
  id: string;
  key: string;
  role: "home" | "participant";
}

async function itemProjectRefs(tx: Tx, itemId: string): Promise<ProjectRef[]> {
  const out: ProjectRef[] = [];
  for (const m of await activeItemProjects(tx, itemId)) {
    const project = await loadProject(tx, m.projectId);
    if (project) out.push({ id: m.projectId, key: project.key, role: m.role });
  }
  return out;
}

function decompositionOf(item: SdlcItemRow): SdlcDecomposition {
  const d = item.mode.decomposition;
  if (!d) throw new BadRequestError("SDLC_NO_BREAKDOWN", "Chế độ của hạng mục không tách task.");
  return d;
}

/** Dòng `sdlc_artifacts` của tài liệu tách việc (tài liệu chung, ở dự án chính). */
async function breakdownArtifact(tx: Tx, item: SdlcItemRow, d: SdlcDecomposition) {
  const [row] = await tx
    .select()
    .from(sdlcArtifacts)
    .where(
      and(
        eq(sdlcArtifacts.itemId, item.id),
        eq(sdlcArtifacts.phaseId, d.phase),
        eq(sdlcArtifacts.artifactId, d.artifact),
      ),
    );
  if (!row) throw new NotFoundError("SDLC_BREAKDOWN_NOT_FOUND", "Hạng mục chưa có tài liệu tách việc.");
  return row;
}

function parse(markdown: string, d: SdlcDecomposition, projects: readonly ProjectRef[]) {
  const home = projects.find((p) => p.role === "home");
  return parseBreakdown(markdown, d, { homeProject: home?.key ?? "", projects: projects.map((p) => p.key) });
}

// ---- Áp baseline ---------------------------------------------------------------------------------------------------

const taskBody = (t: BreakdownTask, ref: string) =>
  [
    t.body.trim(),
    "",
    `---`,
    `Hạng mục ${ref} · ${t.sliceKey}${t.requirementIds.length ? ` · ${t.requirementIds.join(", ")}` : ""}`,
  ]
    .join("\n")
    .trim()
    .slice(0, 20_000);

/** Checklist mới giữ dấu xong của mục cùng id: agent đã đánh dấu thì duyệt lại bản tách không xoá công sức đó. */
function checklistOf(t: BreakdownTask, previous: readonly TaskChecklistItem[] = []): TaskChecklistItem[] {
  const done = new Map(previous.map((c) => [c.id, c.done]));
  return t.checklist.map((c) => ({
    id: c.id,
    text: c.text,
    done: done.get(c.id) ?? false,
    requirementIds: c.requirementIds,
  }));
}

export interface BreakdownApplyResult {
  created: string[];
  updated: string[];
  cancelled: string[];
  /** "Task T-41 đã chạy nhưng bị bỏ khỏi bản tách." (FR-026) */
  warnings: string[];
}

/**
 * Baseline của tài liệu tách việc thành task hub (T030). Task nằm trong dự án của nó; phụ thuộc (kể cả liên dự án) ghi
 * bằng tác nhân hệ thống vì người duyệt tài liệu không cần quyền sửa task ở mọi dự án. Task đã chạy không bị sửa hay
 * huỷ: chỉ cảnh báo, để run và PR khớp việc đã giao.
 */
export async function applyBreakdown(
  tx: Tx,
  item: SdlcItemRow,
  markdown: string,
  version: number,
): Promise<BreakdownApplyResult> {
  const d = decompositionOf(item);
  const projects = await itemProjectRefs(tx, item.id);
  const parsed = parse(markdown, d, projects);
  if (!parsed.ok)
    throw new BadRequestError(
      "SDLC_BREAKDOWN_INVALID",
      `Không đọc được bản tách: ${parsed.errors.map((e) => e.message).join(" ")}`,
    );
  const breakdown = parsed.breakdown;
  const home = projects.find((p) => p.role === "home");
  const ref = `${home?.key ?? ""}-${sdlcItemRef(item.number)}`;
  const byKey = new Map(projects.map((p) => [p.key, p.id]));
  const waveOf = new Map(breakdown.waves.flatMap((w, i) => w.map((k) => [k, i + 1] as const)));
  const existing = new Map(
    (await tx.select().from(sdlcItemTasks).where(eq(sdlcItemTasks.itemId, item.id))).map((r) => [r.sliceKey, r]),
  );
  const result: BreakdownApplyResult = { created: [], updated: [], cancelled: [], warnings: [] };
  const taskOf = new Map<string, TaskRow>();

  const create = async (t: BreakdownTask, projectId: string): Promise<TaskRow> => {
    const row = await createSystemTask(
      tx,
      SYSTEM_ACTOR,
      { projectId, title: t.title, body: taskBody(t, ref), checklist: checklistOf(t) },
      { kind: "sdlc", itemId: item.id, sliceKey: t.sliceKey },
    );
    result.created.push(row.id);
    return row;
  };
  const link = (t: BreakdownTask, task: TaskRow) => ({
    orgId: item.orgId,
    itemId: item.id,
    taskId: task.id,
    projectId: task.projectId,
    sliceKey: t.sliceKey,
    wave: waveOf.get(t.sliceKey) ?? 1,
    requirementIds: [...new Set([...t.requirementIds, ...t.checklist.flatMap((c) => c.requirementIds)])],
    removed: false,
    breakdownVersion: version,
  });

  for (const t of breakdown.tasks) {
    const projectId = byKey.get(t.project);
    if (!projectId) continue;
    const prev = existing.get(t.sliceKey);
    const prevTask = prev ? await loadTask(tx, prev.taskId) : null;
    if (!prev || !prevTask || prevTask.status === "cancelled") {
      if (prev)
        await tx
          .delete(sdlcItemTasks)
          .where(and(eq(sdlcItemTasks.itemId, item.id), eq(sdlcItemTasks.taskId, prev.taskId)));
      const task = await create(t, projectId);
      await tx.insert(sdlcItemTasks).values(link(t, task));
      taskOf.set(t.sliceKey, task);
      continue;
    }
    if (prevTask.projectId !== projectId) {
      if (prevTask.status !== "todo") {
        result.warnings.push(`Task ${prevTask.key} đã chạy ở dự án cũ; không chuyển sang dự án ${t.project}.`);
        taskOf.set(t.sliceKey, prevTask);
        continue;
      }
      // Task thuộc một dự án (D24): đổi dự án là huỷ task cũ và tạo task mới ở dự án mới.
      await setTaskStatus(tx, prevTask.id, "cancelled");
      result.cancelled.push(prevTask.id);
      await tx
        .delete(sdlcItemTasks)
        .where(and(eq(sdlcItemTasks.itemId, item.id), eq(sdlcItemTasks.taskId, prev.taskId)));
      const task = await create(t, projectId);
      await tx.insert(sdlcItemTasks).values(link(t, task));
      taskOf.set(t.sliceKey, task);
      continue;
    }
    const updated = await updateSystemTask(tx, prevTask.id, {
      title: t.title,
      body: taskBody(t, ref),
      checklist: checklistOf(t, prevTask.checklist),
    });
    if (updated) result.updated.push(updated.id);
    const { orgId: _o, itemId: _i, taskId: _t, ...meta } = link(t, prevTask);
    await tx
      .update(sdlcItemTasks)
      .set(meta)
      .where(and(eq(sdlcItemTasks.itemId, item.id), eq(sdlcItemTasks.taskId, prevTask.id)));
    taskOf.set(t.sliceKey, updated ?? prevTask);
  }

  const kept = new Set(breakdown.tasks.map((t) => t.sliceKey));
  for (const [sliceKey, row] of existing) {
    if (kept.has(sliceKey) || row.removed) continue;
    const task = await loadTask(tx, row.taskId);
    if (task?.status === "todo") {
      await setTaskStatus(tx, task.id, "cancelled");
      result.cancelled.push(task.id);
    } else if (task && task.status !== "cancelled")
      result.warnings.push(`Task ${task.key} đã chạy nhưng bị bỏ khỏi bản tách; giữ lại để xem kết quả.`);
    await tx
      .update(sdlcItemTasks)
      .set({ removed: true, breakdownVersion: version })
      .where(and(eq(sdlcItemTasks.itemId, item.id), eq(sdlcItemTasks.taskId, row.taskId)));
  }

  for (const t of breakdown.tasks) {
    const task = taskOf.get(t.sliceKey);
    if (!task || task.status === "cancelled") continue;
    const dependsOn = t.dependsOn.flatMap((k) => {
      const dep = taskOf.get(k);
      return dep ? [dep.id] : [];
    });
    await setTaskDependencies(tx, null, { taskId: task.id, dependsOn });
  }

  await syncTaskTrace(tx, item, breakdown, taskOf, result.cancelled);
  await recordAudit(tx, {
    action: "sdlc.breakdown.apply",
    targetType: "sdlc_item",
    targetId: item.id,
    data: { version, tasks: breakdown.tasks.length, ...result },
  });
  return result;
}

/** Liên kết truy vết requirement → task (FR-030); task bị huỷ không còn là bằng chứng "đã lên kế hoạch". */
async function syncTaskTrace(
  tx: Tx,
  item: SdlcItemRow,
  breakdown: Breakdown,
  taskOf: ReadonlyMap<string, TaskRow>,
  cancelled: readonly string[],
): Promise<void> {
  if (cancelled.length)
    await tx
      .delete(sdlcTraceLinks)
      .where(
        and(
          eq(sdlcTraceLinks.itemId, item.id),
          eq(sdlcTraceLinks.kind, "task"),
          inArray(sdlcTraceLinks.taskId, [...cancelled]),
        ),
      );
  const rows = breakdown.tasks.flatMap((t) => {
    const task = taskOf.get(t.sliceKey);
    if (!task) return [];
    const reqs = new Set([...t.requirementIds, ...t.checklist.flatMap((c) => c.requirementIds)]);
    return [...reqs].map((requirementId) => ({
      orgId: item.orgId,
      itemId: item.id,
      requirementId,
      kind: "task" as const,
      ref: task.key,
      projectId: task.projectId,
      taskId: task.id,
    }));
  });
  if (rows.length) await tx.insert(sdlcTraceLinks).values(rows).onConflictDoNothing();
}

/**
 * Hook của `phases.onBaseline`: baseline của tài liệu tách việc thì áp. Nội dung đọc bằng quyền chủ hạng mục như
 * `baselineHash`, vì hook chạy trong transaction của phiên duyệt, không có người gọi. Chủ đã mất quyền đọc (rời đội)
 * thì không chặn baseline: ghi audit để người quản lý hạng mục áp lại bằng cách duyệt lại tài liệu.
 */
export async function onBreakdownBaseline(
  tx: Tx,
  item: SdlcItemRow,
  artifact: { phaseId: string; artifactId: string; docKey: string },
  version: number,
): Promise<BreakdownApplyResult | null> {
  const d = item.mode.decomposition;
  if (!d || d.phase !== artifact.phaseId || d.artifact !== artifact.artifactId) return null;
  let content: string;
  try {
    content = (await getDoc(tx, { kind: "user", userId: item.ownerUserId }, { key: artifact.docKey, version })).content;
  } catch (e) {
    if (!(e instanceof NotFoundError) && !(e instanceof ForbiddenError)) throw e;
    await recordAudit(tx, {
      action: "sdlc.breakdown.skipped",
      targetType: "sdlc_item",
      targetId: item.id,
      data: { docKey: artifact.docKey, version, reason: e.message },
    });
    return null;
  }
  return applyBreakdown(tx, item, content, version);
}

// ---- Xem, lưu ------------------------------------------------------------------------------------------------------

/** Requirement của tài liệu nguồn (spec…) theo baseline, hoặc bản nháp nếu chưa có baseline, để tính độ phủ. */
async function requirementsOf(tx: Tx, principal: Principal, item: SdlcItemRow, d: SdlcDecomposition) {
  const out: string[] = [];
  for (const source of d.requirementSource) {
    const [row] = await tx
      .select({ docKey: sdlcArtifacts.docKey, version: sdlcArtifacts.baselineVersion })
      .from(sdlcArtifacts)
      .where(
        and(
          eq(sdlcArtifacts.itemId, item.id),
          eq(sdlcArtifacts.phaseId, source.phase),
          eq(sdlcArtifacts.artifactId, source.artifact),
        ),
      );
    if (!row?.version) continue;
    try {
      const doc = await getDoc(tx, principal, { key: row.docKey, version: row.version });
      out.push(...(findRequirements(doc.content, d.requirementId) ?? []));
    } catch {
      // Không đọc được tài liệu nguồn thì độ phủ thiếu phần đó; không làm hỏng màn bản tách.
    }
  }
  return [...new Set(out)];
}

async function breakdownView(
  tx: Tx,
  principal: Principal,
  item: SdlcItemRow,
  d: SdlcDecomposition,
  input: { source: "draft" | "baseline"; docKey: string; revision: number; content: string },
): Promise<SdlcBreakdownView> {
  const projects = await itemProjectRefs(tx, item.id);
  const parsed = parse(input.content, d, projects);
  const requirements = await requirementsOf(tx, principal, item, d);
  const cov = parsed.ok ? coverage(requirements, parsed.breakdown) : null;
  const zero = { done: 0, verified: 0 };
  return {
    itemId: item.id,
    source: input.source,
    docKey: input.docKey,
    revision: input.revision,
    breakdown: parsed.breakdown,
    errors: parsed.errors,
    coverage: {
      total: { requirements: requirements.length, planned: cov?.total.planned ?? 0, ...zero },
      byProject: (cov?.byProject ?? []).map((p) => ({
        projectKey: p.project,
        coverage: { requirements: p.requirements, planned: p.planned, ...zero },
      })),
      missing: cov?.missing ?? requirements,
    },
  };
}

/** `breakdown.get`: bản nháp (đang soạn) hoặc baseline (đã áp thành task) của tài liệu tách việc. */
export async function getBreakdown(
  tx: Tx,
  userId: string,
  input: { id: string; source: "draft" | "baseline" },
): Promise<SdlcBreakdownView> {
  const item = await itemForUser(tx, userId, input.id);
  const d = decompositionOf(item);
  const artifact = await breakdownArtifact(tx, item, d);
  const principal: Principal = { kind: "user", userId };
  if (input.source === "baseline") {
    if (!artifact.baselineVersion)
      throw new NotFoundError("SDLC_BREAKDOWN_NO_BASELINE", "Tài liệu tách việc chưa được duyệt.");
    const doc = await getDoc(tx, principal, { key: artifact.docKey, version: artifact.baselineVersion });
    return breakdownView(tx, principal, item, d, {
      source: "baseline",
      docKey: artifact.docKey,
      revision: artifact.baselineVersion,
      content: doc.content,
    });
  }
  const { draft } = await editorState(tx, principal, { key: artifact.docKey });
  return breakdownView(tx, principal, item, d, {
    source: "draft",
    docKey: artifact.docKey,
    revision: draft.revision,
    content: draft.content,
  });
}

/**
 * `breakdown.save`: màn Duyệt bản tách sửa (gộp/tách, phụ thuộc, dự án) rồi ghi lại Markdown vào bản nháp; task chỉ đổi
 * khi bản nháp đó qua cổng duyệt. Cần quyền ở dự án của mọi task trong bản tách (FR-051).
 */
export async function saveBreakdown(
  tx: Tx,
  userId: string,
  input: { id: string; breakdown: Breakdown; baseRevision: number },
): Promise<SdlcBreakdownView> {
  const item = await itemForUser(tx, userId, input.id, true);
  const d = decompositionOf(item);
  const artifact = await breakdownArtifact(tx, item, d);
  const projects = await itemProjectRefs(tx, item.id);
  const home = projects.find((p) => p.role === "home");
  const byKey = new Map(projects.map((p) => [p.key, p.id]));
  const unknown = input.breakdown.tasks.find((t) => !byKey.has(t.project));
  if (unknown) throw new BadRequestError("SDLC_BREAKDOWN_INVALID", `Dự án ${unknown.project} không tham gia hạng mục.`);
  await requireProjectWrite(tx, userId, [
    item.projectId,
    ...input.breakdown.tasks.map((t) => byKey.get(t.project) as string),
  ]);
  const content = writeBreakdown(input.breakdown, d.parser, home?.key);
  const principal: Principal = { kind: "user", userId };
  const draft = await saveDraft(tx, principal, { key: artifact.docKey, content, revision: input.baseRevision });
  return breakdownView(tx, principal, item, d, {
    source: "draft",
    docKey: artifact.docKey,
    revision: draft.revision,
    content: draft.content,
  });
}

// ---- Task của hạng mục ---------------------------------------------------------------------------------------------

/** Tab Task của hạng mục: task theo dự án, phụ thuộc còn chặn, run mới nhất. */
export async function itemTaskViews(
  tx: Tx,
  item: SdlcItemRow,
  projectKeys: ReadonlyMap<string, string>,
): Promise<{ tasks: SdlcItemTask[]; warnings: string[] }> {
  const links = await tx.select().from(sdlcItemTasks).where(eq(sdlcItemTasks.itemId, item.id));
  if (!links.length) return { tasks: [], warnings: [] };
  const deps = await dependenciesOf(
    tx,
    links.map((l) => l.taskId),
  );
  // sdlc không import runs (runs gọi cổng của sdlc); đọc run mới nhất bằng SQL như participants.ts.
  const { rows: runs } = await tx.execute<{ task_id: string; id: string; state: string; pr_url: string | null }>(
    sql`select distinct on (task_id) task_id, id, state, pr_url from hive.runs
        where task_id in ${links.map((l) => l.taskId)} and kind = 'code' order by task_id, created_at desc`,
  );
  const runOf = new Map(runs.map((r) => [r.task_id, r]));
  const tasks: SdlcItemTask[] = [];
  const warnings: string[] = [];
  for (const l of links.sort((a, b) => a.wave - b.wave || a.sliceKey.localeCompare(b.sliceKey))) {
    const task = await loadTask(tx, l.taskId);
    if (!task) continue;
    if (l.removed && task.status !== "cancelled")
      warnings.push(`Task ${task.key} đã chạy nhưng bị bỏ khỏi bản tách; giữ lại để xem kết quả.`);
    const run = runOf.get(l.taskId);
    const dep = deps.get(l.taskId);
    tasks.push({
      taskId: task.id,
      key: task.key,
      title: task.title,
      status: task.status,
      projectId: l.projectId,
      projectKey: projectKeys.get(l.projectId) ?? "",
      sliceKey: l.sliceKey,
      wave: l.wave,
      requirementIds: l.requirementIds,
      checklist: task.checklist,
      dependsOn: dep?.dependsOn ?? [],
      blockedBy: (dep?.blockedBy ?? []).map((b) => ({
        taskId: b.id,
        key: b.key,
        projectKey: b.projectKey,
        status: b.status,
      })),
      removed: l.removed,
      run: run
        ? { id: run.id, state: run.state as NonNullable<SdlcItemTask["run"]>["state"], prUrl: run.pr_url }
        : null,
    });
  }
  return { tasks, warnings };
}

// ---- Route `breakdown.*` -------------------------------------------------------------------------------------------

/** Hàm đăng ký riêng để router.ts chỉ thêm một dòng `breakdown: breakdownRoutes(deps)` (T070 gộp). */
export function breakdownRoutes(deps: OrgDeps) {
  const { authed, inOrg } = orgMiddlewares(deps);
  const os = implement(contract.sdlc.breakdown).$context<RequestContext>().use(authed).use(inOrg);
  return {
    get: os.get.handler(({ context: { tx, user }, input }) => getBreakdown(tx, user.id, input)),
    save: os.save.handler(({ context: { tx, user }, input }) => saveBreakdown(tx, user.id, input)),
  };
}
