import { createHash } from "node:crypto";
import {
  type ReviewGate,
  type ReviewPhase,
  reviewGate,
  reviewPhase,
  type SdlcMode,
  type SdlcPhase,
  type SdlcPhaseStatus,
  type SdlcSize,
  type SdlcStep,
  sdlcItemRef,
} from "@xdev-hive/contracts";
import type { SdlcJobSpec } from "@xdev-hive/contracts/worker-protocol";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { recordAudit } from "../audit/index.ts";
import { loadProject } from "../catalog/index.ts";
import { getDoc } from "../knowledge/index.ts";
import {
  BadRequestError,
  ConflictError,
  type Jobs,
  type MasterKey,
  NotFoundError,
  type Tx,
} from "../platform/index.ts";
import type { ProviderFactory } from "../scm/index.ts";
import { teams } from "../tenancy/index.ts";
import { activeItemProjects, requireItemManage } from "./access.ts";
import { onBreakdownBaseline } from "./breakdown.ts";
import { contractCheckpointTeams } from "./contracts.ts";
import {
  sdlcArtifactSyncs,
  sdlcArtifacts,
  sdlcAutoApprovals,
  sdlcItemPhases,
  sdlcItemProjects,
  sdlcItems,
  sdlcSteps,
} from "./schema.ts";
import { queueSync } from "./sync.ts";

/*
 * Máy trạng thái giai đoạn của hạng mục (plan.md "Luồng"). Giai đoạn đạt khi mọi tài liệu bắt buộc của nó có baseline;
 * giai đoạn ngoài cỡ của hạng mục bị bỏ từ lúc tạo; giai đoạn `implementation` chỉ xong khi mọi task xong (T031 gọi
 * `approvePhase`). Mọi thay đổi khoá dòng `sdlc_items` để job và route không đi tiếp hai lần cùng lúc.
 */

export type SdlcItemRow = typeof sdlcItems.$inferSelect;
type PhaseRow = typeof sdlcItemPhases.$inferSelect;

export const SDLC_QUEUE = "sdlc";
/** Tác nhân ghi ở cột `created_by` khi hub tự chạy bước, không có người bấm. */
export const SDLC_SYSTEM_ACTOR = "system:sdlc";

export type SdlcJob =
  | { kind: "advance"; orgId: string; itemId: string }
  | { kind: "issue-comment"; orgId: string; itemId: string }
  /** Đọc CI của commit merge cho truy vết (scm.ts); `poll` đếm số lần đã hỏi khi CI còn chạy. */
  | { kind: "trace-ci"; orgId: string; itemId: string; taskId: string; sha: string; poll: number };

/** Một bước agent cần run `sdlc`; T022 dựng prompt, seed, collect rồi gọi `runs.startSdlcRun`. */
export interface SdlcStepStart {
  item: SdlcItemRow;
  phase: SdlcPhase;
  step: SdlcStep;
  /** Id dòng `sdlc_steps` vừa tạo. */
  stepRowId: string;
  round: number;
  instructions: string | null;
  /** Người bấm chạy; null khi hub tự chạy bước `auto`. */
  requestedBy: string | null;
}

/** Run `sdlc` mà `runs` tạo cho một bước (D5): prompt, seed và collect đã dựng xong ở `sdlc`. */
export interface SdlcRunRequest {
  itemId: string;
  /** Dự án chính: worktree của run là repo này. */
  projectId: string;
  stepRowId: string;
  title: string;
  prompt: string;
  job: SdlcJobSpec;
  cli: NonNullable<SdlcStep["cli"]> | null;
  model: string | null;
  /** Chủ run theo `runner` của dự án: null là run của đội (máy dùng chung). */
  ownerUserId: string | null;
  requiredLabels: string[];
  createdBy: string;
}

/** Điểm nối do `main.ts` cài: `sdlc` không import `runs` (runs import sdlc để gọi cổng chặn). */
export interface SdlcDeps {
  jobs?: Jobs | undefined;
  providerFactory?: ProviderFactory | undefined;
  masterKey?: MasterKey | null | undefined;
  /** Địa chỉ web để link trong bình luận issue. */
  publicUrl?: string | undefined;
  /** null: không tạo được run lúc này (máy, quota); bước giữ `queued` để người chạy lại. */
  startSdlcRun?: ((tx: Tx, input: SdlcStepStart) => Promise<{ runId: string } | null>) | undefined;
  /** `runs.startSdlcRun`; `withStepRuns` (steps.ts) dựng `startSdlcRun` từ đây. */
  createSdlcRun?: ((tx: Tx, request: SdlcRunRequest) => Promise<{ runId: string } | null>) | undefined;
  /**
   * Run code cho task của đợt (`runs.queueRun`, qua cổng chặn D10). Lỗi nghiệp vụ ném như khi người giao tay; đợt ghi lại
   * thành lý do bỏ qua. `afterCommit` đẩy run tới máy, gọi sau khi transaction commit.
   */
  startTaskRun?:
    | ((tx: Tx, request: SdlcTaskRunRequest) => Promise<{ runId: string; afterCommit: () => void }>)
    | undefined;
}

export interface SdlcTaskRunRequest {
  taskId: string;
  /** Theo `runner` của dự án của task: null là run của đội. */
  ownerUserId: string | null;
  requiredLabels: string[];
  createdBy: string;
  /** null: hub tự chạy đợt. */
  actorUserId: string | null;
}

export const phaseApplies = (phase: SdlcPhase, size: SdlcSize) => !phase.sizes.length || phase.sizes.includes(size);

/** Trạng thái đầu của mọi giai đoạn: giai đoạn ngoài cỡ bị bỏ ngay, giai đoạn áp dụng đầu tiên bắt đầu soạn. */
export function initialPhases(
  mode: SdlcMode,
  size: SdlcSize,
): {
  index: number;
  rows: { phaseIndex: number; phaseId: string; kind: string; status: SdlcPhaseStatus; note: string | null }[];
} {
  const index = mode.phases.findIndex((p) => phaseApplies(p, size));
  const rows = mode.phases.map((p, i) => {
    const applies = phaseApplies(p, size);
    const status: SdlcPhaseStatus = !applies ? "skipped" : i === index ? "drafting" : "pending";
    return { phaseIndex: i, phaseId: p.id, kind: p.kind, status, note: applies ? null : `Bỏ qua với cỡ ${size}.` };
  });
  return { index: index < 0 ? mode.phases.length : index, rows };
}

export async function lockItem(tx: Tx, id: string): Promise<SdlcItemRow | null> {
  const [row] = await tx.select().from(sdlcItems).where(eq(sdlcItems.id, id)).for("update");
  return row ?? null;
}

async function phaseRows(tx: Tx, itemId: string): Promise<PhaseRow[]> {
  return tx
    .select()
    .from(sdlcItemPhases)
    .where(eq(sdlcItemPhases.itemId, itemId))
    .orderBy(asc(sdlcItemPhases.phaseIndex));
}

/**
 * Giai đoạn có tài liệu bắt buộc thì đạt khi mọi tài liệu đó có baseline chưa bị thu hồi; tài liệu tuỳ chọn không chặn.
 * Không có tài liệu bắt buộc thì đạt khi các bước tự chạy đã xong. Triển khai không bao giờ tự đạt ở đây. Giai đoạn
 * trước còn tài liệu đang duyệt lại sau thu hồi tự duyệt thì chưa đạt (D26): bản này dựa trên tài liệu có thể đổi.
 */
async function phaseReady(tx: Tx, item: SdlcItemRow, phase: SdlcPhase): Promise<boolean> {
  if (phase.kind === "implementation") return false;
  const index = item.mode.phases.findIndex((p) => p.id === phase.id);
  const revoked = await tx
    .select({ phaseId: sdlcArtifacts.phaseId })
    .from(sdlcArtifacts)
    .where(and(eq(sdlcArtifacts.itemId, item.id), eq(sdlcArtifacts.approval, "revoked")));
  if (revoked.some((r) => item.mode.phases.findIndex((p) => p.id === r.phaseId) < index)) return false;
  const required = await tx
    .select({ version: sdlcArtifacts.baselineVersion, approval: sdlcArtifacts.approval })
    .from(sdlcArtifacts)
    .where(
      and(eq(sdlcArtifacts.itemId, item.id), eq(sdlcArtifacts.phaseId, phase.id), eq(sdlcArtifacts.required, true)),
    );
  if (required.length && !required.every((a) => a.version !== null && a.approval !== "revoked")) return false;
  // Giai đoạn có converge chỉ đạt khi hội tụ (converge.ts); hết vòng mà chưa hội tụ thì người sửa tay hoặc bỏ qua.
  if (phase.steps.some((s) => s.action === "converge")) return item.convergedAt !== null;
  if (required.length) return true;
  const auto = phase.steps.filter((s) => s.auto);
  if (!auto.length) return true;
  const done = await tx
    .select({ stepId: sdlcSteps.stepId })
    .from(sdlcSteps)
    .where(and(eq(sdlcSteps.itemId, item.id), eq(sdlcSteps.phaseId, phase.id), eq(sdlcSteps.status, "succeeded")));
  return auto.every((s) => done.some((d) => d.stepId === s.id));
}

/** Sang giai đoạn kế chưa bị bỏ; hết giai đoạn thì hạng mục xong. */
async function moveNext(tx: Tx, item: SdlcItemRow, rows: PhaseRow[]): Promise<SdlcItemRow> {
  const next = rows.find((r) => r.phaseIndex > item.phaseIndex && r.status !== "skipped");
  if (!next) {
    const [done] = await tx
      .update(sdlcItems)
      .set({ phaseIndex: item.mode.phases.length, status: "done", doneAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(sdlcItems.id, item.id))
      .returning();
    await recordAudit(tx, { action: "sdlc.item.done", targetType: "sdlc_item", targetId: item.id, data: {} });
    return done ?? item;
  }
  if (next.status === "pending") {
    await tx
      .update(sdlcItemPhases)
      .set({ status: "drafting", startedAt: sql`now()` })
      .where(eq(sdlcItemPhases.id, next.id));
    next.status = "drafting";
  }
  const [moved] = await tx
    .update(sdlcItems)
    .set({ phaseIndex: next.phaseIndex, updatedAt: sql`now()` })
    .where(eq(sdlcItems.id, item.id))
    .returning();
  return moved ?? item;
}

async function markApproved(tx: Tx, row: PhaseRow, decidedBy: string | null): Promise<void> {
  await tx
    .update(sdlcItemPhases)
    .set({ status: "approved", approvedAt: sql`now()`, decidedBy })
    .where(eq(sdlcItemPhases.id, row.id));
}

/** Chạy bước `auto` kế tiếp chưa chạy của giai đoạn; mỗi lúc một bước để bước sau đọc được kết quả bước trước. */
async function startNextAutoStep(tx: Tx, item: SdlcItemRow, phase: SdlcPhase, deps: SdlcDeps): Promise<void> {
  if (!deps.startSdlcRun) return;
  const done = await tx
    .select({ stepId: sdlcSteps.stepId, status: sdlcSteps.status })
    .from(sdlcSteps)
    .where(and(eq(sdlcSteps.itemId, item.id), eq(sdlcSteps.phaseId, phase.id)));
  if (done.some((s) => s.status === "queued" || s.status === "running")) return;
  const step = phase.steps.find((s) => s.auto && !done.some((d) => d.stepId === s.id));
  if (!step) return;
  const [row] = await tx
    .insert(sdlcSteps)
    .values({
      orgId: item.orgId,
      itemId: item.id,
      phaseId: phase.id,
      stepId: step.id,
      action: step.action,
      createdBy: SDLC_SYSTEM_ACTOR,
    })
    .returning();
  if (!row) return;
  const started = await deps.startSdlcRun(tx, {
    item,
    phase,
    step,
    stepRowId: row.id,
    round: row.round,
    instructions: null,
    requestedBy: null,
  });
  if (started) await tx.update(sdlcSteps).set({ runId: started.runId }).where(eq(sdlcSteps.id, row.id));
  await recordAudit(tx, {
    action: "sdlc.step.start",
    targetType: "sdlc_item",
    targetId: item.id,
    data: { phaseId: phase.id, stepId: step.id, stepRowId: row.id, runId: started?.runId ?? null, auto: true },
  });
}

/**
 * Đưa hạng mục đi hết mức có thể: bỏ qua giai đoạn đã xong hoặc bị bỏ, duyệt giai đoạn đã đủ, rồi chạy bước tự động của
 * giai đoạn đang soạn. Gọi lại nhiều lần vẫn an toàn (job trùng, baseline tới cùng lúc).
 */
export async function advance(tx: Tx, itemId: string, deps: SdlcDeps = {}): Promise<SdlcItemRow | null> {
  let item = await lockItem(tx, itemId);
  if (item?.status !== "active") return item;
  const rows = await phaseRows(tx, item.id);
  for (;;) {
    const phase = item.mode.phases[item.phaseIndex];
    const row = rows.find((r) => r.phaseIndex === item?.phaseIndex);
    if (!phase || !row) {
      // Mọi giai đoạn đã qua (hoặc bản chụp không còn giai đoạn ở vị trí này): đóng hạng mục.
      if (item.status === "active") item = await moveNext(tx, { ...item, phaseIndex: item.mode.phases.length }, []);
      return item;
    }
    if (row.status === "skipped" || row.status === "approved") {
      item = await moveNext(tx, item, rows);
      if (item.status !== "active") return item;
      continue;
    }
    if (row.status === "pending") {
      await tx
        .update(sdlcItemPhases)
        .set({ status: "drafting", startedAt: sql`now()` })
        .where(eq(sdlcItemPhases.id, row.id));
      row.status = "drafting";
    }
    if (await phaseReady(tx, item, phase)) {
      await markApproved(tx, row, null);
      row.status = "approved";
      item = await moveNext(tx, item, rows);
      if (item.status !== "active") return item;
      continue;
    }
    await startNextAutoStep(tx, item, phase, deps);
    return item;
  }
}

/**
 * Đi tiếp qua job khi có hàng đợi, để transaction của người gọi (baseline trong `knowledge`, route) không phải chờ tạo
 * run; không có hàng đợi (test, công cụ) thì chạy ngay.
 */
export async function scheduleAdvance(tx: Tx, item: { id: string; orgId: string }, deps: SdlcDeps): Promise<void> {
  if (deps.jobs)
    await deps.jobs.enqueue(SDLC_QUEUE, { kind: "advance", orgId: item.orgId, itemId: item.id } satisfies SdlcJob, {
      tx,
    });
  else await advance(tx, item.id, deps);
}

/** Giai đoạn đang chạy (thường là triển khai) đạt từ bên ngoài, vd. mọi task của hạng mục đã xong (T031). */
export async function approvePhase(
  tx: Tx,
  itemId: string,
  phaseId: string,
  deps: SdlcDeps,
  decidedBy: string | null = null,
): Promise<void> {
  const item = await lockItem(tx, itemId);
  if (!item) return;
  const [row] = await tx
    .select()
    .from(sdlcItemPhases)
    .where(and(eq(sdlcItemPhases.itemId, itemId), eq(sdlcItemPhases.phaseId, phaseId)));
  if (!row || row.status === "approved" || row.status === "skipped") return;
  await markApproved(tx, row, decidedBy);
  if (item.status === "active" && row.phaseIndex === item.phaseIndex) await scheduleAdvance(tx, item, deps);
}

// ---- Baseline ----------------------------------------------------------------------------------------------------

/** Cùng dạng `BaselineEvent` của `knowledge` (T014); khai lại để không phụ thuộc thứ tự merge của hai làn. */
export interface SdlcBaselineEvent {
  docKey: string;
  version: number;
  proposalId: string;
  reviewId: string;
  /** Duyệt lại baseline hiện tại sau khi thu hồi tự duyệt: không có phiên bản mới. */
  reaffirm?: boolean | undefined;
  /** Mọi checkpoint người của phiên đều do hub tự duyệt. */
  autoApproved?: boolean | undefined;
}

/**
 * Hash nội dung baseline để job đồng bộ nhận ra sửa trong repo (D12). Đọc bằng quyền của chủ hạng mục vì hook chạy
 * trong transaction của phiên duyệt, không có người gọi; không đọc được (chủ đã rời đội) thì để job đồng bộ tự tính.
 */
async function baselineHash(tx: Tx, item: SdlcItemRow, event: SdlcBaselineEvent): Promise<string | null> {
  try {
    const doc = await getDoc(
      tx,
      { kind: "user", userId: item.ownerUserId },
      { key: event.docKey, version: event.version },
    );
    return createHash("sha256").update(doc.content).digest("hex");
  } catch {
    return null;
  }
}

/**
 * `knowledge.finish` gọi trong transaction của baseline (D4): tài liệu không thuộc hạng mục thì bỏ qua. Ghi baseline,
 * đánh dấu đồng bộ, rồi duyệt giai đoạn nếu đủ tài liệu bắt buộc. Rollback baseline thì giai đoạn cũng không đạt.
 */
export async function onBaseline(tx: Tx, event: SdlcBaselineEvent, deps: SdlcDeps = {}): Promise<void> {
  const [artifact] = await tx.select().from(sdlcArtifacts).where(eq(sdlcArtifacts.docKey, event.docKey));
  if (!artifact) return;
  const item = await lockItem(tx, artifact.itemId);
  if (!item) return;
  const approval = event.reaffirm ? "reaffirmed" : event.autoApproved ? "auto" : "human";
  const hash = event.reaffirm ? artifact.baselineHash : await baselineHash(tx, item, event);
  await tx
    .update(sdlcArtifacts)
    .set({ baselineVersion: event.version, baselineHash: hash, approval })
    .where(eq(sdlcArtifacts.id, artifact.id));
  // Duyệt lại không tạo phiên bản mới nên repo không có gì để ghi.
  if (!event.reaffirm) await markSyncPending(tx, item, artifact.id, deps);
  // Bản tách đọc từ chính baseline này (T030); lỗi đọc thì rollback cả baseline để không có baseline mà thiếu task.
  if (!event.reaffirm) await onBreakdownBaseline(tx, item, artifact, event.version);
  // Lần tự duyệt ghi lúc checkpoint đạt, chưa biết phiên bản; thu hồi cần phiên bản để biết baseline nào bị bác.
  if (event.autoApproved && !event.reaffirm)
    await tx
      .update(sdlcAutoApprovals)
      .set({ version: event.version })
      .where(and(eq(sdlcAutoApprovals.reviewId, event.reviewId), eq(sdlcAutoApprovals.artifactId, artifact.id)));
  await recordAudit(tx, {
    action: "sdlc.artifact.baseline",
    targetType: "sdlc_item",
    targetId: item.id,
    data: {
      artifactId: artifact.artifactId,
      instance: artifact.instance,
      docKey: event.docKey,
      version: event.version,
      reviewId: event.reviewId,
      approval,
    },
  });

  const phase = item.mode.phases.find((p) => p.id === artifact.phaseId);
  const [row] = await tx
    .select()
    .from(sdlcItemPhases)
    .where(and(eq(sdlcItemPhases.itemId, item.id), eq(sdlcItemPhases.phaseId, artifact.phaseId)));
  if (!phase || !row || row.status === "approved" || row.status === "skipped") return;
  if (!(await phaseReady(tx, item, phase))) return;
  await markApproved(tx, row, null);
  // Giai đoạn sau đạt sớm (tài liệu soạn trước) thì chờ tới lượt; `advance` sẽ đi qua nó. Duyệt lại sau thu hồi thì
  // giai đoạn đang chạy (thường đã ở sau) có thể vừa hết bị giữ, nên đi tiếp dù không phải giai đoạn hiện tại.
  if (item.status === "active" && (row.phaseIndex === item.phaseIndex || event.reaffirm))
    await scheduleAdvance(tx, item, deps);
}

/** Repo nào để `off` thì tài liệu chỉ ở hub; còn lại chờ job đồng bộ (sync.ts) ghi vào repo. */
async function markSyncPending(tx: Tx, item: SdlcItemRow, artifactId: string, deps: SdlcDeps): Promise<void> {
  const syncs = await tx
    .select({ projectId: sdlcArtifactSyncs.projectId, settings: sdlcItemProjects.settings })
    .from(sdlcArtifactSyncs)
    .innerJoin(sdlcArtifacts, eq(sdlcArtifacts.id, sdlcArtifactSyncs.artifactId))
    .innerJoin(
      sdlcItemProjects,
      and(
        eq(sdlcItemProjects.itemId, sdlcArtifacts.itemId),
        eq(sdlcItemProjects.projectId, sdlcArtifactSyncs.projectId),
      ),
    )
    .where(eq(sdlcArtifactSyncs.artifactId, artifactId));
  for (const s of syncs) {
    if (s.settings.repoSync === "off") continue;
    await tx
      .update(sdlcArtifactSyncs)
      .set({ syncState: "pending", syncError: null, syncAttempts: 0 })
      .where(and(eq(sdlcArtifactSyncs.artifactId, artifactId), eq(sdlcArtifactSyncs.projectId, s.projectId)));
    await queueSync(tx, deps.jobs, { orgId: item.orgId, itemId: item.id, projectId: s.projectId });
  }
}

// ---- Bỏ qua giai đoạn ----------------------------------------------------------------------------------------------

export async function skipPhase(
  tx: Tx,
  userId: string,
  input: { id: string; phaseId: string; reason: string },
  deps: SdlcDeps = {},
): Promise<void> {
  const reason = input.reason?.trim() ?? "";
  if (reason.length < 3) throw new BadRequestError("SDLC_SKIP_REASON", "Ghi lý do bỏ qua giai đoạn.");
  const item = await lockItem(tx, input.id);
  if (!item) throw new NotFoundError("SDLC_ITEM_NOT_FOUND", "Không tìm thấy hạng mục.");
  await requireItemManage(tx, userId, item);
  if (item.status !== "active" && item.status !== "paused")
    throw new ConflictError("SDLC_ITEM_CLOSED", "Hạng mục đã xong hoặc đã huỷ.");
  const phase = item.mode.phases.find((p) => p.id === input.phaseId);
  if (!phase) throw new NotFoundError("SDLC_PHASE_NOT_FOUND", "Không tìm thấy giai đoạn.");
  if (!phase.optional)
    throw new BadRequestError(
      "SDLC_PHASE_NOT_OPTIONAL",
      "Chỉ bỏ qua được giai đoạn tuỳ chọn; giai đoạn bắt buộc cần ngoại lệ chặn.",
    );
  const [row] = await tx
    .select()
    .from(sdlcItemPhases)
    .where(and(eq(sdlcItemPhases.itemId, item.id), eq(sdlcItemPhases.phaseId, phase.id)));
  if (!row) throw new NotFoundError("SDLC_PHASE_NOT_FOUND", "Không tìm thấy giai đoạn.");
  if (row.status === "approved" || row.status === "skipped")
    throw new ConflictError("SDLC_PHASE_CLOSED", "Giai đoạn đã xong hoặc đã bỏ qua.");
  await tx
    .update(sdlcItemPhases)
    .set({ status: "skipped", note: reason, decidedBy: userId })
    .where(eq(sdlcItemPhases.id, row.id));
  await tx.update(sdlcItems).set({ updatedAt: sql`now()` }).where(eq(sdlcItems.id, item.id));
  await recordAudit(tx, {
    action: "sdlc.phase.skip",
    targetType: "sdlc_item",
    targetId: item.id,
    data: { phaseId: phase.id, reason },
  });
  if (item.status === "active" && row.phaseIndex === item.phaseIndex) await scheduleAdvance(tx, item, deps);
}

// ---- Quy trình duyệt -----------------------------------------------------------------------------------------------

export interface SdlcWorkflow {
  name: string;
  phases: ReviewPhase[];
}

/**
 * `knowledge` hỏi trước `matchWorkflow` (D3): key thuộc hạng mục thì dùng cổng của giai đoạn chứa tài liệu trong bản
 * chụp chế độ, kể cả đề xuất từ trang Tài liệu hay MCP. Tên phiên "012 · Specify" để người duyệt biết ngữ cảnh.
 */
export async function workflowFor(tx: Tx, docKey: string): Promise<SdlcWorkflow | null> {
  const [row] = await tx
    .select({
      itemId: sdlcItems.id,
      phaseId: sdlcArtifacts.phaseId,
      number: sdlcItems.number,
      mode: sdlcItems.mode,
      scope: sdlcArtifacts.scope,
      instance: sdlcArtifacts.instance,
      providerProjectId: sdlcArtifacts.projectId,
      consumerProjectIds: sdlcArtifacts.consumerProjectIds,
    })
    .from(sdlcArtifacts)
    .innerJoin(sdlcItems, eq(sdlcItems.id, sdlcArtifacts.itemId))
    .where(eq(sdlcArtifacts.docKey, docKey));
  if (!row) return null;
  const phase = row.mode.phases.find((p) => p.id === row.phaseId);
  if (!phase) return null;
  if (row.scope === "contract")
    return {
      name: `${sdlcItemRef(row.number)} · ${phase.name} · contract ${row.instance}`,
      phases: contractPhases(phase.gate, contractParties(await itemTeams(tx, row.itemId), row)),
    };
  return {
    name: `${sdlcItemRef(row.number)} · ${phase.name}`,
    phases: await perTeamWorkflow(tx, row.itemId, phase.gate, phase.perProjectGates),
  };
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
  return scopeGatesToTeams(phases, (g) => perProjectGates.includes(g.id), itemTeamList);
}

/** Nhân mỗi checkpoint người được chọn thành một checkpoint cho mỗi đội trong `teamList`, kể cả khi chỉ có một đội. */
export function scopeGatesToTeams(
  phases: readonly ReviewPhase[],
  pick: (gate: ReviewGate) => boolean,
  teamList: readonly ItemTeam[],
): ReviewPhase[] {
  return phases.map((phase) => {
    const used = new Set(phase.gates.map((g) => g.id));
    const gates = phase.gates.flatMap((gate): ReviewGate[] => {
      if (gate.kind !== "human" || !pick(gate)) return [gate];
      used.delete(gate.id);
      return teamList.map((team, i) => ({
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

// ---- Cổng của contract (D23) ---------------------------------------------------------------------------------------

/** Đội của các bên contract, bên cung cấp trước; mỗi đội chỉ giữ dự án là một bên để tên checkpoint nói đúng bên nào. */
export function contractParties(
  teamList: readonly ItemTeam[],
  contract: { providerProjectId: string; consumerProjectIds: readonly string[] },
): ItemTeam[] {
  const participants = teamList.flatMap((t) =>
    t.projects.map((p) => ({ projectId: p.id, key: p.key, teamId: t.teamId })),
  );
  const parties = new Set([contract.providerProjectId, ...contract.consumerProjectIds]);
  return contractCheckpointTeams(
    { providerProjectId: contract.providerProjectId, consumerProjectIds: [...contract.consumerProjectIds] },
    participants,
  ).flatMap((teamId) => {
    const team = teamList.find((t) => t.teamId === teamId);
    return team ? [{ ...team, projects: team.projects.filter((p) => parties.has(p.id)) }] : [];
  });
}

const CONTRACT_GATE = reviewGate.parse({
  id: "contract",
  name: "Các bên đồng ý contract",
  kind: "human",
  reviewers: { roles: ["team-admin"] },
});

/**
 * Cổng giai đoạn cộng một checkpoint người cho mỗi đội là một bên (D23). Bỏ checkpoint quy tắc của giai đoạn: chúng kiểm
 * mục bắt buộc của tài liệu Markdown trong giai đoạn, còn contract là file OpenAPI/proto… nên sẽ luôn trượt. Giai đoạn
 * không có checkpoint người thì thêm một, vì contract không bao giờ được qua mà thiếu người của các đội.
 */
export function contractPhases(gate: readonly ReviewPhase[], parties: readonly ItemTeam[]): ReviewPhase[] {
  const kept = gate
    .map((p) => ({ ...p, gates: p.gates.filter((g) => g.kind !== "rule") }))
    .filter((p) => p.gates.length > 0);
  const phases = kept.some((p) => p.gates.some((g) => g.kind === "human"))
    ? kept
    : [...kept, reviewPhase.parse({ name: "Duyệt contract", gates: [CONTRACT_GATE] })];
  return parties.length > 0 ? scopeGatesToTeams(phases, () => true, parties) : phases;
}
