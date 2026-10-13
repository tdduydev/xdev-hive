import { type ChecklistItem, codeOptions, type ReviewGate, type ReviewWorkflow } from "@xdev-hive/contracts";
import type { CheckCommandResult, DiffStats } from "@xdev-hive/contracts/worker-protocol";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { recordAudit } from "../audit/index.ts";
import { loadProject } from "../catalog/index.ts";
import { flatGates, listCodeWorkflows } from "../knowledge/index.ts";
import { notify } from "../notify/index.ts";
import type { Jobs, MasterKey, Tx } from "../platform/index.ts";
import type { ProviderFactory, PullRequestFile } from "../scm/index.ts";
import { notificationRecipients, teamMemberIds } from "../tenancy/index.ts";
import { type AiGateDeps, onReviewRunFinished as aiRunFinished, type FinishedReviewRun, startAiGate } from "./ai.ts";
import { evaluateRules, gateApplies, type RuleContext } from "./gates.ts";
import { matchCodeWorkflow } from "./match.ts";
import { onApproved } from "./merge.ts";
import { codeReviewGateRuns, codeReviews } from "./schema.ts";

export const CODE_REVIEW_QUEUE = "codereview";
export const codeReviewQueue = {
  name: CODE_REVIEW_QUEUE,
  // Job chỉ xử lý checkpoint còn chờ ở đúng vị trí, nên chạy lại sau lỗi tạm (nhà cung cấp Git) là an toàn.
  retryLimit: 5,
  retryDelay: 30,
  retryBackoff: true,
  expireInSeconds: 10 * 60,
} as const;

/** `gateIndex` chốt vị trí lúc gửi job: phiên đã đi tiếp (người quyết thay, job khác chạy trước) thì job cũ bỏ qua. */
export type CodeReviewJob =
  | { kind: "advance"; orgId: string; reviewId: string; gateIndex: number }
  | { kind: "ci"; orgId: string; reviewId: string; gateIndex: number; headSha: string; attempt: number };

export type CodeReviewRow = typeof codeReviews.$inferSelect;
export type CodeReviewGateRunRow = typeof codeReviewGateRuns.$inferSelect;

/** Trạng thái còn mở: mỗi PR tối đa một phiên ở các trạng thái này (chỉ mục `code_reviews_open_pr`). */
const OPEN = ["in_review", "changes_requested", "approved"];

/** Run code vừa kết luận, do `runs.verifyCode` truyền vào. */
export interface CodeReviewRun {
  id: string;
  teamId: string;
  projectId: string;
  taskId: string | null;
  /** Chủ run code: người giao việc, không được tự duyệt (Q2). */
  ownerUserId: string | null;
  taskType: string | null;
  /** null khi run không đẩy được commit: không mở phiên. */
  headSha: string | null;
  /** null khi run không mở PR: chỉ PR do run mở mới có phiên (Q3). */
  pr: { number: number; url: string; branch: string; baseBranch: string } | null;
  /** null khi worker cũ không báo `diffStats`. */
  stats: DiffStats | null;
  /** Lý do `needs_review` của run, hiện ở đầu phiên cho người duyệt. */
  reasons: string[];
}

/** Bằng chứng của run code cho checkpoint quy tắc, đọc lại mỗi lần phiên đi tiếp (run đã kết thúc nên không đổi). */
export interface RunEvidence {
  /** Commit run đẩy lên; khác `head_sha` của phiên (vòng do push tay) thì số liệu và kết quả lệnh không dùng được. */
  headSha: string | null;
  taskType: string | null;
  stats: DiffStats | null;
  /** `report.commands` của worker; null khi worker cũ không chạy lệnh kiểm. */
  commands: CheckCommandResult[] | null;
  hasAgentReport: boolean;
}

/** Run code sửa theo góp ý (D6); dùng ở hướng trả lại `agent`. */
export interface QueueFixRunInput {
  reviewId: string;
  workflowId: string | null;
  /** Run code của vòng bị trả lại: run sửa cùng task, nhánh, CLI, chủ. */
  runId: string;
  instructions: string;
}

export interface CodeReviewDeps extends AiGateDeps {
  jobs?: Jobs | undefined;
  /** Địa chỉ web để link trong thông báo. */
  publicUrl?: string | undefined;
  providerFactory?: ProviderFactory | undefined;
  masterKey?: MasterKey | undefined;
  /**
   * Đọc bằng chứng của run code (`runs` cài vào qua main.ts vì `runs` import `codereview`). Không có thì quy tắc cần
   * số liệu hay kết quả lệnh chờ người xem.
   */
  runEvidence?: ((tx: Tx, runId: string) => Promise<RunEvidence | null>) | undefined;
  queueFixRun?: ((tx: Tx, input: QueueFixRunInput) => Promise<{ runId: string }>) | undefined;
}

export interface CodeWorkflowMatch {
  workflow: ReviewWorkflow;
  /** Cũng khớp nhưng bị quy trình được chọn lấn. */
  outranked: { id: string; name: string }[];
}

const auditReview = (
  tx: Tx,
  action: string,
  review: CodeReviewRow,
  data: Record<string, unknown>,
  actorUserId: string | null = null,
) =>
  recordAudit(tx, {
    action,
    actorUserId,
    targetType: "code_review",
    targetId: review.id,
    data: { projectId: review.projectId, prNumber: review.prNumber, headSha: review.headSha, ...data },
  });

// ---- Chọn quy trình và mở phiên ------------------------------------------------------------------------------------

/** Quy trình code đang bật khớp run (FR-012, Edge Cases); null khi không có, khi đó `runs` giữ hành vi cũ (FR-030). */
export async function matchFor(tx: Tx, run: CodeReviewRun): Promise<CodeWorkflowMatch | null> {
  if (!run.pr) return null;
  const project = await loadProject(tx, run.projectId);
  if (!project) return null;
  const saved = await listCodeWorkflows(tx, { teamId: project.teamId, projectId: project.id });
  const candidates = saved.flatMap((w) =>
    w.code
      ? [{ id: w.id, name: w.name, teamId: w.teamId, scope: w.code, updatedAt: new Date(w.updatedAt), workflow: w }]
      : [],
  );
  const { chosen, outranked } = matchCodeWorkflow(candidates, {
    teamId: project.teamId,
    projectKey: project.key,
    baseBranch: run.pr.baseBranch,
    defaultBranch: project.defaultBranch ?? run.pr.baseBranch,
    taskType: run.taskType,
    changedFiles: run.stats?.changedFiles ?? null,
  });
  if (!chosen) return null;
  return { workflow: chosen.workflow, outranked: outranked.map((o) => ({ id: o.workflow.id, name: o.name })) };
}

/**
 * Mở phiên review code cho PR của run, trong transaction kết luận run. `match` truyền vào khi `runs` đã gọi `matchFor`
 * để quyết bỏ kiểm tra `review`, tránh chọn lại. PR đã có phiên mở ở commit khác thì phiên cũ thành `superseded` và
 * vòng mới chạy theo bản chụp của vòng trước (FR-031), không theo quy trình hiện tại.
 */
export async function startCodeReview(
  tx: Tx,
  run: CodeReviewRun,
  deps: CodeReviewDeps,
  match?: CodeWorkflowMatch | null,
): Promise<CodeReviewRow | null> {
  if (!run.pr || !run.headSha) return null;
  const m = match === undefined ? await matchFor(tx, run) : match;
  if (!m?.workflow.code) return null;

  const [open] = await tx
    .select()
    .from(codeReviews)
    .where(
      and(
        eq(codeReviews.projectId, run.projectId),
        eq(codeReviews.prNumber, run.pr.number),
        inArray(codeReviews.status, OPEN),
      ),
    )
    .for("update");
  // verifyCode chạy lại sau lỗi tạm: cùng commit thì giữ phiên đang có.
  if (open?.headSha === run.headSha) return open;
  if (open) {
    await tx
      .update(codeReviews)
      .set({ status: "superseded", updatedAt: sql`now()` })
      .where(eq(codeReviews.id, open.id));
    await auditReview(tx, "codereview.supersede", open, { runId: run.id, newHeadSha: run.headSha });
  }

  const [row] = await tx
    .insert(codeReviews)
    .values({
      orgId: sql`hive.ctx_org()`,
      teamId: run.teamId,
      projectId: run.projectId,
      taskId: run.taskId,
      runId: run.id,
      workflowId: open ? open.workflowId : m.workflow.id,
      workflowName: open ? open.workflowName : m.workflow.name,
      phases: open ? open.phases : m.workflow.phases,
      options: open ? open.options : codeOptions.parse(m.workflow.code),
      prNumber: run.pr.number,
      prUrl: run.pr.url,
      branch: run.pr.branch,
      baseBranch: run.pr.baseBranch,
      headSha: run.headSha,
      round: open ? open.round + 1 : 1,
      previousId: open?.id ?? null,
      requesterUserId: open ? (open.requesterUserId ?? run.ownerUserId) : run.ownerUserId,
      agentRevisions: open?.agentRevisions ?? 0,
      addedLines: run.stats?.addedLines ?? 0,
      deletedLines: run.stats?.deletedLines ?? 0,
      changedFiles: run.stats?.changedFiles.length ?? 0,
      runReasons: run.reasons,
    })
    .returning();
  if (!row) throw new Error("Không tạo được phiên review code.");
  await auditReview(tx, "codereview.start", row, {
    runId: run.id,
    workflowId: row.workflowId,
    workflow: row.workflowName,
    round: row.round,
    outranked: m.outranked.map((o) => o.name),
  });
  await scheduleAdvance(tx, row, deps);
  return row;
}

/**
 * Đi tiếp qua job: checkpoint quy tắc cần diff từ nhà cung cấp Git, không gọi mạng trong transaction của người gọi.
 * Không có hàng đợi (test, công cụ) thì chạy ngay, không có diff.
 */
async function scheduleAdvance(tx: Tx, review: CodeReviewRow, deps: CodeReviewDeps): Promise<void> {
  if (deps.jobs)
    await deps.jobs.enqueue(
      CODE_REVIEW_QUEUE,
      {
        kind: "advance",
        orgId: review.orgId,
        reviewId: review.id,
        gateIndex: review.gateIndex,
      } satisfies CodeReviewJob,
      { tx },
    );
  else await advanceReview(tx, review.id, deps, { files: null, gateIndex: review.gateIndex });
}

// ---- Máy trạng thái ------------------------------------------------------------------------------------------------

async function lockReview(tx: Tx, id: string): Promise<CodeReviewRow | null> {
  const [row] = await tx.select().from(codeReviews).where(eq(codeReviews.id, id)).for("update");
  return row ?? null;
}

/** Lượt mới nhất của checkpoint hiện tại ở commit hiện tại. */
export async function currentGateRun(tx: Tx, review: CodeReviewRow): Promise<CodeReviewGateRunRow | null> {
  const [run] = await tx
    .select()
    .from(codeReviewGateRuns)
    .where(
      and(
        eq(codeReviewGateRuns.reviewId, review.id),
        eq(codeReviewGateRuns.gateIndex, review.gateIndex),
        eq(codeReviewGateRuns.headSha, review.headSha),
      ),
    )
    .orderBy(desc(codeReviewGateRuns.startedAt))
    .limit(1);
  return run ?? null;
}

async function evidenceFor(
  tx: Tx,
  review: CodeReviewRow,
  deps: CodeReviewDeps,
  files: PullRequestFile[] | null,
): Promise<RuleContext> {
  const run = (await deps.runEvidence?.(tx, review.runId)) ?? null;
  // Số liệu và lệnh kiểm gắn với commit run đẩy; vòng do push tay thì lệnh không có kết quả và chờ người (FR-017).
  const same = run !== null && run.headSha === review.headSha;
  const fromFiles: DiffStats | null = files && {
    addedLines: files.reduce((n, f) => n + f.additions, 0),
    deletedLines: files.reduce((n, f) => n + f.deletions, 0),
    changedFiles: files.map((f) => f.path),
  };
  return {
    taskType: run?.taskType ?? null,
    stats: (same ? run.stats : null) ?? fromFiles,
    patches: files?.map((f) => ({ path: f.path, patch: f.patch ?? null })) ?? null,
    hasAgentReport: run?.hasAgentReport ?? false,
    commands: same ? run.commands : null,
  };
}

async function recordGate(
  tx: Tx,
  review: CodeReviewRow,
  index: number,
  gate: ReviewGate,
  run: {
    status: "waiting" | "passed" | "failed" | "skipped";
    note?: string | null;
    checklist?: ChecklistItem[];
    dueAt?: Date | null;
  },
): Promise<CodeReviewGateRunRow> {
  const finished = run.status !== "waiting";
  const [row] = await tx
    .insert(codeReviewGateRuns)
    .values({
      orgId: review.orgId,
      reviewId: review.id,
      gateIndex: index,
      gateId: gate.id,
      headSha: review.headSha,
      status: run.status,
      note: run.note ?? null,
      checklist: run.checklist ?? [],
      dueAt: run.dueAt ?? null,
      finishedAt: finished ? sql`now()` : null,
    })
    .returning();
  if (!row) throw new Error("Không ghi được lượt checkpoint.");
  return row;
}

async function moveTo(tx: Tx, review: CodeReviewRow, index: number): Promise<CodeReviewRow> {
  const [row] = await tx
    .update(codeReviews)
    .set({ gateIndex: index, status: "in_review", updatedAt: sql`now()` })
    .where(eq(codeReviews.id, review.id))
    .returning();
  return row ?? review;
}

/**
 * Checkpoint tự động không đạt: phiên về `changes_requested` theo hướng mặc định của checkpoint (FR-023). Tạo run sửa,
 * báo người giao việc hay quay lại checkpoint trước thuộc `routing.ts` (T040).
 */
async function returnReview(tx: Tx, review: CodeReviewRow, index: number, gate: ReviewGate): Promise<CodeReviewRow> {
  const [row] = await tx
    .update(codeReviews)
    .set({ status: "changes_requested", route: gate.onReject, gateIndex: index, updatedAt: sql`now()` })
    .where(eq(codeReviews.id, review.id))
    .returning();
  return row ?? review;
}

/**
 * Chạy checkpoint từ vị trí hiện tại (FR-014): không thoả điều kiện thì bỏ qua kèm lý do, quy tắc chấm ngay, AI tạo
 * run review, CI hỏi nhà cung cấp qua job, người duyệt đặt hạn và báo. Qua hết thì phiên đạt. Khoá hàng phiên để hai job
 * (hoặc job và người quyết thay) không cùng ghi một checkpoint.
 */
export async function advanceReview(
  tx: Tx,
  reviewId: string,
  deps: CodeReviewDeps,
  opts: { files: PullRequestFile[] | null; gateIndex?: number },
): Promise<CodeReviewRow | null> {
  const review = await lockReview(tx, reviewId);
  if (review?.status !== "in_review") return review;
  if (opts.gateIndex !== undefined && opts.gateIndex !== review.gateIndex) return review;
  const flat = flatGates(review.phases);
  if ((await currentGateRun(tx, review))?.status === "waiting") return review;

  const ctx = await evidenceFor(tx, review, deps, opts.files);
  let i = review.gateIndex;
  while (i < flat.length) {
    const gate = flat[i]?.gate as ReviewGate;
    const applies = gateApplies(gate, ctx);
    if (!applies.runs) {
      await recordGate(tx, review, i, gate, { status: "skipped", note: applies.reason });
      await auditReview(tx, "codereview.gate", review, { gateId: gate.id, kind: gate.kind, status: "skipped" });
      i++;
      continue;
    }
    if (gate.kind === "rule") {
      const v = evaluateRules(gate, ctx);
      await recordGate(tx, review, i, gate, { status: v.status, checklist: v.checklist, note: v.note });
      await auditReview(tx, "codereview.gate", review, {
        gateId: gate.id,
        kind: gate.kind,
        status: v.status,
        passed: v.status === "waiting" ? null : v.status === "passed",
      });
      if (v.status === "passed") {
        i++;
        continue;
      }
      if (v.status === "failed") return returnReview(tx, review, i, gate);
      // Thiếu bằng chứng: dừng ở đây chờ người quyết thay (FR-017, FR-022).
      return moveTo(tx, review, i);
    }

    const due = gate.kind === "human" && gate.slaHours ? new Date(Date.now() + gate.slaHours * 3_600_000) : null;
    const gateRun = await recordGate(tx, review, i, gate, { status: "waiting", dueAt: due });
    const row = await moveTo(tx, review, i);
    if (gate.kind === "human") await notifyReviewers(tx, row, gate, gateRun.id, deps);
    else if (gate.kind === "ai") await startAiGate(tx, row, gateRun, gate, deps);
    else if (gate.kind === "ext" && deps.jobs)
      await deps.jobs.enqueue(
        CODE_REVIEW_QUEUE,
        {
          kind: "ci",
          orgId: row.orgId,
          reviewId: row.id,
          gateIndex: i,
          headSha: row.headSha,
          attempt: 0,
        } satisfies CodeReviewJob,
        { tx },
      );
    return row;
  }
  return onApproved(tx, review, deps);
}

export interface AutoGateResult {
  reviewId: string;
  gateIndex: number;
  /** Commit mà kết quả nói tới (CI); phiên đã sang commit khác thì kết quả bị bỏ. */
  headSha?: string | undefined;
  kind: "ai" | "ext";
  status: "passed" | "failed";
  score?: number | null | undefined;
  checklist: ChecklistItem[];
  note: string | null;
  details?: Record<string, unknown>[] | undefined;
}

/**
 * Ghi kết quả checkpoint AI hoặc CI đang chờ rồi đi tiếp hoặc trả lại. Kết quả tới muộn (đã quyết thay, đã có commit
 * mới, phiên đã huỷ) thì bỏ qua và trả null.
 */
export async function completeAutoGate(
  tx: Tx,
  result: AutoGateResult,
  deps: CodeReviewDeps,
): Promise<CodeReviewRow | null> {
  const review = await lockReview(tx, result.reviewId);
  if (review?.status !== "in_review" || review.gateIndex !== result.gateIndex) return null;
  if (result.headSha && result.headSha !== review.headSha) return null;
  const gate = flatGates(review.phases)[review.gateIndex]?.gate;
  const run = await currentGateRun(tx, review);
  if (gate?.kind !== result.kind || run?.status !== "waiting") return null;
  await tx
    .update(codeReviewGateRuns)
    .set({
      status: result.status,
      score: result.score ?? null,
      checklist: result.checklist,
      note: result.note,
      ...(result.details ? { details: result.details } : {}),
      finishedAt: sql`now()`,
    })
    .where(eq(codeReviewGateRuns.id, run.id));
  await auditReview(tx, "codereview.gate", review, {
    gateId: gate.id,
    kind: gate.kind,
    status: result.status,
    passed: result.status === "passed",
    score: result.score ?? null,
  });
  if (result.status === "failed") return returnReview(tx, review, review.gateIndex, gate);
  const next = await moveTo(tx, review, review.gateIndex + 1);
  await scheduleAdvance(tx, next, deps);
  return next;
}

/**
 * Run review kết thúc (`runs.verifyReview` gọi). false khi run không thuộc phiên nào: `runs` xử lý như review chéo cũ.
 */
export async function onReviewRunFinished(tx: Tx, run: FinishedReviewRun, deps: CodeReviewDeps): Promise<boolean> {
  const outcome = await aiRunFinished(tx, run);
  if (!outcome) return false;
  if (outcome.verdict)
    await completeAutoGate(
      tx,
      { reviewId: outcome.reviewId, gateIndex: outcome.gateIndex, kind: "ai", ...outcome.verdict },
      deps,
    );
  return true;
}

/** Huỷ phiên còn mở (PR đóng, task huỷ, dự án lưu trữ); lượt checkpoint đang chờ được đóng kèm lý do. */
export async function cancelCodeReview(
  tx: Tx,
  reviewId: string,
  reason: string,
  actorUserId: string | null = null,
): Promise<CodeReviewRow | null> {
  const review = await lockReview(tx, reviewId);
  if (!review || !OPEN.includes(review.status)) return review;
  await tx
    .update(codeReviewGateRuns)
    .set({ status: "skipped", note: reason, finishedAt: sql`now()` })
    .where(and(eq(codeReviewGateRuns.reviewId, review.id), eq(codeReviewGateRuns.status, "waiting")));
  const [row] = await tx
    .update(codeReviews)
    .set({ status: "cancelled", updatedAt: sql`now()` })
    .where(eq(codeReviews.id, review.id))
    .returning();
  await auditReview(tx, "codereview.cancel", review, { reason, from: review.status }, actorUserId);
  return row ?? review;
}

// ---- Thông báo -----------------------------------------------------------------------------------------------------

export const codeReviewLink = (publicUrl: string | undefined, id: string) =>
  publicUrl ? `${publicUrl.replace(/\/+$/, "")}/knowledge/reviews?tab=code&id=${id}` : null;

/** Người đủ điều kiện ở checkpoint người duyệt, trừ người giao việc khi checkpoint không cho (Q2). */
async function reviewerIds(tx: Tx, review: CodeReviewRow, gate: ReviewGate): Promise<string[]> {
  const r = gate.reviewers;
  if (!r) return [];
  const ids = new Set(await notificationRecipients(tx, r.users));
  for (const role of r.roles) {
    if (role === "org-admin") for (const id of await notificationRecipients(tx)) ids.add(id);
    else
      for (const id of await teamMemberIds(tx, review.teamId, role === "team-admin" ? "admin" : "member")) ids.add(id);
  }
  for (const t of r.teams) for (const id of await teamMemberIds(tx, t, "member")) ids.add(id);
  if (review.requesterUserId && !r.allowRequester) ids.delete(review.requesterUserId);
  return [...ids];
}

async function notifyReviewers(
  tx: Tx,
  review: CodeReviewRow,
  gate: ReviewGate,
  gateRunId: string,
  deps: CodeReviewDeps,
) {
  const ids = await reviewerIds(tx, review, gate);
  if (!ids.length) return;
  await notify(
    tx,
    {
      orgId: review.orgId,
      event: "code_review.awaiting",
      title: `PR chờ duyệt: #${review.prNumber} ${review.branch}`,
      body: `Checkpoint “${gate.name}” của quy trình ${review.workflowName} chờ bạn duyệt PR #${review.prNumber} (${review.branch} → ${review.baseBranch}).`,
      // Theo lượt checkpoint: quay lại checkpoint này sau khi trả lại thì báo lần nữa.
      eventKey: `code_review:${gateRunId}`,
      recipientIds: ids,
      link: codeReviewLink(deps.publicUrl, review.id),
    },
    { jobs: deps.jobs },
  );
}
